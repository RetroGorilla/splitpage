import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeEditStamp, NativeTextRange } from "../../adapters/collab/native/text-commands.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { domToPos, posToDom } from "../../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../../features/common/cell-selection.ts";
import { noteFieldPainted, paintedFromRow, renderRow } from "../../features/rows/render.ts";
import { documentReader } from "./ports/document.ts";
import { editAllowed } from "./session-owner.ts";
import { writerControls } from "./writer.ts";

interface NativeInputPorts {
  readonly native: Pick<ReturnType<typeof openNativeSession>, "commands" | "narrationCaret" | "narrationHtml" | "narrationOffset">;
  readonly session: Pick<SharedDocumentSession, "admit" | "refuse" | "subscribe">;
  readonly editAttribution: () => NativeEditStamp;
  readonly report: ReportPort;
  readonly publish?: (buffered?: { readonly cell: Element; readonly beat: string }) => void;
}

const NARRATION = '#rows .cell-editable[data-field="audioText"][data-id]';
const EDITABLE = "#rows .cell-editable, #writer-doc, .wr-flow-visual-text, #doc-title, #writer-title";
const EVENTS = ["beforeinput", "input", "compositionstart", "compositionend", "paste", "cut", "drop", "keydown", "click", "pointerdown", "focusout"] as const;
const UNSUPPORTED = "native-input-unavailable";
const STALE = "native-selection-stale";
const PENDING = "native-input-pending";
const BATCH_MS = 32;

interface Draft {
  readonly beat: string;
  readonly cell: Element;
  readonly range: NativeTextRange | null;
  readonly selection: CellRange;
  readonly html: string;
  composing: boolean;
  readonly composition: boolean;
  text: string;
}

function insideDraft(draft: Draft, cell: Element, { from, to }: CellRange): boolean {
  return draft.cell === cell && from >= draft.selection.from && to <= draft.selection.from + draft.text.length;
}

function reviseDraft(draft: Draft, selection: CellRange, text: string): void {
  const from = selection.from - draft.selection.from, to = selection.to - draft.selection.from;
  draft.text = draft.text.slice(0, from) + text + draft.text.slice(to);
}

function inputRange(input: InputEvent, cell: Element): CellRange | null {
  const selection = cellSelection(cell);
  if (!selection) return null;
  const range = input.getTargetRanges?.()[0];
  if (!range) return input.inputType.startsWith("delete") && selection.from === selection.to ? null : selection;
  if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) return null;
  const from = domToPos(cell, range.startContainer, range.startOffset), to = domToPos(cell, range.endContainer, range.endOffset);
  if (from === null || to === null) return null;
  if (input.inputType === "insertText" && (from !== selection.from || to !== selection.to)) return null;
  return { from, to };
}

function touchesProtectedText(cell: Element, { from, to }: CellRange): boolean {
  for (const atom of cell.querySelectorAll('[contenteditable="false"]')) {
    const parent = atom.parentNode;
    if (!parent) continue;
    const index = Array.prototype.indexOf.call(parent.childNodes, atom) as number;
    const start = domToPos(cell, parent, index), end = domToPos(cell, parent, index + 1);
    if (start !== null && end !== null && from < end && to > start) return true;
  }
  return false;
}

