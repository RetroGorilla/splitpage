import { beatPos, flowOf, headingPos } from "../../core/flow/flow.ts";
import type { FlowPos, FlowRow } from "../../core/flow/flow.ts";
import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import { editorKeys } from "../../core/text/selection.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { domKeys, domToPos, posToDom } from "../../features/common/cell-dom.ts";
import { paintedFromRow } from "../../features/rows/render.ts";
import { fromHtml } from "../richtext.ts";
import { documentReader } from "./ports/document.ts";
import { waitForNativeCaret } from "./native-switch-caret.ts";
import { writerControls } from "./writer.ts";

type ShownRow = Parameters<typeof paintedFromRow>[2];

export interface NativeTextSurface {
  readonly cellAt: (target: Element) => Element | null;
  readonly cell: (beat: string) => HTMLElement | null;
  readonly painted: (cell: Element, row: ShownRow) => boolean;
  readonly mayRestore: (old: Element, fresh: Element) => boolean;
  readonly place: (cell: HTMLElement, beat: string, anchor: number, head: number, scroll: boolean) => void;
}

const SPLIT = '#rows .cell-editable[data-field="audioText"][data-id]';
const WRITER = "#writer-doc";
const MEDIA = Object.freeze({ media: true });

function select(cell: HTMLElement, anchor: number, head: number): void {
  const from = posToDom(cell, anchor), to = anchor === head ? from : posToDom(cell, head);
  document.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
}

export const splitNarration: NativeTextSurface = Object.freeze({
  cellAt: (target: Element) => target.closest(SPLIT),
  cell: (beat: string) => document.querySelector<HTMLElement>(SPLIT + '[data-id="' + cssAttr(beat) + '"]'),
  painted: (cell: Element, row: ShownRow) => paintedFromRow(cell, "audioText", row),
  mayRestore: (old: Element, fresh: Element) => {
    const active = document.activeElement;
    if (active !== document.body && active !== old && !active?.matches(SPLIT)) return false;
    return !active?.matches(SPLIT) || active === fresh;
  },
  place: (cell: HTMLElement, _beat: string, anchor: number, head: number, scroll: boolean) => {
    cell.focus({ preventScroll: !scroll });
    select(cell, anchor, head);
  }
});

function beatOf(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest(WRITER + " .wr-beat[data-id]") ?? null;
}

export function writerSelectionCells(target: Element, selection: Selection | null) {
  if (!target.closest(WRITER) || !selection?.rangeCount) return null;
  const anchor = beatOf(selection.anchorNode), head = beatOf(selection.focusNode);
  return anchor && head ? { anchor, head } : null;
}

export const writerNarration: NativeTextSurface = Object.freeze({
  cellAt: (target: Element) => {
    const cells = writerSelectionCells(target, document.getSelection());
    return cells && cells.anchor === cells.head ? cells.head : null;
  },
  cell: (beat: string) => document.querySelector<HTMLElement>(WRITER + ' .wr-beat[data-id="' + cssAttr(beat) + '"]'),
  painted: (cell: Element, row: ShownRow) => cell.getAttribute("data-id") === row.id
    && JSON.stringify(domKeys(cell)) === JSON.stringify(editorKeys(fromHtml(row.audioText ?? "", MEDIA))),
  mayRestore: () => document.activeElement === document.body || document.activeElement === document.querySelector(WRITER),
  place: (_cell: HTMLElement, beat: string, anchor: number, head: number, scroll: boolean) => {
    writerControls()?.writerFlowControl()?.place({ anchor: beatPos(beat, anchor), head: beatPos(beat, head) }, scroll);
  }
});

export function narrationAt(target: Element, editable: Element): Element | null {
  if (editable.matches(WRITER)) return writerNarration.cellAt(target);
  return editable.matches(SPLIT) ? editable : null;
}

export function narrationSurfaceOf(cell: Element): NativeTextSurface {
  return cell.closest(WRITER) ? writerNarration : splitNarration;
}

export function shownNarrationSurface(): NativeTextSurface {
  return writerControls()?.writerFlowControl() ? writerNarration : splitNarration;
}

const SPLIT_VISUAL = '#rows .cell-editable[data-field="visualText"]';
const WRITER_VISUAL = '.wr-flow-visual-text[data-field="visualText"]';

export const visualTextSurface: NativeTextSurface = Object.freeze({
  cellAt: (target: Element) => target.closest(SPLIT_VISUAL + ", " + WRITER_VISUAL),
  cell: (beat: string) => document.querySelector<HTMLElement>((writerControls()?.writerFlowControl() ? WRITER_VISUAL : SPLIT_VISUAL)
    + '[data-id="' + cssAttr(beat) + '"]'),
  painted: (cell: Element, row: ShownRow) => cell.closest("#rows") ? paintedFromRow(cell, "visualText", row)
    : cell.getAttribute("data-id") === row.id && JSON.stringify(domKeys(cell)) === JSON.stringify(editorKeys(fromHtml(row.visualText ?? "", MEDIA))),
  mayRestore: (old: Element, fresh: Element) => document.activeElement === document.body || document.activeElement === old || document.activeElement === fresh,
  place: (cell: HTMLElement, _beat: string, anchor: number, head: number, scroll: boolean) => {
    cell.focus({ preventScroll: !scroll });
    select(cell, anchor, head);
  }
});

