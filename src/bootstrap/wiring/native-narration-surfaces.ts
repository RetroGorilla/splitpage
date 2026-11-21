import { beatPos } from "../../core/flow/flow.ts";
import { editorKeys } from "../../core/text/selection.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { domKeys, posToDom } from "../../features/common/cell-dom.ts";
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