function preview(cell: Element, { from, to }: CellRange, text: string): void {
  const start = posToDom(cell, from), end = posToDom(cell, to), range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  if (start.node === end.node && start.node instanceof Text) {
    start.node.replaceData(start.offset, end.offset - start.offset, text);
    range.setStart(start.node, start.offset + text.length);
  } else {
    range.deleteContents();
    if (text) {
      const inserted = document.createTextNode(text);
      range.insertNode(inserted);
      range.setStartAfter(inserted);
    }
  }
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function editingKey(key: KeyboardEvent): boolean {
  const mod = key.ctrlKey || key.metaKey;
  return key.key === "Enter" || mod && /^[biuyz]$/i.test(key.key)
    || key.altKey && (key.key === "ArrowUp" || key.key === "ArrowDown");
}

export function mountNativeSharedInput({ native, session, editAttribution, report, publish = () => {} }: NativeInputPorts) {
  let draft: Draft | null = null, stopped: string | null = null, uncertain = false;
  let composingInside: Pick<Draft, "cell" | "selection" | "html"> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let placement: Draft | null = null;
  const stopPaint = session.subscribe(() => {
    writerControls()?.renderWriter();
    const placed = placement;
    placement = null;
    if (!placed || document.activeElement !== document.body && document.activeElement !== placed.cell
      && !document.activeElement?.matches(NARRATION)) return;
    const fresh = document.querySelector<HTMLElement>(NARRATION + '[data-id="' + cssAttr(placed.beat) + '"]');
    if (!fresh || document.activeElement?.matches(NARRATION) && document.activeElement !== fresh) return;
    const offset = placed.range && native.narrationOffset(placed.beat, placed.range);
    if (offset === null) return;
    fresh.focus({ preventScroll: true });
    setCellSelection(fresh, offset);
  });

  function stop(reason: string): string {
    stopped = reason;
    session.refuse(reason);
    return reason;
  }

  function begin(cell: Element, selection: CellRange, composing: boolean, text: string): Draft {
    const beat = cell.getAttribute("data-id") ?? "";
    return { beat, cell, selection, composing, composition: composing, text, range: null, html: cell.innerHTML };
  }

  function anchor(next: Draft): Draft | string {
    const { beat, cell, selection } = next;
    const shown = documentReader.read(doc => doc?.rows.find(row => row.id === beat));
    if (!shown || !paintedFromRow(cell, "audioText", shown) || shown.audioText !== native.narrationHtml(beat)) {
      return STALE;
    }
    const from = native.narrationCaret(beat, selection.from);
    const to = selection.from === selection.to ? from : native.narrationCaret(beat, selection.to);
    if (!from || !to || from.beat !== to.beat) return STALE;
    const anchored = native.commands.anchorText({ beat: from.beat, cell: "narration" }, from.offset, to.offset);
    if (anchored.kind === "refused") return anchored.reason;
    return { ...next, range: anchored.range };
  }

  function admissionRefusal(): string | null {
    const admission = session.admit();
    if (admission?.kind === "failed") { report(admission.error); return UNSUPPORTED; }
    return admission?.reason ?? (editAllowed() ? null : UNSUPPORTED);
  }

  function commit(buffered: Draft, target: NativeInputPorts["native"]) {
    const { range, text, selection, composition } = buffered;
    if (!range) return null;
    const attribution = editAttribution();
    if (!composition && selection.from === selection.to) return target.commands.typeText(range, text, {}, attribution);
    if (!text) return target.commands.deleteText(range, attribution);
    return target.commands.replaceText(range, [{ text, marks: {} }], attribution);
  }

  function finish(): string | null {
    clearTimeout(timer);
    timer = undefined;
    const buffered = draft;
    if (stopped || !buffered) return stopped;
    if (buffered.composing) return PENDING;
    const refusal = admissionRefusal();
    if (refusal) return stop(refusal);
    let result;
    try {
      result = commit(buffered, native);
    } catch (error) {
      uncertain = true;
      report(error);
      return stop(PENDING);
    }
    try {
      if (!result) return stop(STALE);
      if (result.kind === "recovery") return stop(result.reason);
      draft = null;
      if (result.kind === "unchanged") restore(buffered);
      placement = buffered;
      publish(buffered);
    } catch (error) {
      report(error);
    } finally { placement = null; }
    return null;
  }

  function restore(buffered: Pick<Draft, "cell" | "selection" | "html">): void {
    buffered.cell.innerHTML = buffered.html;
    if (document.activeElement === buffered.cell) setCellSelection(buffered.cell, buffered.selection.from, buffered.selection.to);
  }

  function write(input: InputEvent, cell: Element): void {
    const deletion = /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/.test(input.inputType);
    const text = input.data ?? "";
    if (input.isComposing || !(deletion || input.inputType === "insertText" && text)) { session.refuse(UNSUPPORTED); return; }
    const refusal = admissionRefusal();
    if (refusal) { session.refuse(refusal); return; }
    const selection = inputRange(input, cell);
    if (!selection) { session.refuse(deletion ? UNSUPPORTED : STALE); return; }
    const buffered = draft;
    if (buffered && insideDraft(buffered, cell, selection)) {
      reviseDraft(buffered, selection, text);
      preview(cell, selection, text);
      if (/\s$/.test(buffered.text)) finish();
      return;
    }
    if (touchesProtectedText(cell, selection)) { session.refuse(UNSUPPORTED); return; }
    const matches = buffered?.cell !== cell || native.narrationHtml(buffered.beat) === documentReader.read(doc => doc?.rows.find(row => row.id === buffered.beat)?.audioText);
    if (finish()) return;
    const fresh = cell.isConnected ? cell : document.querySelector(NARRATION + '[data-id="' + cssAttr(cell.getAttribute("data-id") ?? "") + '"]');
    if (!fresh) { session.refuse(STALE); return; }
    const next = begin(fresh, selection, false, text);
    let anchored: Draft | string = matches ? next : STALE;
    try { if (typeof anchored !== "string") anchored = anchor(next); }
    catch (error) { report(error); anchored = PENDING; }
    draft = typeof anchored === "string" ? next : anchored;
    preview(fresh, selection, text);
    if (typeof anchored === "string") { stop(anchored); return; }
    if (/\s$/.test(text)) finish();
    else timer = setTimeout(finish, BATCH_MS);
  }

  function composition(event: CompositionEvent, cell: Element): void {
    if (event.type === "compositionstart") {
      const refusal = admissionRefusal();
      if (refusal) { session.refuse(refusal); event.preventDefault(); return; }
      const selection = cellSelection(cell);
      if (!selection || touchesProtectedText(cell, selection)) { session.refuse(STALE); event.preventDefault(); return; }
      if (draft?.composing) { event.preventDefault(); return; }
      if (draft && insideDraft(draft, cell, selection)) {
        clearTimeout(timer);
        composingInside = { cell, selection, html: cell.innerHTML };
        draft.composing = true;
        return;
      }
      if (finish() || !cell.isConnected) { session.refuse(STALE); event.preventDefault(); return; }
      const anchored = anchor(begin(cell, selection, true, ""));
      if (typeof anchored === "string") { session.refuse(anchored); event.preventDefault(); return; }
      draft = anchored;
      return;
    }
    const buffered = draft;
    if (!buffered?.composing || buffered.cell !== cell) return;
    const nested = composingInside;
    composingInside = null;
    buffered.composing = false;
    if (nested) {
      restore(nested);
      if (event.data) {
        reviseDraft(buffered, nested.selection, event.data);
        preview(cell, nested.selection, event.data);
      }
      finish();
      return;
    }
    if (!event.data) {
      restore(buffered);
      draft = null;
      publish();
      return;
    }
    buffered.text = event.data;
    restore(buffered);
    preview(cell, buffered.selection, event.data);
    finish();
  }

  function intercept(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest(EDITABLE);
    const narration = cell?.matches(NARRATION) ? cell : null;
    if (event.type === "focusout") {
      const buffered = draft;
      if (buffered && buffered.cell === cell && !buffered.composing) queueMicrotask(() => { if (draft === buffered) finish(); });
      return;
    }
    if (event.type === "pointerdown") {
      if (!draft?.composing && !stopped) finish();
      return;
    }
    if (event.type === "click") {
      if (!target?.closest("#rows .mini-toolbar button[data-cmd], #writer .wr-fmt[data-cmd]")) return;
    } else if (!cell && !(event.type === "drop" && target?.closest("#rows .visual-cell"))) return;
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      if (narration && (draft?.composing || key.isComposing || key.keyCode === 229)) {
        event.stopImmediatePropagation();
        return;
      }
      if (!editingKey(key)) {
        if (key.key.startsWith("Arrow") || key.key === "Home" || key.key === "End" || key.key === "Tab") finish();
        return;
      }
    }
    if (narration && !stopped) {
      if (event.type === "compositionend" || event.type === "compositionstart") {
        event.stopImmediatePropagation();
        try { composition(event as CompositionEvent, narration); }
        catch (error) { report(error); stop(PENDING); }
        return;
      }
      if (draft?.composing && draft.cell === narration && (event.type === "beforeinput" || event.type === "input")) {
        const change = event as InputEvent;
        if (event.type === "beforeinput" && !change.isComposing && !change.inputType.includes("Composition")) {
          event.preventDefault();
          session.refuse(UNSUPPORTED);
        }
        event.stopImmediatePropagation();
        return;
      }
      if (event.type === "input" && draft?.cell === narration) {
        event.stopImmediatePropagation();
        stop(PENDING);
        return;
      }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (narration && stopped) { session.refuse(stopped); return; }
      if (event.type === "beforeinput" && narration && event.cancelable) { write(event as InputEvent, narration); return; }
      if (event.type === "input" && cell) {
        if (cell instanceof HTMLInputElement) cell.value = documentReader.current()?.title ?? "";
        else if (cell.closest("#rows")) {
          const id = cell.getAttribute("data-id");
          const row = documentReader.current()?.rows.find(candidate => candidate.id === id);
          if (row) {
            const field = cell.getAttribute("data-field");
            if (field === "audioText" || field === "visualText") cell.innerHTML = row[field] ?? "";
            renderRow(id);
          }
        } else writerControls()?.restoreWriterPaint();
      }
      session.refuse(UNSUPPORTED);
    } catch (error) {
      report(error);
      session.refuse(UNSUPPORTED);
    }
  }
  for (const type of EVENTS) window.addEventListener(type, intercept, true);
  return {
    finish,
    buffered: () => draft !== null,
    stop: () => { clearTimeout(timer); if (!stopped) stop(PENDING); },
    recover: (reopened: ReturnType<typeof openNativeSession>): Uint8Array | null => {
      if (!draft || draft.composing || uncertain || !draft.range) return null;
      const result = commit(draft, reopened);
      if (!result || result.kind === "recovery") return null;
      const bytes = reopened.encodeState();
      draft = null;
      stopped = null;
      return bytes;
    },
    dispose: () => {
      clearTimeout(timer);
      draft = null;
      stopPaint();
      for (const type of EVENTS) window.removeEventListener(type, intercept, true);
    }
  };
}

export function keepNativeFieldPaint(buffered: { readonly cell: Element; readonly beat: string }, row: Parameters<typeof noteFieldPainted>[2] | undefined): void {
  if (row?.audioText === buffered.cell.innerHTML) noteFieldPainted(buffered.cell, "audioText", row);
}
