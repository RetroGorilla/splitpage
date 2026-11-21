import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeEditStamp, NativeTextPlacement, NativeTextRange, NativeUndoPoint, NativeUndoSelection } from "../../adapters/collab/native/text-commands.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { isBlankBeat, swapBeatsCommand } from "../../application/commands/rows.ts";
import { sceneBeforeBeat, scenesInOrder, storedSceneName } from "../../core/document/scenes.ts";
import { beatPos, headingPos } from "../../core/flow/flow.ts";
import { cellLength, projection } from "../../core/text/runs.ts";
import { domToPos, posToDom, readSelection } from "../../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../../features/common/cell-selection.ts";
import { noteFieldPainted, renderRow } from "../../features/rows/render.ts";
import { undoGesture } from "../../features/undo/routes.ts";
import { scriptCellOf } from "../richtext.ts";
import { guardUnload } from "../startup/page-lifetime.ts";
import { narrationAt, narrationSurfaceOf, shownNarrationSurface, writerNarration, writerSelectionCells } from "./native-narration-surfaces.ts";
import { rowDrag } from "./editor-owners.ts";
import type { NarrationSurface } from "./native-narration-surfaces.ts";
import { documentReader } from "./ports/document.ts";
import { editAllowed } from "./session-owner.ts";
import { writerControls } from "./writer.ts";

