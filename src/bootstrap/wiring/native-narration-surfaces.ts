import { beatPos, caretAt, headingPos } from "../../core/flow/flow.ts";
import type { FlowPos } from "../../core/flow/flow.ts";
import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import { editorKeys } from "../../core/text/selection.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { domKeys, domToPos, posToDom } from "../../features/common/cell-dom.ts";
import { paintedFromRow } from "../../features/rows/render.ts";
import { fromHtml } from "../richtext.ts";
import { documentReader } from "./ports/document.ts";
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

function endOf(cell: Element): number {
  return domToPos(cell, cell, cell.childNodes.length) ?? 0;
}

const WRITER_FLOW = "#writer-doc :is(.wr-beat[data-id], .wr-heading[data-scene])";
type SwitchNative = Pick<ReturnType<typeof openNativeSession>, "readBeat" | "commands" | "narrationCaret" | "narrationOffset">;

interface SwitchPoint {
  readonly cell: Element;
  readonly offset: number;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function forward(anchor: SwitchPoint, head: SwitchPoint): boolean {
  return anchor.cell === head.cell ? anchor.offset <= head.offset
    : !!(anchor.cell.compareDocumentPosition(head.cell) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function selectedKeys(selector: string, anchor: SwitchPoint, head: SwitchPoint): string[] {
  if (anchor.cell === head.cell) {
    return domKeys(anchor.cell).slice(Math.min(anchor.offset, head.offset), Math.max(anchor.offset, head.offset));
  }
  const cells = Array.from(document.querySelectorAll(selector));
  const a = cells.indexOf(anchor.cell), h = cells.indexOf(head.cell);
  const [start, end] = a < h ? [anchor, head] : [head, anchor];
  return [domKeys(start.cell).slice(start.offset),
    ...cells.slice(Math.min(a, h) + 1, Math.max(a, h)).map(domKeys),
    domKeys(end.cell).slice(0, end.offset)].flat();
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

function placeWriterEnd(): void {
  const root = document.querySelector<HTMLElement>(WRITER), first = root?.querySelector(".wr-beat[data-id]");
  const beat = first?.getAttribute("data-id");
  if (first && beat) writerControls()?.writerFlowControl()?.place(caretAt(beatPos(beat, endOf(first))));
  else if (root) {
    root.focus({ preventScroll: true });
    document.getSelection()?.collapse(root, root.childNodes.length);
  }
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

export function captureNativeSwitchSelection(native: SwitchNative) {
  const active = document.activeElement;
  const selection = document.getSelection();
  if (!active || !selection?.rangeCount || !selection.anchorNode || !selection.focusNode) return null;
  const writer = active.matches(WRITER);
  const selector = writer ? WRITER_FLOW : [SPLIT, SPLIT_VISUAL, WRITER_VISUAL].find(candidate => active.matches(candidate));
  if (!selector) return null;
  const range = writer && active.contains(selection.anchorNode) && active.contains(selection.focusNode)
    ? writerControls()?.writerFlowControl()?.selection() : null;
  const anchor = range ? writerPoint(range.anchor) : cellPoint(selector, selection.anchorNode, selection.anchorOffset);
  const head = range ? writerPoint(range.head) : cellPoint(selector, selection.focusNode, selection.focusOffset);
  if (!anchor || !head) return null;
  const aKeys = domKeys(anchor.cell), hKeys = anchor.cell === head.cell ? aKeys : domKeys(head.cell);
  if (anchor.offset > aKeys.length || head.offset > hKeys.length) return null;
  const keys = selectedKeys(selector, anchor, head);
  const direction = forward(anchor, head);
  const collapsed = selection.isCollapsed;
  const surface = writer ? writerNarration : selector === SPLIT ? splitNarration : visualTextSurface;
  const focused = active.getAttribute("data-id");
  const ownsFocus = (): boolean => {
    const now = document.activeElement;
    return now === active || now === document.body || (!active.isConnected &&
      (!!now && now === (focused ? surface.cell(focused) : null) || selector === WRITER_VISUAL && !!now?.matches(WRITER)));
  };
  const resolve = (point: SwitchPoint, source: readonly string[], shared: boolean, right: boolean): SwitchPoint | null => {
    const pos = flowPoint(point);
    if (shared && (writer || selector === SPLIT) && pos.kind === "beat") {
      return nativeNarrationPoint(native, pos.rowId, source, pos.offset, right, surface);
    }
    const cell = writer ? writerCell(pos) : surface.cell(point.cell.getAttribute("data-id") ?? "");
    return cell && sameKeys(source, domKeys(cell)) ? { cell, offset: point.offset } : null;
  };
  const fallback = (): void => {
    if (writer || selector === WRITER_VISUAL) { placeWriterEnd(); return; }
    const first = document.querySelector<HTMLElement>(selector);
    if (first) {
      const end = endOf(first);
      surface.place(first, first.dataset.id ?? "", end, end, false);
    } else document.querySelector<HTMLElement>(".add-row-btn")?.focus({ preventScroll: true });
  };
  const restore = (shared: boolean): void => {
    if (!ownsFocus()) return;
    if (selector === WRITER_VISUAL && focused && !surface.cell(focused)) {
      const row = documentReader.current()?.rows.find(row => row.id === focused);
      if (row && sameKeys(aKeys, editorKeys(fromHtml(row.visualText ?? "", MEDIA)))) {
        writerControls()?.writerFlowControl()?.openVisual(focused);
      }
    }
    const from = resolve(anchor, aKeys, shared, !collapsed && direction);
    const to = resolve(head, hKeys, shared, !collapsed && !direction);
    if (!from || !to || direction !== forward(from, to) || !sameKeys(keys, selectedKeys(selector, from, to))) {
      fallback();
      return;
    }
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
  };
  return { ownsFocus, restore };
}