const WRITER_FLOW = "#writer-doc :is(.wr-beat[data-id], .wr-heading[data-scene])";
type SwitchNative = Pick<ReturnType<typeof openNativeSession>, "readBeat" | "readRow" | "commands" | "narrationCaret" | "narrationOffset">;

interface SwitchPoint {
  readonly cell: Element;
  readonly offset: number;
}

interface SwitchUnit {
  readonly id: string;
  readonly keys: readonly string[];
  readonly otherField?: readonly string[];
  readonly glue?: string;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function forward(anchor: SwitchPoint, head: SwitchPoint): boolean {
  return anchor.cell === head.cell ? anchor.offset <= head.offset
    : !!(anchor.cell.compareDocumentPosition(head.cell) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function unitId(cell: Element): string {
  const scene = cell.getAttribute("data-scene");
  return scene === null ? "beat:" + cell.getAttribute("data-id") : "heading:" + scene;
}

function outlineWindow(anchorId: string, headId: string, narration: boolean, native?: SwitchNative): SwitchUnit[] {
  const doc = documentReader.current();
  if (!doc) return [];
  const outline = flowOf(doc).flatMap<{ id: string; heading: string } | { id: string; row: FlowRow }>(block =>
    block.kind === "heading" ? [{ id: "heading:" + block.scene.id, heading: block.scene.name }]
      : block.beats.map(row => ({ id: "beat:" + row.id, row })));
  const a = outline.findIndex(unit => unit.id === anchorId), h = outline.findIndex(unit => unit.id === headId);
  if (a < 0 || h < 0) return [];
  const units: SwitchUnit[] = [];
  for (const unit of outline.slice(Math.min(a, h), Math.max(a, h) + 1)) {
    if ("heading" in unit) units.push({ id: unit.id, keys: unit.heading.split("") });
    else if (!native) {
      const audio = editorKeys(fromHtml(unit.row.audioText ?? "", MEDIA));
      const visual = editorKeys(fromHtml(unit.row.visualText ?? "", MEDIA));
      units.push({ id: unit.id, keys: narration ? audio : visual, otherField: narration ? visual : audio });
    }
    else {
      const members = native.readRow(unit.row.id)?.members;
      if (!members?.length) return [];
      for (const id of members) {
        const beat = native.readBeat(id);
        if (!beat) return [];
        const audio = editorKeys(beat.narration), visual = editorKeys(beat.visual);
        const glue = id === unit.row.id ? "" : narration ? beat.joined?.glue ?? "" : "\n";
        units.push({ id: "beat:" + id, keys: narration ? audio : visual, otherField: narration ? visual : audio, glue });
      }
    }
  }
  return units;
}

function matchesUnits(source: readonly SwitchUnit[], destination: readonly SwitchUnit[]): boolean {
  const first = destination.findIndex(unit => unit.id === source[0]?.id);
  const last = destination.findIndex(unit => unit.id === source.at(-1)?.id);
  return first >= 0 && last - first + 1 === source.length && source.every((unit, index) => {
    const other = destination[first + index];
    return other?.id === unit.id && sameKeys(unit.keys, other.keys) && sameKeys(unit.otherField ?? [], other.otherField ?? [])
      && (index === 0 || (unit.glue ?? "") === (other.glue ?? ""));
  });
}

function writerCell(point: FlowPos): Element | null {
  return point.kind === "beat" ? writerNarration.cell(point.rowId)
    : document.querySelector(WRITER + ' .wr-heading[data-scene="' + cssAttr(point.sceneId) + '"]');
}

function writerPoint(point: FlowPos): SwitchPoint | null {
  const cell = writerCell(point);
  return cell ? { cell, offset: point.offset } : null;
}

function flowPoint({ cell, offset }: SwitchPoint): FlowPos {
  const heading = cell.getAttribute("data-scene");
  return heading ? headingPos(heading, offset) : beatPos(cell.getAttribute("data-id") ?? "", offset);
}

function cellPoint(selector: string, node: Node | null, offset: number): SwitchPoint | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const cell = element?.closest(selector);
  if (!cell || !node) return null;
  const at = domToPos(cell, node, offset);
  return at === null ? null : { cell, offset: at };
}

function nativeNarrationPoint(native: SwitchNative, id: string, keys: readonly string[], offset: number, right: boolean,
  surface: NativeTextSurface): SwitchPoint | null {
  const beat = native.readBeat(id);
  if (!beat || !sameKeys(keys, editorKeys(beat.narration))) return null;
  const cell = surface.cell(beat.row);
  if (!cell) return null;
  const shown = domKeys(cell);
  if (beat.row === id && sameKeys(keys, shown)) return { cell, offset };
  const start = native.commands.anchorText({ beat: id, cell: "narration" }, 0);
  const at = start.kind === "anchored" ? native.narrationOffset(beat.row, start.range) : null;
  if (at === null || !sameKeys(keys, shown.slice(at, at + keys.length))) return null;
  const resolved = native.narrationCaret(beat.row, at + offset, right);
  return resolved?.beat === id && resolved.offset === offset ? { cell, offset: at + offset } : null;
}

export function captureNativeSwitchSelection(native: SwitchNative, entering: boolean, paintIsCurrent: () => boolean) {
  const active = document.activeElement;
  const selection = document.getSelection();
  if (!active) return null;
  const writer = active.matches(WRITER);
  const selector = writer ? WRITER_FLOW : [SPLIT, SPLIT_VISUAL, WRITER_VISUAL].find(candidate => active.matches(candidate));
  if (!selector) return null;
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode) return null;
  const range = writer && active.contains(selection.anchorNode) && active.contains(selection.focusNode)
    ? writerControls()?.writerFlowControl()?.selection() : null;
  const anchor = range ? writerPoint(range.anchor) : cellPoint(selector, selection.anchorNode, selection.anchorOffset);
  const head = range ? writerPoint(range.head) : cellPoint(selector, selection.focusNode, selection.focusOffset);
  if (!anchor || !head) return null;
  const aKeys = domKeys(anchor.cell), hKeys = domKeys(head.cell);
  if (anchor.offset > aKeys.length || head.offset > hKeys.length) return null;
  const narration = writer || selector === SPLIT;
  const aId = unitId(anchor.cell), hId = unitId(head.cell);
  const source = outlineWindow(aId, hId, narration);
  const confirmed = !entering && paintIsCurrent() ? outlineWindow(aId, hId, narration, native) : [];
  const sourceMatchesPaint = source.length > 0 && sameKeys(source.find(unit => unit.id === aId)?.keys ?? [], aKeys)
    && sameKeys(source.find(unit => unit.id === hId)?.keys ?? [], hKeys)
    && (entering || confirmed.length === source.length && matchesUnits(source, confirmed));
  const direction = forward(anchor, head);
  const collapsed = selection.isCollapsed;
  const surface = writer ? writerNarration : selector === SPLIT ? splitNarration : visualTextSurface;
  const focused = active.getAttribute("data-id");
  const withinEditor = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return target === active || !!target.closest(writer || selector === WRITER_VISUAL ? WRITER + ", " + WRITER_VISUAL
      : SPLIT + ", " + SPLIT_VISUAL);
  };
  let leftEditor = false;
  const focus = (event: Event): void => { if (!withinEditor(event.target)) leftEditor = true; };
  document.addEventListener("focusin", focus, true);
  const dispose = (): void => { document.removeEventListener("focusin", focus, true); };
  const resolve = (point: SwitchPoint, sourceKeys: readonly string[], right: boolean): SwitchPoint | null => {
    const pos = flowPoint(point);
    if (entering && narration && pos.kind === "beat") {
      return nativeNarrationPoint(native, pos.rowId, sourceKeys, pos.offset, right, surface);
    }
    const cell = writer ? writerCell(pos) : surface.cell(point.cell.getAttribute("data-id") ?? "");
    return cell && sameKeys(sourceKeys, domKeys(cell)) ? { cell, offset: point.offset } : null;
  };
  const restore = (): boolean => {
    if (leftEditor || !sourceMatchesPaint || entering && !paintIsCurrent()
      || document.activeElement !== document.body && !withinEditor(document.activeElement)) return false;
    const destinationNative = entering ? native : undefined;
    const focusedVisual = selector === WRITER_VISUAL && focused ? surface.cell(focused) : null;
    if (selector === WRITER_VISUAL && focused && (!focusedVisual || focusedVisual.closest("[hidden], [inert]"))) {
      const row = documentReader.current()?.rows.find(row => row.id === focused);
      if (!row || !sameKeys(aKeys, editorKeys(fromHtml(row.visualText ?? "", MEDIA)))
        || entering && native.readRow(focused)?.members.length !== 1
        || !matchesUnits(source, outlineWindow(aId, hId, narration, destinationNative))) return false;
      writerControls()?.writerFlowControl()?.openVisual(focused);
    }
    const from = resolve(anchor, aKeys, !collapsed && direction), to = resolve(head, hKeys, !collapsed && !direction);
    if (!from || !to || direction !== forward(from, to)
      || from.cell.closest("[hidden], [inert]") || to.cell.closest("[hidden], [inert]")) return false;
    const destination = outlineWindow(unitId(from.cell), unitId(to.cell), narration, destinationNative);
    if (!matchesUnits(source, destination)) return false;
    if (writer) {
      writerControls()?.writerFlowControl()?.place({ anchor: flowPoint(from), head: flowPoint(to) });
    } else if (from.cell === to.cell && to.cell instanceof HTMLElement) {
      surface.place(to.cell, to.cell.dataset.id ?? "", from.offset, to.offset, false);
    } else {
      const a = posToDom(from.cell, from.offset), h = posToDom(to.cell, to.offset);
      const cell = (focused && surface.cell(focused)) || from.cell;
      if (cell instanceof HTMLElement) cell.focus({ preventScroll: true });
      document.getSelection()?.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
    }
    return true;
  };
  return { dispose, restore: () => { if (!restore()) waitForNativeCaret(); } };
}