interface NativeInputPorts {
  readonly native: Pick<ReturnType<typeof openNativeSession>, "commands" | "document" | "endTypingGroup" | "narrationCaret" | "narrationHtml" | "narrationOffset" | "trackNarrationPaint">;
  readonly session: Pick<SharedDocumentSession, "admit" | "refuse" | "run" | "subscribe">;
  readonly editAttribution: () => NativeEditStamp;
  readonly now?: () => number;
  readonly report: ReportPort;
  readonly paintIsCurrent?: () => boolean;
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

interface MoveEndpoint {
  readonly cell: Element;
  readonly offset: number;
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

function splitKey(key: KeyboardEvent): boolean {
  return key.key === "Enter" && !key.ctrlKey && !key.metaKey && !key.shiftKey;
}

function moveDirection(key: KeyboardEvent): -1 | 1 | null {
  if (!key.altKey || key.ctrlKey || key.metaKey) return null;
  return key.key === "ArrowUp" ? -1 : key.key === "ArrowDown" ? 1 : null;
}

export function mountNativeSharedInput({ native, session, editAttribution, now = Date.now, report, paintIsCurrent = () => false, publish = () => {} }: NativeInputPorts) {
  let draft: Draft | null = null, stopped: string | null = null, uncertain = false;
  let composingInside: Pick<Draft, "cell" | "selection" | "html"> | null = null;
  let composingText = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let placement: { readonly buffered: Draft; readonly caret: RelativePoint } | null = null;
  let lastWrite: number | null = null;
  const movePaint = new Map<Element, TrackedPaint>();
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

  function clearMovePaint(): void {
    for (const paint of movePaint.values()) paint.dispose();
    movePaint.clear();
  }

  function shownWriterBeat(cell: Element, beat: string): boolean {
    const row = documentReader.read(doc => doc?.rows.find(item => item.id === beat));
    return !!row && writerNarration.painted(cell, row);
  }

  function trackMovePaint(): void {
    const active = document.activeElement;
    const cells = active && writerSelectionCells(active, document.getSelection());
    if (stopped || !cells || cells.anchor === cells.head) { clearMovePaint(); return; }
    for (const [cell, paint] of movePaint) {
      if (cell === cells.anchor || cell === cells.head) continue;
      paint.dispose();
      movePaint.delete(cell);
    }
    // why: identical visible text can contain different native positions after an unpublished edit
    if (!paintIsCurrent()) return;
    for (const cell of [cells.anchor, cells.head]) {
      const beat = cell.getAttribute("data-id");
      if (beat && cell !== draft?.cell && !movePaint.has(cell) && shownWriterBeat(cell, beat)) {
        movePaint.set(cell, native.trackNarrationPaint(beat));
      }
    }
  }

  function narrationCell(beat: string, like: Element): HTMLElement | null {
    return narrationSurfaceOf(like).cell(beat);
  }

  function stop(reason: string, quiet = false): string {
    clearTimeout(timer);
    timer = undefined;
    draft?.paint?.dispose();
    stopped = reason;
    if (!quiet) session.refuse(reason);
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

  function finish(selection?: SelectionCapture, moveCaret = true, quiet = false): string | null {
    clearTimeout(timer);
    timer = undefined;
    const buffered = draft;
    if (stopped || !buffered) return stopped;
    if (buffered.composing) return PENDING;
    const refusal = admissionRefusal();
    if (refusal) return stop(refusal, quiet);
    let result;
    buffered.paint?.dispose();
    const at = now();
    try {
      if (lastWrite !== null && at - lastWrite >= GROUP_PAUSE_MS) native.endTypingGroup();
      result = commit(buffered, native, selection?.indices ?? [null, null], true);
    } catch (error) {
      uncertain = true;
      report(error);
      return stop(PENDING, quiet);
    }
    try {
      if (!result) return stop(STALE, quiet);
      if (result.kind === "recovery") return stop(result.reason, quiet);
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

  function draftEndpoint(buffered: Draft, offset: number, assoc: 0 | -1, coversDraftEdge: boolean) {
    const { from, to } = buffered.selection, end = from + buffered.text.length;
    if (offset >= from && offset <= end && (buffered.text.length || from !== to)) {
      return { point: null, index: offset - from, bound: false };
    }
    const original = offset > end ? offset - end + to : offset;
    const bound = coversDraftEdge && buffered.text.length > 0 && (assoc === 0 ? offset < from : offset > end);
    return { point: buffered.paint?.point(original, assoc) ?? null, index: bound ? (assoc === 0 ? 0 : buffered.text.length) : null, bound };
  }

  function resolveDraftEndpoint(beat: string, endpoint: ReturnType<typeof draftEndpoint>, inserted: RelativePoint | null | undefined, assoc: 0 | -1) {
    const resolve = (point: RelativePoint) => native.narrationOffset(beat, { from: point }, assoc);
    if (!endpoint.bound) {
      const point = endpoint.point ?? inserted;
      return point ? resolve(point) : null;
    }
    const original = endpoint.point && resolve(endpoint.point), edge = inserted && resolve(inserted);
    if (original == null || edge == null) return null;
    return assoc === 0 ? Math.min(original, edge) : Math.max(original, edge);
  }

  function flushForInput(cell: Element, selection: CellRange, keepPreview = true, moveCaret = true): { cell: Element; selection: CellRange; stale?: true } | null {
    const buffered = draft;
    if (!buffered) return { cell, selection };
    const oldHtml = cell.innerHTML;
    if (buffered.cell !== cell) {
      const beat = cell.getAttribute("data-id") ?? "";
      const shown = () => documentReader.read(doc => doc?.rows.find(row => row.id === beat)?.audioText);
      const original = shown();
      if (buffered.composing) settleBlur(buffered);
      if (finish(undefined, moveCaret)) return null;
      const fresh = narrationCell(beat, cell);
      if (!fresh) { session.refuse(STALE); return null; }
      if (original === shown()) return { cell: fresh, selection };
      if (keepPreview) fresh.innerHTML = oldHtml;
      return { cell: fresh, selection, stale: true };
    }
    const start = draftEndpoint(buffered, selection.from, 0, selection.to >= buffered.selection.from);
    const end = draftEndpoint(buffered, selection.to, -1, selection.from <= buffered.selection.from + buffered.text.length);
    const capture: SelectionCapture = { indices: [start.index, end.index] };
    if (finish(capture, moveCaret)) return null;
    const fresh = buffered.surface.cell(buffered.beat);
    if (!fresh) { session.refuse(STALE); return null; }
    const from = resolveDraftEndpoint(buffered.beat, start, capture.inserted?.[0], 0);
    const to = resolveDraftEndpoint(buffered.beat, end, capture.inserted?.[1], -1);
    if (from != null && to != null && from <= to) return { cell: fresh, selection: { from, to } };
    if (keepPreview) fresh.innerHTML = oldHtml;
    return { cell: fresh, selection, stale: true };
  }

  function atBatchBoundary(buffered: Draft): boolean {
    return buffered.units >= BATCH_UNITS || /\s$/.test(buffered.text);
  }

  function caretAnchor(beat: string, offset: number) {
    const target = { beat, cell: "narration" } as const;
    const anchored = native.commands.anchorText(target, offset);
    return anchored.kind === "anchored" ? anchored.range : null;
  }

  function structureCaret(cell: Element) {
    const refusal = admissionRefusal();
    if (refusal) { session.refuse(refusal); return null; }
    const selection = cellSelection(cell);
    if (!selection || selection.from !== selection.to) { session.refuse(UNSUPPORTED); return null; }
    const current = flushForInput(cell, selection, false);
    if (!current) return null;
    const beat = current.cell.getAttribute("data-id") ?? "";
    const row = documentReader.read(doc => doc?.rows.find(item => item.id === beat));
    const surface = narrationSurfaceOf(current.cell);
    if (current.stale || !row || !surface.painted(current.cell, row) || row.audioText !== native.narrationHtml(beat)) {
      session.refuse(STALE);
      return null;
    }
    const offset = current.selection.from;
    const point = native.narrationCaret(beat, offset);
    const before = point && caretAnchor(point.beat, point.offset);
    if (!point || !before) { session.refuse(STALE); return null; }
    return { beat, offset, before, surface };
  }

  function split(cell: Element): void {
    if (draft?.composing) { session.refuse(PENDING); return; }
    const caret = structureCaret(cell);
    if (!caret) return;
    const step = native.commands.splitRow.withSelection(caret.before, caret.before);
    if (step.result.kind === "refused") { session.refuse(step.result.reason); return; }
    const beat = step.result.created;
    step.recordAfter(caretAnchor(beat, 0));
    publish();
    const fresh = caret.surface.cell(beat);
    if (fresh) caret.surface.place(fresh, beat, 0, 0, true);
  }

  function joinDirection(event: Event, cell: Element): -1 | 1 | null {
    const key = event.type === "keydown" ? event as KeyboardEvent : null;
    const input = event.type === "beforeinput" ? event as InputEvent : null;
    if (key && (key.ctrlKey || key.metaKey || key.altKey || key.shiftKey)) return null;
    if (input && (!input.cancelable || input.isComposing)) return null;
    const intent = key?.key ?? input?.inputType;
    const direction = intent === "Backspace" || intent === "deleteContentBackward" ? -1
      : intent === "Delete" || intent === "deleteContentForward" ? 1 : null;
    if (!direction) return null;
    const selected = cellSelection(cell);
    if (!selected || selected.from !== selected.to) return null;
    const boundary = direction === -1 ? 0 : cellLength(scriptCellOf(cell.innerHTML));
    return selected.from === boundary ? direction : null;
  }

  function join(cell: Element, direction: -1 | 1): void {
    const caret = structureCaret(cell);
    if (!caret) return;
    const doc = native.document();
    const at = doc.rows.findIndex(row => row.id === caret.beat);
    const lower = doc.rows[at + (direction === 1 ? 1 : 0)];
    const upper = doc.rows[at + (direction === -1 ? -1 : 0)];
    if (!upper || !lower || sceneBeforeBeat(doc, lower.id)) { session.refuse(UNSUPPORTED); return; }
    const a = scriptCellOf(upper.audioText), b = scriptCellOf(lower.audioText);
    const length = cellLength(a);
    if (caret.offset !== (direction === -1 ? 0 : length)) { session.refuse(STALE); return; }
    const blank = [direction === -1 ? lower : upper, direction === -1 ? upper : lower]
      .find(row => isBlankBeat(doc, row, { cellOf: scriptCellOf }));
    if (blank) {
      const next = blank === upper ? lower : upper, offset = blank === lower ? length : 0;
      const step = native.commands.removeRows.withSelection(caret.before, [blank.id]);
      if (step.result.kind === "refused") { session.refuse(step.result.reason); return; }
      if (step.result.kind === "unchanged") return;
      const point = native.narrationCaret(next.id, offset);
      step.recordAfter(point && caretAnchor(point.beat, point.offset));
      publish();
      const fresh = caret.surface.cell(next.id);
      if (fresh) caret.surface.place(fresh, next.id, offset, offset, true);
      return;
    }
    const point = native.narrationCaret(upper.id, length);
    if (!point) { session.refuse(STALE); return; }
    const glue = length && cellLength(b) && !/\s$/.test(projection(a)) ? " " : "";
    const seam = length + glue.length;
    const step = native.commands.joinRow.withSelection(caret.before, lower.id, point.beat, glue);
    if (step.result.kind === "refused") { session.refuse(step.result.reason); return; }
    if (step.result.kind === "unchanged") return;
    const after = cellLength(b) ? caretAnchor(lower.id, 0) : caretAnchor(point.beat, point.offset);
    step.recordAfter(after);
    publish();
    const fresh = caret.surface.cell(upper.id);
    if (fresh) caret.surface.place(fresh, upper.id, seam, seam, true);
  }

  function headingAt(cell: Element | null): Element | null {
    if (cell?.id !== "writer-doc") return null;
    const node = document.getSelection()?.focusNode;
    const heading = (node instanceof Element ? node : node?.parentElement)?.closest(".wr-heading");
    return heading && cell.contains(heading) ? heading : null;
  }

  function headingInput(event: Event, heading: Element, remove: boolean): void {
    const refusal = admissionRefusal();
    if (refusal) { session.refuse(refusal); return; }
    if (beforePress()) return;
    const id = heading.getAttribute("data-scene") ?? "";
    const doc = native.document(), scene = scenesInOrder(doc)?.find(item => item.id === id), previousName = storedSceneName(doc, id);
    const selection = cellSelection(heading);
    if (!scene || !selection || !heading.isConnected || previousName === null || heading.textContent !== previousName) {
      session.refuse(STALE);
      return;
    }
    const target = { beat: id, cell: "name" } as const;
    const before = native.commands.anchorText(target, selection.from, selection.to);
    if (before.kind === "refused") { session.refuse(before.reason); return; }
    if (remove) {
      const index = doc.rows.findIndex(row => row.id === scene.firstSceneId);
      const previous = doc.rows[index - 1];
      const beat = previous?.id ?? scene.firstSceneId, offset = previous ? cellLength(scriptCellOf(previous.audioText)) : 0;
      const point = native.narrationCaret(beat, offset);
      const step = native.commands.removeHeading.withSelection(before.range, id);
      if (step.result.kind === "refused") { session.refuse(step.result.reason); return; }
      if (step.result.kind === "unchanged") return;
      step.recordAfter(point && caretAnchor(point.beat, point.offset));
      publish();
      const fresh = shownNarrationSurface().cell(beat);
      if (fresh) shownNarrationSurface().place(fresh, beat, offset, offset, true);
      return;
    }
    const input = event as InputEvent;
    const range = inputRange(input, heading);
    const text = input.inputType === "insertText" ? input.data : /^delete(?:Content|Word)(?:Backward|Forward)$/.test(input.inputType) ? "" : null;
    if (!range || text === null || input.isComposing || /[\r\n]/.test(text)) { session.refuse(UNSUPPORTED); return; }
    const name = previousName.slice(0, range.from) + text + previousName.slice(range.to);
    if (!name.trim() || [...name].length > 200) { session.refuse(UNSUPPORTED); return; }
    const edit = native.commands.anchorText(target, range.from, range.to);
    if (edit.kind === "refused") { session.refuse(edit.reason); return; }
    const step = native.commands.renameHeading.withSelection(before.range, edit.range, text);
    if (step.result.kind === "refused") { session.refuse(step.result.reason); return; }
    if (step.result.kind === "unchanged") return;
    const offset = range.from + text.length, after = native.commands.anchorText(target, offset);
    if (after.kind === "anchored") step.recordAfter(after.range);
    publish();
    const at = headingPos(id, offset);
    writerControls()?.writerFlowControl()?.place({ anchor: at, head: at });
  }

  function write(input: InputEvent, cell: Element): void {
    const deletion = /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/.test(input.inputType);
    const text = input.data ?? "";
    if (input.isComposing || !(deletion || input.inputType === "insertText" && text)) { session.refuse(UNSUPPORTED); return; }
    const refusal = admissionRefusal();
    if (refusal) { session.refuse(refusal); return; }
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
    catch (error) { report(error); anchored = PENDING; }
    draft = typeof anchored === "string" ? next : anchored;
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
    if (event.type === "drop" && target?.closest("#rows .row") && rowDrag().dragging()) return;
    const cell = target?.closest(EDITABLE);
    const narration = target && cell ? narrationAt(target, cell) : null;
    const heading = headingAt(cell ?? null);
    const removeHeading = heading && joinDirection(event, heading) === -1;
    const joining = narration && joinDirection(event, narration);
    const key = event.type === "keydown" ? event as KeyboardEvent : null;
    const moving = key && moveDirection(key);
    const splitting = key ? splitKey(key) : event.type === "beforeinput" && event.cancelable && (event as InputEvent).inputType === "insertParagraph";
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
    if (key) {
      if (key.key === "Enter" && key.altKey && cell?.id === "writer-doc") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const imeKey = key.isComposing || key.keyCode === 229, undoing = undoGesture(key);
      if ((narration || heading || cell?.id === "writer-doc") && (draft?.composing || imeKey)) {
        event.stopImmediatePropagation();
        if (undoing || draft?.composing && (splitting || joining || removeHeading || moving)) {
          event.preventDefault();
          if (!stopped && (undoing || !imeKey)) session.refuse(PENDING);
        }
        return;
      }
      if (undoing && cell?.matches(UNDO_SURFACES)) return;
      if (!editingKey(key) && !joining && !removeHeading) {
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
      if (stopped && (narration || heading || cell?.id === "writer-doc") && (splitting || joining || moving || removeHeading)) return;
      if (narration && stopped) { session.refuse(stopped); return; }
      if (moving) {
        const source = narration ?? (target && writerSelectionCells(target, document.getSelection())?.head);
        const id = source?.getAttribute("data-id");
        if (id) {
          const outcome = session.run(swapBeatsCommand(id, moving));
          if (outcome.kind === "failed") report(outcome.error);
          return;
        }
      }
      if (narration && joining) { join(narration, joining); return; }
      if (heading && (removeHeading || event.type === "beforeinput" && event.cancelable)) {
        headingInput(event, heading, !!removeHeading);
        return;
      }
      if (narration && splitting) {
        split(narration);
        return;
      }
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
    if (selection.head.target.cell === "name") {
      const head = headingPos(selection.head.target.beat, selection.head.offset);
      const anchor = selection.anchor.target.cell === "name" ? headingPos(selection.anchor.target.beat, selection.anchor.offset) : head;
      writerControls()?.writerFlowControl()?.place({ anchor, head }, true);
      return;
    }
    const head = rowPoint(selection.head), anchor = selection.anchor === selection.head ? head : rowPoint(selection.anchor);
    if (!head) return;
    const surface = shownNarrationSurface(), cell = surface.cell(head.row);
    if (surface === writerNarration && anchor && anchor.row !== head.row) {
      writerControls()?.writerFlowControl()?.place({ anchor: beatPos(anchor.row, anchor.offset), head: beatPos(head.row, head.offset) }, true);
      return;
    }
    if (cell) surface.place(cell, head.row, anchor?.row === head.row ? anchor.offset : head.offset, head.offset, true);
  }

  function beforePress(): string | null {
    if (stopped || !draft?.composing) return finish(undefined, true, true);
    session.refuse(PENDING);
    return PENDING;
  }

  function currentCaret() {
    const active = document.activeElement;
    const cell = active && shownNarrationSurface().cellAt(active);
    if (!cell) return null;
    const selection = cellSelection(cell);
    const row = cell.getAttribute("data-id");
    if (!row || !selection || selection.from !== selection.to) return null;
    const point = native.narrationCaret(row, selection.from);
    return point && { row, range: caretAnchor(point.beat, point.offset) };
  }

  function captureMoveSelection() {
    const active = document.activeElement;
    if (!active) return null;
    const live = document.getSelection(), cells = writerSelectionCells(active, live);
    if (cells && cells.anchor !== cells.head && live?.anchorNode && live.focusNode) {
      const anchor = domToPos(cells.anchor, live.anchorNode, live.anchorOffset);
      const head = domToPos(cells.head, live.focusNode, live.focusOffset);
      if (anchor === null || head === null) return null;
      const backward = !!(cells.head.compareDocumentPosition(cells.anchor) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { kind: "across", anchor: { cell: cells.anchor, offset: anchor }, head: { cell: cells.head, offset: head }, backward } as const;
    }
    const cell = shownNarrationSurface().cellAt(active);
    const selection = cell && readSelection(cell, live);
    return cell && selection ? { kind: "within", cell, selection } as const : null;
  }

  function moveSelection(a: ReturnType<typeof native.narrationCaret>, b: ReturnType<typeof native.narrationCaret>, backward: boolean) {
    if (!a || !b) return null;
    const left = caretAnchor(a.beat, a.offset), right = b === a ? left : caretAnchor(b.beat, b.offset);
    if (!left || !right) return null;
    const point = ({ beat, offset }: NonNullable<typeof a>): NativeUndoPoint => ({ target: { beat, cell: "narration" }, offset });
    const start = point(a), end = a === b ? start : point(b);
    return { kind: "ready", range: { anchor: backward ? right : left, head: backward ? left : right },
      selection: { anchor: backward ? end : start, head: backward ? start : end } } as const;
  }

  function acrossMoveSelection({ anchor, head, backward }: Extract<NonNullable<ReturnType<typeof captureMoveSelection>>, { kind: "across" }>) {
    const buffered = draft;
    trackMovePaint();
    function capture({ cell, offset }: MoveEndpoint, assoc: 0 | -1) {
      const beat = cell.getAttribute("data-id") ?? "";
      if (buffered?.cell === cell) return { beat, offset, preview: draftEndpoint(buffered, offset, assoc, true) };
      if (!shownWriterBeat(cell, beat)) return null;
      const point = movePaint.get(cell)?.point(offset, assoc);
      return point && native.narrationOffset(beat, { from: point }, assoc) !== null ? { beat, point } : null;
    }
    const start = capture(backward ? head : anchor, 0), end = capture(backward ? anchor : head, -1);
    if (!start || !end) return null;
    const selection: SelectionCapture = { indices: [start.preview?.index ?? null, end.preview?.index ?? null] };
    const reason = finish(selection, false);
    if (reason) return { kind: "refused", reason } as const;
    if (!buffered) publish();
    function resolve(point: NonNullable<typeof start>, index: 0 | 1, assoc: 0 | -1) {
      const { beat, preview } = point, html = native.narrationHtml(beat);
      const cell = writerNarration.cell(beat), row = documentReader.read(doc => doc?.rows.find(item => item.id === beat));
      if (!cell || !row || !writerNarration.painted(cell, row) || row.audioText !== html) return null;
      const rebased = preview ? resolveDraftEndpoint(beat, preview, selection.inserted?.[index], assoc)
        : point.point ? native.narrationOffset(beat, { from: point.point }, assoc) : null;
      return rebased === null ? null : native.narrationCaret(beat, rebased, assoc === 0);
    }
    return moveSelection(resolve(start, 0, 0), resolve(end, 1, -1), backward);
  }

  function withinMoveSelection(cell: Element, anchor: number, head: number) {
    const backward = anchor > head;
    const rebased = flushForInput(cell, { from: Math.min(anchor, head), to: Math.max(anchor, head) }, false, false);
    if (!rebased) return { kind: "refused", reason: stopped ?? STALE } as const;
    const beat = rebased.cell.getAttribute("data-id") ?? "";
    const row = documentReader.read(doc => doc?.rows.find(item => item.id === beat));
    if (!rebased.stale && row && narrationSurfaceOf(rebased.cell).painted(rebased.cell, row) && row.audioText === native.narrationHtml(beat)) {
      const { from, to } = rebased.selection;
      const a = native.narrationCaret(beat, from, from !== to), b = from === to ? a : native.narrationCaret(beat, to);
      return moveSelection(a, b, backward);
    }
    return null;
  }

  function settleMoveSelection(captured: NonNullable<ReturnType<typeof captureMoveSelection>>) {
    if (stopped || draft?.composing) {
      return { kind: "refused", reason: beforePress() ?? PENDING } as const;
    }
    const settled = captured.kind === "across" ? acrossMoveSelection(captured)
      : withinMoveSelection(captured.cell, captured.selection.anchor, captured.selection.head);
    if (settled) return settled;
    session.refuse(STALE);
    return { kind: "refused", reason: STALE } as const;
  }

  const pageHide = (): void => { finish(); };
  const visibility = (): void => { if (document.visibilityState === "hidden") pageHide(); };
  const stopUnload = guardUnload(window, () => !!finish());
  window.addEventListener("pagehide", pageHide);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("selectionchange", trackMovePaint);
  for (const type of EVENTS) window.addEventListener(type, intercept, true);
  return {
    finish,
    beforePress,
    currentCaret,
    clearMovePaint,
    captureMoveSelection,
    settleMoveSelection,
    show,
    endGroup: (): void => {
      if (draft) draft.endsGroup = true;
      else native.endTypingGroup();
    },
    buffered: () => draft !== null,
    hasWriterPreview: (beat: string) => draft?.surface === writerNarration && draft.beat === beat,
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
      clearMovePaint();
      stopPaint();
      stopUnload();
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("selectionchange", trackMovePaint);
      for (const type of EVENTS) window.removeEventListener(type, intercept, true);
    }
  };
}

export function keepNativeFieldPaint(buffered: { readonly cell: Element; readonly beat: string }, row: Parameters<typeof noteFieldPainted>[2] | undefined): void {
  if (row?.audioText === buffered.cell.innerHTML) noteFieldPainted(buffered.cell, "audioText", row);
}
