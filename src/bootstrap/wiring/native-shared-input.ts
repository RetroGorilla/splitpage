import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeEditStamp } from "../../adapters/collab/native/text-commands.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { domToPos } from "../../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../../features/common/cell-selection.ts";
import { paintedFromRow, renderRow } from "../../features/rows/render.ts";
import { currentDocument, editAllowed } from "./session-owner.ts";
import { writerControls } from "./writer.ts";

interface NativeInputPorts {
  readonly native: ReturnType<typeof openNativeSession>;
  readonly session: Pick<SharedDocumentSession, "admit" | "refuse" | "subscribe">;
  readonly stamp: () => NativeEditStamp;
  readonly report: ReportPort;
}

const NARRATION = '#rows .cell-editable[data-field="audioText"][data-id]';
const EDITABLE = "#rows .cell-editable, #writer-doc, .wr-flow-visual-text, #doc-title, #writer-title";
const EVENTS = ["beforeinput", "input", "compositionstart", "compositionend", "paste", "cut", "drop", "keydown", "click"] as const;
const UNSUPPORTED = "native-input-unavailable";
const STALE = "native-selection-stale";

function caret(input: InputEvent, cell: Element): number | null {
  const selection = cellSelection(cell);
  if (!selection || selection.from !== selection.to) return null;
  const range = input.getTargetRanges?.()[0];
  if (!range) return selection.from;
  if (range.startContainer !== range.endContainer || range.startOffset !== range.endOffset) return null;
  return domToPos(cell, range.startContainer, range.startOffset);
}

function editingKey(key: KeyboardEvent): boolean {
  const mod = key.ctrlKey || key.metaKey;
  return key.key === "Enter" || mod && /^[biuyz]$/i.test(key.key)
    || key.altKey && (key.key === "ArrowUp" || key.key === "ArrowDown");
}

export function mountNativeSharedInput({ native, session, stamp, report }: NativeInputPorts): () => void {
  let placement: { readonly beat: string; readonly offset: number; readonly cell: Element } | null = null;
  const stopPaint = session.subscribe(() => {
    writerControls()?.renderWriter();
    const placed = placement;
    placement = null;
    if (!placed || document.activeElement !== document.body && document.activeElement !== placed.cell
      && !document.activeElement?.matches(NARRATION)) return;
    const fresh = document.querySelector<HTMLElement>(NARRATION + '[data-id="' + cssAttr(placed.beat) + '"]');
    if (!fresh || document.activeElement?.matches(NARRATION) && document.activeElement !== fresh) return;
    fresh.focus({ preventScroll: true });
    setCellSelection(fresh, placed.offset);
  });

  function write(input: InputEvent, cell: Element): void {
    if (input.isComposing || input.inputType !== "insertText" || !input.data || !cell.matches(NARRATION)) {
      session.refuse(UNSUPPORTED);
      return;
    }
    const admission = session.admit();
    if (admission?.kind === "failed") { report(admission.error); session.refuse(UNSUPPORTED); return; }
    if (admission) { session.refuse(admission.reason); return; }
    if (!editAllowed()) { session.refuse(UNSUPPORTED); return; }
    const beat = cell.getAttribute("data-id") ?? "", offset = caret(input, cell);
    const shown = currentDocument()?.rows.find(row => row.id === beat);
    const latest = native.document().rows.find(row => row.id === beat);
    if (offset === null || !shown || !latest || shown.audioText !== latest.audioText || !paintedFromRow(cell, "audioText", shown)) {
      session.refuse(STALE);
      return;
    }
    const anchored = native.commands.anchorText({ beat, cell: "narration" }, offset);
    if (anchored.kind === "refused") { session.refuse(anchored.reason); return; }
    const result = native.commands.typeText(anchored.range, input.data, {}, stamp());
    if (result.kind === "written") placement = { beat, offset: offset + input.data.length, cell };
    if (result.kind === "recovery") session.refuse(result.reason);
  }

  function intercept(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest(EDITABLE);
    if (event.type === "click") {
      if (!target?.closest("#rows .mini-toolbar button[data-cmd], #writer .wr-fmt[data-cmd]")) return;
    } else if (!cell && !(event.type === "drop" && target?.closest("#rows .visual-cell"))) return;
    if (event.type === "keydown" && !editingKey(event as KeyboardEvent)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (event.type === "beforeinput" && cell && event.cancelable) { write(event as InputEvent, cell); return; }
      if (event.type === "input" && cell) {
        if (cell instanceof HTMLInputElement) cell.value = currentDocument()?.title ?? "";
        else if (cell.closest("#rows")) {
          const id = cell.getAttribute("data-id");
          const row = currentDocument()?.rows.find(candidate => candidate.id === id);
          if (row) {
            const field = cell.getAttribute("data-field");
            if (field === "audioText" || field === "visualText") cell.innerHTML = row[field] ?? "";
            renderRow(id);
          }
        } else writerControls()?.renderWriter();
      }
      session.refuse(UNSUPPORTED);
    } catch (error) {
      report(error);
      session.refuse(UNSUPPORTED);
    }
  }
  for (const type of EVENTS) window.addEventListener(type, intercept, true);
  return () => {
    stopPaint();
    for (const type of EVENTS) window.removeEventListener(type, intercept, true);
  };
}
