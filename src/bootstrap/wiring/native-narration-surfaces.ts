import { beatPos, caretAt } from "../../core/flow/flow.ts";
import type { FlowPos } from "../../core/flow/flow.ts";
import { editorKeys } from "../../core/text/selection.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { domKeys, domToPos, posToDom } from "../../features/common/cell-dom.ts";
import { paintedFromRow } from "../../features/rows/render.ts";
import { fromHtml } from "../richtext.ts";
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

function writerPointExists(point: FlowPos): boolean {
  const cell = point.kind === "beat" ? writerNarration.cell(point.rowId)
    : document.querySelector(WRITER + ' .wr-heading[data-scene="' + cssAttr(point.sceneId) + '"]');
  return !!cell && point.offset <= endOf(cell);
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

function cellPoint(selector: string, node: Node | null, offset: number) {
  const element = node instanceof Element ? node : node?.parentElement;
  const cell = element?.closest(selector), id = cell?.getAttribute("data-id");
  if (!cell || !node || !id) return null;
  const at = domToPos(cell, node, offset);
  return at === null ? null : { id, offset: at };
}

export function captureNativeSwitchSelection(): (() => void) | null {
  const active = document.activeElement;
  const selection = document.getSelection();
  if (active?.matches(WRITER)) {
    const range = writerControls()?.writerFlowControl()?.selection();
    return () => {
      if (range && writerPointExists(range.anchor) && writerPointExists(range.head)) {
        writerControls()?.writerFlowControl()?.place(range);
      } else placeWriterEnd();
    };
  }
  if (!active) return null;
  const selector = [SPLIT, SPLIT_VISUAL, WRITER_VISUAL].find(candidate => active.matches(candidate));
  const focused = active.getAttribute("data-id");
  if (!selector || !focused) return null;
  const anchor = cellPoint(selector, selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
  const head = cellPoint(selector, selection?.focusNode ?? null, selection?.focusOffset ?? 0);
  const surface = selector === SPLIT ? splitNarration : visualTextSurface;
  return () => {
    if (selector === WRITER_VISUAL && head && !surface.cell(head.id)) {
      writerControls()?.writerFlowControl()?.openVisual(head.id);
    }
    const from = anchor && surface.cell(anchor.id), to = head && surface.cell(head.id);
    if (anchor && head && from && to && anchor.offset <= endOf(from) && head.offset <= endOf(to)) {
      if (from === to) surface.place(to, head.id, anchor.offset, head.offset, false);
      else {
        const a = posToDom(from, anchor.offset), h = posToDom(to, head.offset);
        (surface.cell(focused) ?? from).focus({ preventScroll: true });
        document.getSelection()?.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
      }
      return;
    }
    if (selector === WRITER_VISUAL) { placeWriterEnd(); return; }
    const first = document.querySelector<HTMLElement>(selector);
    if (first) {
      const end = endOf(first);
      surface.place(first, first.dataset.id ?? "", end, end, false);
    } else document.querySelector<HTMLElement>(".add-row-btn")?.focus({ preventScroll: true });
  };
}
