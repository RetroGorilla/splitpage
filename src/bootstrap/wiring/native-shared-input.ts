import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeEditStamp, NativeTextPlacement, NativeTextRange, NativeUndoPoint, NativeUndoSelection } from "../../adapters/collab/native/text-commands.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { domToPos, posToDom } from "../../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../../features/common/cell-selection.ts";
import { noteFieldPainted, renderRow } from "../../features/rows/render.ts";
import { undoGesture } from "../../features/undo/routes.ts";
import { guardUnload } from "../startup/page-lifetime.ts";
import { narrationAt, narrationSurfaceOf, shownNarrationSurface } from "./native-narration-surfaces.ts";
import type { NarrationSurface } from "./native-narration-surfaces.ts";
import { documentReader } from "./ports/document.ts";
import { editAllowed } from "./session-owner.ts";
import { writerControls } from "./writer.ts";

interface NativeInputPorts {
  readonly native: Pick<ReturnType<typeof openNativeSession>, "commands" | "endTypingGroup" | "narrationCaret" | "narrationHtml" | "narrationOffset" | "trackNarrationPaint">;
  readonly session: Pick<SharedDocumentSession, "admit" | "refuse" | "subscribe">;
  readonly editAttribution: () => NativeEditStamp;
  readonly now?: () => number;
  readonly report: ReportPort;
  readonly publish?: (buffered?: { readonly cell: Element; readonly beat: string }) => void;
}

const EDITABLE = "#rows .cell-editable, #writer-doc, .wr-flow-visual-text, #doc-title, #writer-title";
const UNDO_SURFACES = "#rows .cell-editable, #writer-doc";
const HISTORY = /^history(Undo|Redo)$/;
const EVENTS = ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste", "cut", "drop", "keydown", "click", "pointerdown", "focusout"] as const;
const UNSUPPORTED = "native-input-unavailable";
const STALE = "native-selection-stale";
const PENDING = "native-input-pending";
const BATCH_MS = 32;
const BATCH_UNITS = 256;
// why: the old shared backend starts a new undo step after a pause of one second between typing records
const GROUP_PAUSE_MS = 1000;

type RelativePoint = NativeTextRange["from"];
type TrackedPaint = ReturnType<NativeInputPorts["native"]["trackNarrationPaint"]>;

interface SelectionCapture {
  readonly indices: NativeTextPlacement;
  inserted?: readonly [RelativePoint | null, RelativePoint | null];
}

interface Draft {
  readonly beat: string;
  readonly cell: Element;
  readonly surface: NarrationSurface;
  readonly range: NativeTextRange | null;
  readonly caretEnd: "from" | "to" | null;
  readonly before: NativeTextRange | null;
  readonly after: NativeTextRange | null;
  endsGroup: boolean;
  readonly selection: CellRange;
  readonly html: string;
  composing: boolean;
  readonly composition: boolean;
  readonly paint: TrackedPaint | null;
  text: string;
  units: number;
  previewCaret: number;
}

function insideDraft(draft: Draft, cell: Element, { from, to }: CellRange): boolean {
  return draft.cell === cell && from >= draft.selection.from && to <= draft.selection.from + draft.text.length;
}

function reviseDraft(draft: Draft, selection: CellRange, text: string): void {
  const from = selection.from - draft.selection.from, to = selection.to - draft.selection.from;
  draft.text = draft.text.slice(0, from) + text + draft.text.slice(to);
  draft.units += Math.max(text.length, to - from);
  draft.previewCaret = selection.from + text.length;
}

function inputRange(input: InputEvent, cell: Element): CellRange | null {
  const selection = cellSelection(cell);
  if (!selection) return null;
  const range = input.getTargetRanges?.()[0];
  if (!range) return input.inputType.startsWith("delete") && selection.from === selection.to ? null : selection;
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

export function mountNativeSharedInput({ native, session, editAttribution, now = Date.now, report, publish = () => {} }: NativeInputPorts) {
  let draft: Draft | null = null, stopped: string | null = null, uncertain = false;
  let composingInside: Pick<Draft, "cell" | "selection" | "html"> | null = null;
  let composingText = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let placement: { readonly buffered: Draft; readonly caret: RelativePoint } | null = null;
  let lastWrite: number | null = null;
  const stopPaint = session.subscribe(() => {
    writerControls()?.renderWriter();
    const placed = placement;
    placement = null;
    if (!placed) return;
    const { beat, cell, surface } = placed.buffered, fresh = surface.cell(beat);
    if (!fresh || !surface.mayRestore(cell, fresh)) return;
    const offset = native.narrationOffset(beat, { from: placed.caret }, -1);
    if (offset === null) return;
    surface.place(fresh, beat, offset, offset, false);
  });

  function narrationCell(beat: string, like: Element): HTMLElement | null {
    return narrationSurfaceOf(like).cell(beat);
  }

  function stop(reason: string): string {
    clearTimeout(timer);
    timer = undefined;
    draft?.paint?.dispose();
    stopped = reason;
    session.refuse(reason);
    return reason;
  }

  function begin(cell: Element, selection: CellRange, composing: boolean, text: string, caretEnd: Draft["caretEnd"] = null): Draft {
    const beat = cell.getAttribute("data-id") ?? "";
    return { beat, cell, surface: narrationSurfaceOf(cell), selection, composing, composition: composing, text,
      units: Math.max(text.length, selection.to - selection.from), previewCaret: selection.from + text.length, range: null, caretEnd,
      before: null, after: null, endsGroup: false, paint: null, html: cell.innerHTML };
  }

  function anchor(next: Draft): Draft | string {
    const { beat, cell, selection } = next;
    const shown = documentReader.read(doc => doc?.rows.find(row => row.id === beat));
    if (!shown || !next.surface.painted(cell, shown) || shown.audioText !== native.narrationHtml(beat)) {
      return STALE;
    }
    const from = native.narrationCaret(beat, selection.from, selection.from !== selection.to);
    const to = selection.from === selection.to ? from : native.narrationCaret(beat, selection.to);
    if (!from || !to || from.beat !== to.beat) return STALE;
    const target = { beat: from.beat, cell: "narration" } as const;
    const anchored = native.commands.anchorText(target, from.offset, to.offset);
    if (anchored.kind === "refused") return anchored.reason;
    const end = next.composition || selection.from !== selection.to ? native.commands.anchorText(target, to.offset) : null;
    const after = end?.kind === "anchored" ? end.range : null, { range } = anchored;
    const before = next.caretEnd === "to" ? after : next.caretEnd === "from" ? { target: range.target, from: range.from, to: range.from } : range;
    return { ...next, range, before, after, paint: native.trackNarrationPaint(beat) };
  }

  function admissionRefusal(): string | null {
    const admission = session.admit();
    if (admission?.kind === "failed") { report(admission.error); return UNSUPPORTED; }
    return admission?.reason ?? (editAllowed() ? null : UNSUPPORTED);
  }

  function commit(buffered: Draft, target: NativeInputPorts["native"], places?: NativeTextPlacement, recorded = false) {
    const { range, text, selection, composition } = buffered;
    if (!range) return null;
    const attribution = editAttribution(), typing = !composition && selection.from === selection.to;
    if (!recorded) {
      if (typing) return target.commands.typeText(range, text, {}, attribution, places);
      if (!text) return target.commands.deleteText(range, attribution, places);
      return target.commands.replaceText(range, [{ text, marks: {} }], attribution, places);
    }
    const { before } = buffered;
    const step = typing ? target.commands.typeText.withSelection(before, range, text, {}, attribution, places)
      : !text ? target.commands.deleteText.withSelection(before, range, attribution, places)
      : target.commands.replaceText.withSelection(before, range, [{ text, marks: {} }], attribution, places);
    if (step.result.kind === "written") step.recordAfter(typing ? undefined : buffered.after);
    return step.result;
  }

  function finish(selection?: SelectionCapture, moveCaret = true): string | null {
    clearTimeout(timer);
    timer = undefined;
    const buffered = draft;
    if (stopped || !buffered) return stopped;
    if (buffered.composing) return PENDING;
    const refusal = admissionRefusal();
    if (refusal) return stop(refusal);
    let result;
    buffered.paint?.dispose();
    const at = now();
    try {
      if (lastWrite !== null && at - lastWrite >= GROUP_PAUSE_MS) native.endTypingGroup();
      result = commit(buffered, native, selection?.indices ?? [null, null], true);
    } catch (error) {
      uncertain = true;
      report(error);
      return stop(PENDING);
    }
    try {
      if (!result) return stop(STALE);
      if (result.kind === "recovery") return stop(result.reason);
      draft = null;
      if (buffered.endsGroup) native.endTypingGroup();
      if (result.kind === "unchanged") restore(buffered);
      if (result.kind === "written") {
        lastWrite = at;
        if (moveCaret && result.caret) placement = { buffered, caret: result.caret };
        if (selection && result.selection) selection.inserted = result.selection;
      }
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

  function acrossDraft(buffered: Draft, selection: CellRange) {
    const { from, to } = buffered.selection, end = from + buffered.text.length;
    const endpoint = (offset: number, assoc: 0 | -1) => {
      if (offset >= from && offset <= end && (buffered.text.length || from !== to)) {
        return { point: null, index: offset - from, bound: false };
      }
      const original = offset > end ? offset - end + to : offset;
      const bound = buffered.text.length > 0 && (assoc === 0
        ? offset < from && selection.to >= from
        : offset > end && selection.from <= end);
      return { point: buffered.paint?.point(original, assoc) ?? null, index: bound ? (assoc === 0 ? 0 : buffered.text.length) : null, bound };
    };
    return [endpoint(selection.from, 0), endpoint(selection.to, -1)] as const;
  }

  function flushForInput(cell: Element, selection: CellRange): { cell: Element; selection: CellRange; stale?: true } | null {
    const buffered = draft;
    if (!buffered) return { cell, selection };
    const oldHtml = cell.innerHTML;
    if (buffered.cell !== cell) {
      const beat = cell.getAttribute("data-id") ?? "";
      const shown = () => documentReader.read(doc => doc?.rows.find(row => row.id === beat)?.audioText);
      const original = shown();
      if (buffered.composing) settleBlur(buffered);
      if (finish()) return null;
      const fresh = narrationCell(beat, cell);
      if (!fresh) { session.refuse(STALE); return null; }
      if (original === shown()) return { cell: fresh, selection };
      fresh.innerHTML = oldHtml;
      return { cell: fresh, selection, stale: true };
    }
    const [start, end] = acrossDraft(buffered, selection);
    const capture: SelectionCapture = { indices: [start.index, end.index] };
    if (finish(capture)) return null;
    const fresh = buffered.surface.cell(buffered.beat);
    if (!fresh) { session.refuse(STALE); return null; }
    const offset = (endpoint: typeof start, inserted: RelativePoint | null | undefined, assoc: 0 | -1) => {
      const resolve = (point: RelativePoint) => native.narrationOffset(buffered.beat, { from: point }, assoc);
      if (!endpoint.bound) {
        const point = endpoint.point ?? inserted;
        return point ? resolve(point) : null;
      }
      const original = endpoint.point && resolve(endpoint.point), edge = inserted && resolve(inserted);
      if (original == null || edge == null) return null;
      return assoc === 0 ? Math.min(original, edge) : Math.max(original, edge);
    };
    const from = offset(start, capture.inserted?.[0], 0), to = offset(end, capture.inserted?.[1], -1);
    if (from != null && to != null && from <= to) return { cell: fresh, selection: { from, to } };
    fresh.innerHTML = oldHtml;
    return { cell: fresh, selection, stale: true };
  }

  function atBatchBoundary(buffered: Draft): boolean {
    return buffered.units >= BATCH_UNITS || /\s$/.test(buffered.text);
  }

  function write(input: InputEvent, cell: Element): void {
    const deletion = /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/.test(input.inputType);
    const text = input.data ?? "";
    if (input.isComposing || !(deletion || input.inputType === "insertText" && text)) { session.refuse(UNSUPPORTED); return; }
    const refusal = admissionRefusal();    if (refusal) { session.refuse(refusal); return; }
    const selection = inputRange(input, cell);
    if (!selection || deletion && selection.from === selection.to) { session.refuse(deletion ? UNSUPPORTED : STALE); return; }
    const buffered = draft;
    if (buffered && insideDraft(buffered, cell, selection)) {
      reviseDraft(buffered, selection, text);
      preview(cell, selection, text);
      if (atBatchBoundary(buffered)) finish();
      return;
    }
    if (touchesProtectedText(cell, selection)) { session.refuse(UNSUPPORTED); return; }
    const shown = deletion ? cellSelection(cell) : null;
    const caretEnd = shown && shown.from === shown.to ? input.inputType.endsWith("Backward") ? "to" : "from" : null;
    const current = flushForInput(cell, selection);
    if (!current) return;
    const next = begin(current.cell, current.selection, false, text, caretEnd);
    let anchored: Draft | string;
    try { anchored = current.stale ? STALE : anchor(next); }
    catch (error) { report(error); anchored = PENDING; }    draft = typeof anchored === "string" ? next : anchored;
    preview(current.cell, current.selection, text);
    if (typeof anchored === "string") { stop(anchored); return; }
    if (atBatchBoundary(anchored)) finish();
    else timer = setTimeout(() => {
      const shown = cellSelection(anchored.cell);
      finish(undefined, shown?.from === anchored.previewCaret && shown.to === anchored.previewCaret || !anchored.cell.isConnected);
    }, BATCH_MS);
  }

  function composition(event: CompositionEvent, cell: Element): void {
    if (event.type === "compositionstart") {
      const refusal = admissionRefusal();
      if (refusal) { session.refuse(refusal); event.preventDefault(); return; }
      const selection = cellSelection(cell);
      if (!selection || touchesProtectedText(cell, selection)) { session.refuse(STALE); event.preventDefault(); return; }
      if (draft?.composing) { event.preventDefault(); return; }
      composingText = "";
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
    if (!draft?.composing || draft.cell !== cell) return;
    if (event.type === "compositionupdate") { composingText = event.data; return; }
    endComposition(draft, event.data);
  }

  function endComposition(buffered: Draft, text: string): void {
    const cell = buffered.cell;
    const nested = composingInside;
    composingInside = null;
    buffered.composing = false;
    if (nested) {
      restore(nested);
      if (text) {
        reviseDraft(buffered, nested.selection, text);
        preview(cell, nested.selection, text);
      }
      finish();
      return;
    }
    if (!text) {
      restore(buffered);
      buffered.paint?.dispose();
      draft = null;
      publish();
      return;
    }
    buffered.text = text;
    restore(buffered);
    preview(cell, buffered.selection, text);
    finish();
  }

  function intercept(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest(EDITABLE);
    const narration = target && cell ? narrationAt(target, cell) : null;
    if (event.type === "focusout") {
      const buffered = draft;
      if (buffered && cell && (buffered.cell === cell || cell.contains(buffered.cell))) {
        queueMicrotask(() => { if (draft === buffered) settleBlur(buffered); });
      }
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
        if (undoGesture(key)) { event.preventDefault(); session.refuse(PENDING); }
        return;
      }
      if (undoGesture(key) && cell?.matches(UNDO_SURFACES)) return;
      if (!editingKey(key)) {
        if (key.key.startsWith("Arrow") || key.key === "Home" || key.key === "End" || key.key === "Tab") finish();
        return;
      }
    }
    if (narration && !stopped) {
      if (event.type.startsWith("composition")) {
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
        if (event.type === "input" && (change.isComposing || change.inputType.includes("Composition"))) {
          if (change.data !== null) composingText = change.data;
          else if (change.inputType === "deleteCompositionText") composingText = "";
        }
        event.stopImmediatePropagation();
        return;
      }
      if (event.type === "input" && draft?.cell === narration) {
        event.stopImmediatePropagation();
        uncertain = true;
        stop(PENDING);
        return;
      }
    }
    if (event.type === "beforeinput" && cell?.matches(UNDO_SURFACES) && HISTORY.test((event as InputEvent).inputType)) return;
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
  function settleBlur(buffered: Draft): void {
    if (stopped) return;
    if (buffered.composing) endComposition(buffered, composingText);
    else finish();
  }

  function rowPoint(point: NativeUndoPoint): { readonly row: string; readonly offset: number } | null {
    if (point.target.cell !== "narration") return null;
    const anchored = native.commands.anchorText(point.target, point.offset);
    if (anchored.kind !== "anchored") return null;
    const rows = documentReader.read(doc => doc?.rows.map(row => row.id) ?? []);
    for (const row of [point.target.beat, ...rows]) {
      const offset = native.narrationOffset(row, { from: anchored.range.from }, 0);
      if (offset !== null) return { row, offset };
    }
    return null;
  }

  function show(selection: NativeUndoSelection): void {
    const head = rowPoint(selection.head), anchor = selection.anchor === selection.head ? head : rowPoint(selection.anchor);
    if (!head) return;
    const surface = shownNarrationSurface(), cell = surface.cell(head.row);
    if (cell) surface.place(cell, head.row, anchor?.row === head.row ? anchor.offset : head.offset, head.offset, true);
  }

  function beforePress(): string | null {
    const reason = draft?.composing ? PENDING : stopped;
    if (!reason) return finish();
    session.refuse(reason);
    return reason;
  }

  const pageHide = (): void => { finish(); };
  const visibility = (): void => { if (document.visibilityState === "hidden") pageHide(); };
  const stopUnload = guardUnload(window, () => !!finish());
  window.addEventListener("pagehide", pageHide);
  document.addEventListener("visibilitychange", visibility);
  for (const type of EVENTS) window.addEventListener(type, intercept, true);
  return {
    finish,
    beforePress,
    show,
    endGroup: (): void => {
      if (draft) draft.endsGroup = true;
      else native.endTypingGroup();
    },
    buffered: () => draft !== null,
    stop: () => { if (!stopped) stop(PENDING); },
    recover: (reopened: ReturnType<typeof openNativeSession>): Uint8Array | null => {
      if (!draft || draft.composing || uncertain || !draft.range) return null;
      const result = commit(draft, reopened);
      if (!result || result.kind === "recovery") return null;
      const bytes = reopened.encodeState();
      draft.paint?.dispose();
      draft = null;
      stopped = null;
      return bytes;
    },
    dispose: () => {
      clearTimeout(timer);
      draft?.paint?.dispose();
      draft = null;
      stopPaint();
      stopUnload();
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibility);
      for (const type of EVENTS) window.removeEventListener(type, intercept, true);
    }
  };
}

export function keepNativeFieldPaint(buffered: { readonly cell: Element; readonly beat: string }, row: Parameters<typeof noteFieldPainted>[2] | undefined): void {
  if (row?.audioText === buffered.cell.innerHTML) noteFieldPainted(buffered.cell, "audioText", row);
}
