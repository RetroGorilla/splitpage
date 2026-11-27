import { randomIds } from "../../adapters/identity/ids.ts";
import type { NativeNarrationSeams } from "../../adapters/collab/native/reader.ts";
import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeEditStamp, NativeTextPlacement, NativeTextRange, NativeUndoPoint, NativeUndoSelection, NativeUndoSelectionInput } from "../../adapters/collab/native/text-commands.ts";
import type { CellRange } from "../../application/editing/cell-editing.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { addBeatCommand, isBlankBeat, swapBeatsCommand } from "../../application/commands/rows.ts";
import { sceneBeforeBeat, sceneForBeat, scenesInOrder, storedSceneName } from "../../core/document/scenes.ts";
import type { SceneDocument } from "../../core/document/scenes.ts";
import { beatPos, enterAt, HEADING_MARKER, headingPos, startsParagraph } from "../../core/flow/flow.ts";
import type { FlowDoc, FlowPos, FlowRange } from "../../core/flow/flow.ts";
import { cueShortcutRange } from "../../core/text/cues.ts";
import { breakLine, deleteRange, markThroughout, replaceText, sliceCell, typingMarks } from "../../core/text/edits.ts";
import { cellLength, cleanText, projection } from "../../core/text/runs.ts";
import type { Marks, Run } from "../../core/text/runs.ts";
import { tagCategoryId } from "../../core/document/tags.ts";
import { registryCompletion, registryCompletionOf, registryEntryOf } from "../../core/production/records.ts";
import type { NativePlainMark, NativeVisualLabel } from "../../adapters/collab/native/format-commands.ts";
import { domToPos, posToDom, readSelection } from "../../features/common/cell-dom.ts";
import { cellSelection, setCellSelection } from "../../features/common/cell-selection.ts";
import { cueShortcutHint, noteFieldPainted, renderRow } from "../../features/rows/render.ts";
import { existingPlainTagEnd, hidePlainTagHint, plainTagKeywordAtCaret, plainTagPhrase, showPlainTagHint, updatePlainTagHint } from "../../features/tags/plain-tags.ts";
import { showToolbarTagPicker } from "../../features/tags/toolbar-picker.ts";
import { undoGesture } from "../../features/undo/routes.ts";
import { scriptCellOf } from "../richtext.ts";
import { guardUnload } from "../startup/page-lifetime.ts";
import { narrationAt, narrationSurfaceOf, shownNarrationSurface, visualTextSurface, writerNarration, writerSelectionCells } from "./native-narration-surfaces.ts";
import { rowDrag } from "./editor-owners.ts";
import type { NativeTextSurface } from "./native-narration-surfaces.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";
import { NATIVE_REMOVED_TYPING } from "./ports/shared-command-notices.ts";
import { editAllowed, sessionStamps } from "./session-owner.ts";
import { sharedUndoRoute } from "./undo.ts";
import { repaintWriterAfterPublish, writerControls, writerFlowPorts } from "./writer.ts";
import { currentWhoList } from "./who-list.ts";

interface NativeInputPorts {
  readonly native: Pick<ReturnType<typeof openNativeSession>, "commands" | "document" | "endTypingGroup" | "endDeletionGroup" | "narrationCaret" | "narrationHtml" | "narrationOffset" | "trackNarrationPaint" | "titleOffset" | "trackTitlePaint" | "resolveTextSelection" | "captureTextIdentity" | "captureCompositionCaret" | "isClosingOrClosed" | "subscribe" | "revision" | "hasBeatMarker">;
  readonly session: Pick<SharedDocumentSession, "admit" | "refuse" | "run" | "subscribe">;
  readonly editAttribution: () => NativeEditStamp;
  readonly now?: () => number;
  readonly report: ReportPort;
  readonly paintIsCurrent?: () => boolean;
  readonly paintedJoinSeams?: (beat: string) => NativeNarrationSeams | null;
  readonly publish?: (buffered?: Pick<Draft, "cell" | "beat" | "field">) => void;
}

const EDITABLE = "#rows .cell-editable, #writer-doc, .wr-flow-visual-text, #doc-title, #writer-title";
const UNDO_SURFACES = "#rows .cell-editable, #writer-doc, .wr-flow-visual-text";
const ROW_MENU_BUTTON = '#rows [data-action="row-menu"]';
const HISTORY = /^history(Undo|Redo)$/;
const FORMAT_MARKS = new Map<string, NativePlainMark>([
  ["bold", "b"], ["italic", "i"], ["underline", "u"], ["strikeThrough", "s"], ["highlight", "hl"], ["direction", "dir"]
]);
const EVENTS = ["beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "paste", "cut", "drop", "keydown", "click", "pointerdown", "focusin", "focusout"] as const;
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
  removed?: "written" | "discarded";
}

interface MoveEndpoint {
  readonly cell: Element;
  readonly offset: number;
}

interface WriterHeadingTarget extends CellRange {
  readonly beat: string;
}

interface Draft {
  readonly beat: string;
  readonly cell: Element;
  readonly surface: NativeTextSurface;
  readonly field: "audioText" | "visualText" | "title";
  readonly range: NativeTextRange | null;
  readonly deletion: { readonly direction: -1 | 1; readonly at: number } | null;
  readonly before: NativeTextRange | null;
  readonly after: NativeTextRange | null;
  endsGroup: boolean;
  readonly selection: CellRange;
  readonly html: string;
  readonly marks: Marks;
  composing: boolean;
  readonly composition: boolean;
  compositionIdentity?: (() => boolean) | null;
  compositionCaret?: ReturnType<NativeInputPorts["native"]["captureCompositionCaret"]>;
  readonly paint: TrackedPaint | null;
  text: string;
  units: number;
  previewCaret: number;
}

const titleTextSurface: NativeTextSurface = Object.freeze({
  cellAt: (target: Element) => target instanceof HTMLInputElement && (target.id === "doc-title" || target.id === "writer-title") ? target : null,
  cell: () => document.getElementById(writerControls()?.writerFlowControl() ? "writer-title" : "doc-title"),
  painted: () => true,
  mayRestore: (old: Element, fresh: Element) => document.activeElement === document.body || document.activeElement === old || document.activeElement === fresh,
  place: (cell: HTMLElement, _beat: string, anchor: number, head: number) => {
    if (!(cell instanceof HTMLInputElement)) return;
    cell.focus({ preventScroll: true });
    cell.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
  }
});

function titleInputOf(cell: Element | null): HTMLInputElement | null {
  return cell instanceof HTMLInputElement && (cell.id === "doc-title" || cell.id === "writer-title") ? cell : null;
}

function titleSelection(input: HTMLInputElement): CellRange | null {
  return input.selectionStart !== null && input.selectionEnd !== null
    ? { from: input.selectionStart, to: input.selectionEnd } : null;
}

function readCellSelection(cell: Element): CellRange | null {
  return cell instanceof HTMLInputElement ? titleSelection(cell) : cellSelection(cell);
}

function stepCodePoint(value: string, at: number, dir: -1 | 1): number {
  if (dir === -1) {
    if (at <= 0) return 0;
    return at >= 2 && /[\ud800-\udbff]/.test(value.charAt(at - 2)) && /[\udc00-\udfff]/.test(value.charAt(at - 1)) ? at - 2 : at - 1;
  }
  if (at >= value.length) return value.length;
  return at + 1 < value.length && /[\ud800-\udbff]/.test(value.charAt(at)) && /[\udc00-\udfff]/.test(value.charAt(at + 1)) ? at + 2 : at + 1;
}

function stepWord(value: string, at: number, dir: -1 | 1): number {
  let index = at;
  if (dir === -1) {
    while (index > 0 && /\s/.test(value.charAt(index - 1))) index--;
    const word = index > 0 && /\w/.test(value.charAt(index - 1));
    while (index > 0 && !/\s/.test(value.charAt(index - 1)) && /\w/.test(value.charAt(index - 1)) === word) index--;
    return index;
  }
  while (index < value.length && /\s/.test(value.charAt(index))) index++;
  const word = index < value.length && /\w/.test(value.charAt(index));
  while (index < value.length && !/\s/.test(value.charAt(index)) && /\w/.test(value.charAt(index)) === word) index++;
  return index;
}

function titleInputRange(input: InputEvent, el: HTMLInputElement): CellRange | "boundary" | null {
  const selection = titleSelection(el);
  if (!selection) return null;
  if (selection.from !== selection.to || !input.inputType.startsWith("delete")) return selection;
  const { from } = selection, value = el.value;
  if (input.inputType === "deleteContentBackward") return from > 0 ? { from: stepCodePoint(value, from, -1), to: from } : "boundary";
  if (input.inputType === "deleteContentForward") return from < value.length ? { from, to: stepCodePoint(value, from, 1) } : "boundary";
  if (input.inputType === "deleteWordBackward") return from > 0 ? { from: stepWord(value, from, -1), to: from } : "boundary";
  if (input.inputType === "deleteWordForward") return from < value.length ? { from, to: stepWord(value, from, 1) } : "boundary";
  if (input.inputType === "deleteSoftLineBackward" || input.inputType === "deleteHardLineBackward") return from > 0 ? { from: 0, to: from } : "boundary";
  if (input.inputType === "deleteSoftLineForward" || input.inputType === "deleteHardLineForward") return from < value.length ? { from, to: value.length } : "boundary";
  return null;
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
  if (cell instanceof HTMLInputElement) {
    cell.value = cell.value.slice(0, from) + text + cell.value.slice(to);
    const caret = from + text.length;
    cell.setSelectionRange(caret, caret);
    return;
  }
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

function moveDirection(key: KeyboardEvent): -1 | 1 | null {
  if (!key.altKey || key.ctrlKey || key.metaKey) return null;
  return key.key === "ArrowUp" ? -1 : key.key === "ArrowDown" ? 1 : null;
}

function formattingMark(event: Event, button: Element | null, key: KeyboardEvent | null): NativePlainMark | undefined {
  if (button) return FORMAT_MARKS.get(button.getAttribute("data-cmd") ?? "");
  if (key && (key.ctrlKey || key.metaKey) && !key.altKey) {
    const mark = key.key.toLowerCase();
    return mark === "b" || mark === "i" || mark === "u" ? mark : undefined;
  }
  if (event.type !== "beforeinput" || !event.cancelable || (event as InputEvent).isComposing) return undefined;
  const type = (event as InputEvent).inputType;
  return type.startsWith("format") ? FORMAT_MARKS.get(type.charAt(6).toLowerCase() + type.slice(7)) : undefined;
}

function insertPlacement(doc: SceneDocument, id: string, side: "above" | "below") {
  const at = doc.rows.findIndex(row => row.id === id);
  if (at < 0) return null;
  const scene = sceneForBeat(doc, id)?.id ?? null;
  const next = doc.rows[at + (side === "above" ? -1 : 1)]?.id;
  const heading = side === "above" ? sceneBeforeBeat(doc, id) : next ? sceneBeforeBeat(doc, next) : undefined;
  return { scene, neighbour: heading?.id ?? next ?? null, kind: heading ? "heading" : "beat" };
}

export function sameNativeInsertPlacement(shown: SceneDocument | null, live: SceneDocument, beat: string, side: "above" | "below"): boolean {
  const before = shown && insertPlacement(shown, beat, side), after = insertPlacement(live, beat, side);
  return !!before && !!after && before.scene === after.scene && before.neighbour === after.neighbour && before.kind === after.kind;
}

export function mountNativeSharedInput({ native, session, editAttribution, now = Date.now, report, paintIsCurrent = () => false,
  paintedJoinSeams = () => null, publish = () => {} }: NativeInputPorts) {
  let draft: Draft | null = null, stopped: string | null = null, uncertain = false;
  let insertMenuSelection: ReturnType<typeof captureInsertMenuSelection> | null = null;
  let lastWriterEnterRefusal: string | null = null;
  let imeTarget: Element | null = null;
  let compositionRefused = false, fullRefused = false;
  let refusedJoinComposition: (Pick<Draft, "cell" | "selection" | "html"> & { readonly revision: number | null }) | null = null;
  let composingInside: Pick<Draft, "cell" | "selection" | "html"> | null = null;
  let composingText = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let placement: { readonly buffered: Draft; readonly caret: RelativePoint | number } | null = null;
  let lastWrite: number | null = null;
  let stopWriterPaint: (() => void) | null = null;
  let tagPicker: { readonly cell: HTMLElement; readonly close: () => void; readonly reopen: () => void } | null = null;
  let typedTag: {
    readonly keyword: NonNullable<ReturnType<typeof plainTagKeywordAtCaret>>["kw"];
    readonly range: NativeTextRange;
    readonly cell: Element;
    readonly start: number;
    readonly candidates: Parameters<typeof registryCompletion>[0];
    typed: string;
    suggestion: string | null;
    dismissed: string | null;
  } | null = null;
  let emptyWriter: {
    readonly paint: () => void;
    readonly composing: () => boolean;
    readonly hasText: () => boolean;
    readonly commit: (quiet?: boolean) => string | null;
    readonly abandon: () => void;
    readonly dispose: () => void;
  } | null = null;
  const movePaint = new Map<Element, TrackedPaint>();
  let titleTrack: { readonly input: HTMLInputElement; readonly paint: ReturnType<NativeInputPorts["native"]["trackTitlePaint"]> } | null = null;
  function clearTitleTrack(): void {
    titleTrack?.paint.dispose();
    titleTrack = null;
  }
  function syncTitleTrack(input: Element | null = document.activeElement): void {
    if (!(input instanceof HTMLInputElement) || input.id !== "doc-title" && input.id !== "writer-title") {
      clearTitleTrack();
      return;
    }
    if (draft?.cell === input || !paintIsCurrent()) return;
    clearTitleTrack();
    titleTrack = { input, paint: native.trackTitlePaint() };
  }
  const stopSize = native.subscribe(event => {
    if (event.kind === "size" && event.state !== "full") fullRefused = false;
  });
  const stopPaint = session.subscribe(() => {
    if (tagPicker) {
      const picker = tagPicker;
      queueMicrotask(() => { if (tagPicker === picker && !picker.cell.isConnected) picker.reopen(); });
    }
    repaintWriterAfterPublish();
    const title = documentReader.current()?.title ?? "";
    for (const id of ["doc-title", "writer-title"]) {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement) || draft?.cell === input) continue;
      const focused = document.activeElement === input;
      if (input.value !== title) {
        const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection ?? undefined;
        const tracked = focused && titleTrack?.input === input ? titleTrack.paint : null;
        const startPoint = tracked && start !== null ? tracked.point(start, 0) : null;
        const endPoint = tracked && end !== null ? (end === start ? startPoint : tracked.point(end, 0)) : null;
        const nextStart = startPoint ? native.titleOffset({ from: startPoint }, 0) : null;
        const nextEnd = endPoint ? (endPoint === startPoint ? nextStart : native.titleOffset({ from: endPoint }, 0)) : null;
        input.value = title;
        if (focused && !placement && start !== null && end !== null) {
          input.setSelectionRange(nextStart ?? Math.min(start, title.length), nextEnd ?? Math.min(end, title.length), direction);
        }
      }
      if (focused) syncTitleTrack(input);
    }
    emptyWriter?.paint();
    const placed = placement;
    placement = null;
    if (!placed) {
      if (currentWhoList()?.isOpen()) currentWhoList()?.refresh();
      return;
    }
    const { beat, cell, surface, field } = placed.buffered, fresh = surface.cell(beat);
    if (!fresh || !surface.mayRestore(cell, fresh)) return;
    const offset = typeof placed.caret === "number" ? placed.caret
      : field === "title" ? native.titleOffset({ from: placed.caret }, -1)
      : native.narrationOffset(beat, { from: placed.caret }, -1);
    if (offset === null) return;
    surface.place(fresh, beat, offset, offset, false);
  });

  function updateSplitVisualWhoList(beat: string, input?: Pick<InputEvent, "inputType" | "data">): void {
    const who = currentWhoList();
    if (!who) return;
    const live = visualTextSurface.cell(beat);
    if (!live?.closest("#rows")) {
      if (who.isOpen()) who.refresh();
      return;
    }
    if (who.isOpen() && !who.isOpen(live)) who.refresh();
    if (input) who.maybeOpen(input, live);
    else if (who.isOpen(live)) who.refresh();
  }

  function clearMovePaint(): void {
    for (const paint of movePaint.values()) paint.dispose();
    movePaint.clear();
  }

  const headingCandidates = new Set<string>();
  const refusedJoinedHeadings = new Map<string, string>();
  let pendingHeading: string | null = null;
  let draggingHeading = false;

  function shownWriterBeat(cell: Element, beat: string): boolean {
    const row = documentReader.read(doc => doc?.rows.find(item => item.id === beat));
    return !!row && writerNarration.painted(cell, row);
  }

  function trackMovePaint(): void {
    noteHeadingSelection();
    leaveHeadingLine();
    if (draft?.surface !== writerNarration || draft.composing || stopped) { clearMovePaint(); return; }
    const active = document.activeElement;
    const cells = active && writerSelectionCells(active, document.getSelection());
    if (!cells || cells.anchor === cells.head) { clearMovePaint(); return; }
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

  function mountEmptyWriter(root: HTMLElement) {
    const area = root.ownerDocument.createElement("div");
    area.className = "empty-script";
    const input = area.appendChild(root.ownerDocument.createElement("textarea"));
    input.className = "empty-script-input";
    input.rows = 2;
    input.placeholder = "Start writing";
    input.setAttribute("aria-label", "Start writing");
    input.dataset.undoOwner = "document";
    root.before(area);
    let composing = false, beforeComposition = "", committing = false, disposed = false;

    const isEmpty = () => (documentReader.current()?.rows.length ?? 0) === 0;

    function paint(): void {
      if (disposed) return;
      area.hidden = !isEmpty() && !composing && !input.value;
      input.disabled = !editAllowed();
    }

    function commit(quiet = false): string | null {
      if (disposed || committing) return null;
      if (composing) {
        if (!quiet) refuseCommand(PENDING);
        return PENDING;
      }
      if (!input.value) { paint(); return null; }
      const refusal = admissionRefusal();
      if (refusal) {
        if (!quiet) refuseCommand(refusal);
        return refusal;
      }
      const normalized = input.value.replace(/\r\n?/g, "\n");
      if (cleanText(normalized) !== normalized) {
        if (!quiet) refuseCommand(UNSUPPORTED);
        return UNSUPPORTED;
      }
      committing = true;
      try {
        let step = native.commands.createFirstBeat.withSelection(null, normalized, editAttribution());
        if (step.result.kind === "unchanged") {
          const first = native.document().rows.find(row => native.hasBeatMarker(row.id))?.id;
          if (first) step = native.commands.insertAdjacentBeat.withSelection(null, first, "above", editAttribution(), false, normalized);
        }
        if (step.result.kind === "refused") {
          if (!quiet) refuseCommand(step.result.reason);
          return step.result.reason;
        }
        if (step.result.kind !== "written") return null;
        const created = step.result.created;
        const offset = cellLength(scriptCellOf(native.narrationHtml(created) ?? ""));
        step.recordAfter(caretAnchor(created, offset));
        input.value = "";
        paint();
        publish();
        const fresh = writerNarration.cell(created);
        if (fresh) writerNarration.place(fresh, created, offset, offset, true);
        return null;
      } catch (error) {
        report(error);
        if (!quiet) refuseCommand(UNSUPPORTED);
        return UNSUPPORTED;
      } finally {
        committing = false;
      }
    }

    const onKeydown = (event: Event): void => {
      const key = event as KeyboardEvent;
      const undoing = undoGesture(key);
      if (!undoing) return;
      key.preventDefault();
      key.stopImmediatePropagation();
      if (composing || input.value) {
        if (!stopped) refuseCommand(PENDING);
        return;
      }
      sharedUndoRoute()?.replay?.(undoing);
    };

    const onBeforeInput = (event: Event): void => {
      const change = event as InputEvent;
      if (HISTORY.test(change.inputType)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (composing || input.value) {
          if (!stopped) refuseCommand(PENDING);
          return;
        }
        sharedUndoRoute()?.replay?.(change.inputType === "historyUndo" ? "undo" : "redo");
        return;
      }
      if (!editAllowed() || !isEmpty() && !composing && !input.value) {
        event.preventDefault();
        if (!editAllowed()) refuseCommand(UNSUPPORTED);
      }
    };

    const onCompositionStart = (event: Event): void => {
      const refusal = admissionRefusal();
      if (refusal) { refuseCommand(refusal); event.preventDefault(); return; }
      if (finish()) { event.preventDefault(); return; }
      composing = true;
      beforeComposition = input.value;
    };

    const onCompositionEnd = (event: Event): void => {
      if (!composing) return;
      composing = false;
      const data = (event as CompositionEvent).data;
      if (!data) {
        input.value = beforeComposition;
        if (!input.value) {
          publish();
          paint();
          return;
        }
      } else if (input.value === beforeComposition) {
        input.value = beforeComposition + data;
      }
      commit();
    };

    const onInput = (event: Event): void => {
      if (composing || (event as InputEvent).isComposing) return;
      commit();
    };

    const onBlur = (): void => {
      if (!composing && input.value) commit();
    };

    const listeners: readonly (readonly [string, EventListener])[] = [
      ["keydown", onKeydown], ["beforeinput", onBeforeInput],
      ["compositionstart", onCompositionStart], ["compositionend", onCompositionEnd],
      ["input", onInput], ["blur", onBlur]
    ];
    for (const [name, listener] of listeners) input.addEventListener(name, listener);
    paint();

    return {
      paint,
      composing: () => composing,
      hasText: () => input.value.length > 0,
      commit,
      abandon: () => {
        if (!composing) return;
        composing = false;
        input.value = beforeComposition;
        paint();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        composing = false;
        for (const [name, listener] of listeners) input.removeEventListener(name, listener);
        area.remove();
      }
    };
  }

  function bindWriterPaint(root: HTMLElement) {
    stopWriterPaint?.();
    const empty = mountEmptyWriter(root);
    emptyWriter = empty;
    const down = () => { draggingHeading = true; };
    const up = () => {
      draggingHeading = false;
      leaveHeadingLine();
    };
    const stop = () => {
      if (stopWriterPaint !== stop) return;
      stopWriterPaint = null;
      if (emptyWriter === empty) emptyWriter = null;
      empty.dispose();
      root.ownerDocument.removeEventListener("selectionchange", trackMovePaint);
      root.removeEventListener("focusout", clearMovePaint);
      root.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      pendingHeading = null;
      draggingHeading = false;
      headingCandidates.clear();
      refusedJoinedHeadings.clear();
      clearMovePaint();
    };
    stopWriterPaint = stop;
    root.ownerDocument.addEventListener("selectionchange", trackMovePaint);
    root.addEventListener("focusout", clearMovePaint);
    root.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    return {
      headingCandidate: (beat: string) => headingCandidates.has(beat),
      settle: () => !empty.composing() && (!empty.hasText() || !empty.commit()) && (!draft?.cell.closest("#writer") || !finish()),
      finish: () => { if (!empty.commit(true) && !finish(undefined, true, true)) leaveHeadingLine(true); },
      dispose: stop
    };
  }

  function narrationCell(beat: string, like: Element): HTMLElement | null {
    return narrationSurfaceOf(like).cell(beat);
  }

  function visualIsAddressable(beat: string, html: string | null | undefined): boolean {
    if (html == null) return false;
    const end = native.commands.anchorText({ beat, cell: "visual" }, cellLength(scriptCellOf(html)));
    return end.kind === "anchored";
  }

  function refuseCommand(reason: string): void {
    if (reason === "closed" || native.isClosingOrClosed()) return;
    if (reason === PENDING && draft?.composing) {
      if (compositionRefused) return;
      compositionRefused = true;
    }
    if (reason === "full") {
      if (fullRefused) return;
      fullRefused = true;
    }
    session.refuse(reason);
  }

  function stop(reason: string, quiet = false): string {
    clearTimeout(timer);
    timer = undefined;
    draft?.paint?.dispose();
    clearMovePaint();
    stopped = reason;
    if (!quiet) {
      if (reason === "full") refuseCommand(reason);
      else session.refuse(reason);
    }
    return reason;
  }

  function begin(cell: Element, selection: CellRange, composing: boolean, text: string, deletion: Draft["deletion"] = null): Draft {
    if (cell instanceof HTMLInputElement) {
      return { beat: "", cell, surface: titleTextSurface, field: "title", selection, composing, composition: composing, text,
        units: Math.max(text.length, selection.to - selection.from), previewCaret: selection.from + text.length, range: null, deletion,
        before: null, after: null, endsGroup: false, paint: null, html: cell.value, marks: {} };
    }
    const beat = cell.getAttribute("data-id") ?? "";
    const { from, to } = selection;
    const marks = !text && !composing ? {} : typingMarks(scriptCellOf(cell.innerHTML), from === to ? from : from + 1);
    const visual = visualTextSurface.cellAt(cell) === cell;
    return { beat, cell, surface: visual ? visualTextSurface : narrationSurfaceOf(cell), field: visual ? "visualText" : "audioText",
      selection, composing, composition: composing, text,
      units: Math.max(text.length, selection.to - selection.from), previewCaret: selection.from + text.length, range: null, deletion,
      before: null, after: null, endsGroup: false, paint: null, html: cell.innerHTML, marks };
  }

  function anchor(next: Draft): Draft | string {
    const { beat, cell, selection, field } = next;
    if (field === "title") {
      const shownTitle = documentReader.current()?.title ?? "";
      const liveTitle = native.document().title;
      if (!(cell instanceof HTMLInputElement) || cell.value !== shownTitle || shownTitle !== liveTitle) return STALE;
      const target = { beat: "", cell: "title" } as const;
      const anchored = native.commands.anchorText(target, selection.from, selection.to);
      if (anchored.kind === "refused") return anchored.reason;
      const end = next.composition || selection.from !== selection.to ? native.commands.anchorText(target, selection.to) : null;
      const after = end?.kind === "anchored" ? end.range : null, { range } = anchored;
      const before = next.deletion?.direction === -1 ? after
        : next.deletion?.direction === 1 ? { target: range.target, from: range.from, to: range.from } : range;
      return { ...next, range, before, after, paint: native.trackTitlePaint() };
    }
    const shown = documentReader.read(doc => doc?.rows.find(row => row.id === beat));
    const visual = field === "visualText";
    const live = visual ? native.document().rows.find(row => row.id === beat)?.visualText : native.narrationHtml(beat);
    if (!shown || !next.surface.painted(cell, shown) || shown[field] !== live) {
      return STALE;
    }
    if (visual && !visualIsAddressable(beat, live)) return UNSUPPORTED;
    const from = visual ? { beat, offset: selection.from } : native.narrationCaret(beat, selection.from, selection.from !== selection.to);
    const to = selection.from === selection.to ? from : visual ? { beat, offset: selection.to } : native.narrationCaret(beat, selection.to);
    if (!from || !to || from.beat !== to.beat) return STALE;
    const target = { beat: from.beat, cell: visual ? "visual" : "narration" } as const;
    const anchored = native.commands.anchorText(target, from.offset, to.offset,
      !visual && !next.composition && next.text && selection.from === selection.to ? "buffered-typing" : undefined);
    if (anchored.kind === "refused") return anchored.reason;
    const end = next.composition || selection.from !== selection.to ? native.commands.anchorText(target, to.offset) : null;
    const after = end?.kind === "anchored" ? end.range : null, { range } = anchored;
    const before = next.deletion?.direction === -1 ? after
      : next.deletion?.direction === 1 ? { target: range.target, from: range.from, to: range.from } : range;
    return { ...next, range, before, after, paint: visual ? null : native.trackNarrationPaint(beat) };
  }

  function admissionRefusal(): string | null {
    if (native.isClosingOrClosed()) return "closed";
    const admission = session.admit();
    if (admission?.kind === "failed") { report(admission.error); return UNSUPPORTED; }
    return admission?.reason ?? (editAllowed() ? null : UNSUPPORTED);
  }

  function commit(buffered: Draft, target: NativeInputPorts["native"], places?: NativeTextPlacement, recorded = false) {
    const { range, text, selection, composition, marks, field } = buffered;
    if (!range) return null;
    const typing = !composition && selection.from === selection.to;
    if (field === "title") {
      if (!recorded) {
        if (typing) return target.commands.typeTitle(range, text, places);
        if (!text) return target.commands.deleteTitle(range, places);
        return target.commands.replaceTitle(range, text, places);
      }
      const { before, deletion } = buffered;
      const step = typing ? target.commands.typeTitle.withSelection(before, range, text, places)
        : deletion ? target.commands.deleteTitleInRun.withSelection(before, range, deletion.direction, deletion.at, places)
        : !text ? target.commands.deleteTitle.withSelection(before, range, places)
        : target.commands.replaceTitle.withSelection(before, range, text, places);
      if (step.result.kind === "written") step.recordAfter(typing ? undefined : buffered.after);
      return step.result;
    }
    const attribution = editAttribution();
    if (!recorded) {
      if (typing) return target.commands.typeText(range, text, marks, attribution, places);
      if (!text) return target.commands.deleteText(range, attribution, places);
      return target.commands.replaceText(range, [{ text, marks }], attribution, places);
    }
    const { before, deletion } = buffered;
    const step = typing ? target.commands.typeText.withSelection(before, range, text, marks, attribution, places)
      : deletion ? target.commands.deleteTextInRun.withSelection(before, range, deletion.direction, deletion.at, attribution, places)
      : !text ? target.commands.deleteText.withSelection(before, range, attribution, places)
      : target.commands.replaceText.withSelection(before, range, [{ text, marks }], attribution, places);
    if (step.result.kind === "written") step.recordAfter(typing ? undefined : buffered.after);
    return step.result;
  }

  function markTypedCue(beat: string, point: RelativePoint): void {
    const offset = native.narrationOffset(beat, { from: point }, -1), html = native.narrationHtml(beat);
    if (offset === null || html == null) return;
    const live = document.createElement("div");
    live.innerHTML = html;
    const caretPoint = posToDom(live, offset);
    if (!cueShortcutHint(caretPoint.node, caretPoint.offset)) return;
    if (!cueShortcutRange(scriptCellOf(html), offset)) return;
    const at = native.narrationCaret(beat, offset);
    const caret = at && caretAnchor(at.beat, at.offset);
    if (!caret) return;
    // why: the first Undo takes off the cue mark and leaves the typed colon in place
    const step = native.commands.formatCue.withSelection(caret, beat, offset);
    if (step.result.kind === "refused") refuseCommand(step.result.reason);
    if (step.result.kind === "written") step.recordAfter(caret);
  }

  function finish(selection?: SelectionCapture, moveCaret = true, quiet = false, composed = false): string | null {
    clearTimeout(timer);
    timer = undefined;
    const buffered = draft;
    if (stopped) return stopped;
    if (!buffered) {
      if (emptyWriter?.composing()) {
        if (!quiet) refuseCommand(PENDING);
        return PENDING;
      }
      if (emptyWriter?.hasText()) return emptyWriter.commit(quiet);
      return null;
    }
    if (buffered.composing) return PENDING;
    const refusal = admissionRefusal();
    if (refusal) return stop(refusal, quiet);
    let result;
    buffered.paint?.dispose();
    clearMovePaint();
    const at = now();
    let visualCaret: number | null = null;
    try {
      if (buffered.field === "visualText" && buffered.range) {
        const start = native.resolveTextSelection(buffered.range)?.anchor.offset;
        if (start !== undefined) visualCaret = start + buffered.text.length;
      }
      if (!buffered.deletion && lastWrite !== null && at - lastWrite >= GROUP_PAUSE_MS) native.endTypingGroup();
      result = commit(buffered, native, selection?.indices ?? [null, null], true);
    } catch (error) {
      uncertain = true;
      report(error);
      return stop(PENDING, quiet);
    }
    try {
      if (!result) return stop(STALE, quiet);
      if (result.kind === "refused") return stop(result.reason, quiet);
      if (result.kind === "recovery") {
        const { range, selection: { from, to }, text, composition } = buffered;
        if (result.reason !== "missing" || range?.target.cell !== "narration" ||
          composition || composed || !text || from !== to || native.hasBeatMarker(range.target.beat)) {
          return stop(result.reason, quiet);
        }
      }
      if (result.kind === "recovery" || result.kind === "written" && "stray" in result && result.stray) {
        const removed = result.kind === "recovery" ? "discarded" : "written";
        draft = null;
        if (selection) selection.removed = removed;
        native.endTypingGroup();
        restore(buffered);
        publish();
        if (removed === "discarded") session.refuse(NATIVE_REMOVED_TYPING);
        return null;
      }
      draft = null;
      if (buffered.endsGroup) native.endTypingGroup();
      if (result.kind === "unchanged") restore(buffered);
      if (result.kind === "written") {
        lastWrite = at;
        if (buffered.surface === writerNarration) refusedJoinedHeadings.delete(buffered.beat);
        const cuePoint = selection?.indices[2] ? result.selection?.[1] : null;
        if (cuePoint) markTypedCue(buffered.beat, cuePoint);
        const caret = cuePoint ?? result.caret;
        if (moveCaret && caret) placement = { buffered, caret: visualCaret ?? caret };
        if (selection && result.selection) selection.inserted = result.selection;
      }
      publish(buffered);
      if (result.kind === "written" && buffered.surface === writerNarration &&
          (composed || buffered.composition || buffered.selection.from < HEADING_MARKER.length && buffered.text) &&
          writerNarration.cell(buffered.beat)?.textContent?.startsWith(HEADING_MARKER)) {
        const row = documentReader.read(doc => doc && pendingHeadingRow(doc, buffered.beat));
        if (row) {
          headingCandidates.add(buffered.beat);
          pendingHeading = buffered.beat;
          writerNarration.cell(buffered.beat)?.classList.add("is-pending-heading");
        }
      }
    } catch (error) {
      report(error);
    } finally { placement = null; }
    return null;
  }

  function restore(buffered: Pick<Draft, "cell" | "selection" | "html">): void {
    if (buffered.cell instanceof HTMLInputElement) {
      buffered.cell.value = buffered.html;
      if (document.activeElement === buffered.cell) buffered.cell.setSelectionRange(buffered.selection.from, buffered.selection.to);
      return;
    }
    buffered.cell.innerHTML = buffered.html;
    if (document.activeElement === buffered.cell || buffered.cell.closest("#writer-doc") === document.activeElement) {
      setCellSelection(buffered.cell, buffered.selection.from, buffered.selection.to);
    }
  }

  function settleLeave(): string | null {
    if (stopped !== "missing" || !draft?.composition || draft.composing || uncertain || !draft.range || draft.field === "title") return finish();
    const { beat, field, range, selection: { from, to } } = draft;
    const visual = field === "visualText";
    if (range.target.beat !== beat || range.target.cell !== (visual ? "visual" : "narration")) return stopped;
    const original = documentReader.read(doc => doc?.rows.find(row => row.id === beat)?.[field]);
    const live = visual ? native.document().rows.find(row => row.id === beat)?.visualText : native.narrationHtml(beat);
    if (original == null || original !== live ||
      !(from === to ? draft.compositionCaret?.intact() : draft.compositionIdentity?.())) return stopped;
    const resolved = native.resolveTextSelection(range);
    const start = visual ? { beat, offset: from } : native.narrationCaret(beat, from, from !== to);
    const end = from === to ? start : visual ? { beat, offset: to } : native.narrationCaret(beat, to);
    if (!resolved || start?.beat !== beat || end?.beat !== beat || resolved.anchor.target.beat !== beat ||
      resolved.head.target.beat !== beat || resolved.anchor.target.cell !== range.target.cell ||
      resolved.head.target.cell !== range.target.cell || resolved.anchor.offset !== start.offset ||
      resolved.head.offset !== end.offset) return stopped;
    const buffered = draft;
    stopped = null;
    try {
      return finish(undefined, true, true);
    } finally {
      if (draft === buffered && !stopped) stopped = "missing";
      if (draft !== buffered) buffered.compositionCaret?.dispose();
    }
  }

  function joinSeams(cell: Element): NativeNarrationSeams | null {
    return cell.getAttribute("data-field") === "visualText" ? null : paintedJoinSeams(cell.getAttribute("data-id") ?? "");
  }

  function crossesJoin(cell: Element, { from, to }: CellRange, seams: NativeNarrationSeams | null): boolean {
    if (!seams?.length || from === to) return false;
    const buffered = draft?.cell === cell ? draft : null;
    if (buffered) {
      const start = buffered.selection.from, end = start + buffered.text.length;
      const beforePreview = (offset: number) => offset >= end ? offset + buffered.selection.to - end : Math.min(offset, start);
      from = beforePreview(from);
      to = beforePreview(to);
    }
    return seams.some(([start, end]) => from < end && to > start);
  }

  function refuseJoinedEdit(cell: Element): void {
    if (finish()) return;
    publish();
    if (cell.closest("#writer-doc")) writerControls()?.renderWriter();
    else renderRow(cell.getAttribute("data-id"));
    session.refuse(UNSUPPORTED);
  }

  function restoreUnsupportedInput(cell: Element): void {
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

  function draftEndpoint(buffered: Draft, offset: number, assoc: 0 | -1, coversDraftEdge: boolean) {
    const { from, to } = buffered.selection, end = from + buffered.text.length;
    if (offset >= from && offset <= end && (buffered.text.length || from !== to)) {
      return { point: null, index: offset - from, bound: false };
    }
    const original = offset > end ? offset - end + to : offset;
    const bound = coversDraftEdge && buffered.text.length > 0 && (assoc === 0 ? offset < from : offset > end);
    return { point: buffered.paint?.point(original, assoc) ?? null, index: bound ? (assoc === 0 ? 0 : buffered.text.length) : null, bound };
  }

  function resolveDraftEndpoint(beat: string, field: Draft["field"], endpoint: ReturnType<typeof draftEndpoint>, inserted: RelativePoint | null | undefined, assoc: 0 | -1) {
    const resolve = (point: RelativePoint) => field === "title" ? native.titleOffset({ from: point }, assoc) : native.narrationOffset(beat, { from: point }, assoc);
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
    const oldHtml = cell instanceof HTMLInputElement ? cell.value : cell.innerHTML;
    if (buffered.cell !== cell) {
      if (cell instanceof HTMLInputElement) {
        const shown = () => documentReader.current()?.title ?? "";
        const original = shown();
        if (buffered.composing) settleBlur(buffered);
        if (finish(undefined, moveCaret)) return null;
        const fresh = titleTextSurface.cell("");
        if (!fresh) { session.refuse(STALE); return null; }
        if (original === shown()) return { cell: fresh, selection };
        if (keepPreview && fresh instanceof HTMLInputElement) fresh.value = oldHtml;
        return { cell: fresh, selection, stale: true };
      }
      const beat = cell.getAttribute("data-id") ?? "";
      const visual = visualTextSurface.cellAt(cell) === cell;
      const shown = () => documentReader.read(doc => doc?.rows.find(row => row.id === beat)?.[visual ? "visualText" : "audioText"]);
      const original = shown();
      if (buffered.composing) settleBlur(buffered);
      if (finish(undefined, moveCaret)) return null;
      const fresh = visual ? visualTextSurface.cell(beat) : narrationCell(beat, cell);
      if (!fresh) { session.refuse(STALE); return null; }
      if (original === shown()) return { cell: fresh, selection };
      if (keepPreview) fresh.innerHTML = oldHtml;
      return { cell: fresh, selection, stale: true };
    }
    const start = draftEndpoint(buffered, selection.from, 0, selection.to >= buffered.selection.from);
    const end = draftEndpoint(buffered, selection.to, -1, selection.from <= buffered.selection.from + buffered.text.length);
    const capture: SelectionCapture = { indices: [start.index, end.index] };
    if (finish(capture, moveCaret) || capture.removed) return null;
    const fresh = buffered.surface.cell(buffered.beat);
    if (!fresh) { session.refuse(STALE); return null; }
    const from = resolveDraftEndpoint(buffered.beat, buffered.field, start, capture.inserted?.[0], 0);
    const to = resolveDraftEndpoint(buffered.beat, buffered.field, end, capture.inserted?.[1], -1);
    if (from != null && to != null && from <= to) return { cell: fresh, selection: { from, to } };
    if (keepPreview) {
      if (fresh instanceof HTMLInputElement) fresh.value = oldHtml;
      else fresh.innerHTML = oldHtml;
    }
    return { cell: fresh, selection, stale: true };
  }

  function atBatchBoundary(buffered: Draft): boolean {
    return buffered.units >= BATCH_UNITS || /\s$/.test(buffered.text);
  }

  function finishTypedCue(buffered: Draft): void {
    finish({ indices: [null, buffered.previewCaret - buffered.selection.from, true] });
  }

  function caretAnchor(beat: string, offset: number) {
    const target = { beat, cell: "narration" } as const;
    const anchored = native.commands.anchorText(target, offset);
    return anchored.kind === "anchored" ? anchored.range : null;
  }

  function pendingHeadingRow(doc: FlowDoc, beat: string) {
    const index = doc.rows.findIndex(row => row.id === beat);
    const row = doc.rows[index];
    return row && startsParagraph(doc, index) && projection(scriptCellOf(row.audioText)).startsWith(HEADING_MARKER) ? row : null;
  }

  function noteHeadingSelection(): void {
    if (!headingCandidates.size || stopped || draft?.composing || document.activeElement?.id !== "writer-doc") return;
    const focus = document.getSelection()?.focusNode;
    const element = focus instanceof Element ? focus : focus?.parentElement;
    const beat = element?.closest(".wr-beat")?.getAttribute("data-id");
    if (!beat || !headingCandidates.has(beat)) return;
    const head = writerControls()?.writerFlowControl()?.selection()?.head;
    if (head?.kind !== "beat" || head.rowId !== beat) return;
    const row = documentReader.read(doc => doc && pendingHeadingRow(doc, beat));
    if (!row) return;
    const newline = projection(scriptCellOf(row.audioText)).indexOf("\n");
    if (newline === -1 || head.offset <= newline) pendingHeading = beat;
  }

  function refuseHeading(beat: string, html: string | null | undefined, reason: string): void {
    if (reason === "joined") {
      const shown = html ?? "";
      if (refusedJoinedHeadings.get(beat) === shown) return;
      refusedJoinedHeadings.set(beat, shown);
    }
    refuseCommand(reason);
  }

  function writerAnchor(point: FlowPos) {
    if (point.kind === "heading") {
      const anchored = native.commands.anchorText({ beat: point.sceneId, cell: "name" }, point.offset);
      return anchored.kind === "anchored" ? anchored.range : null;
    }
    const nativePoint = native.narrationCaret(point.rowId, point.offset);
    return nativePoint && caretAnchor(nativePoint.beat, nativePoint.offset);
  }

  function writerSelection(range: FlowRange | null): NativeUndoSelectionInput | null {
    if (!range) return null;
    const anchor = writerAnchor(range.anchor), head = writerAnchor(range.head);
    return anchor && head ? { anchor, head } : null;
  }

  function leaveHeadingLine(force = false, beforeEdit?: () => WriterHeadingTarget | null):
    { readonly target: WriterHeadingTarget | null | undefined } | undefined {
    if (!pendingHeading || draggingHeading || stopped || draft?.composing || native.isClosingOrClosed()) return;
    const focus = document.activeElement?.id === "writer-doc";
    const control = writerControls()?.writerFlowControl();
    const range = control?.selection() ?? null;
    if (!force && (!range || !focus)) return;
    const beat = pendingHeading;
    const row = documentReader.read(doc => doc && pendingHeadingRow(doc, beat));
    if (!row) { pendingHeading = null; return; }
    const text = projection(scriptCellOf(row.audioText));
    const newline = text.indexOf("\n");
    const point = range?.head;
    if (!force && point?.kind === "beat" && (point.rowId === beat ? newline === -1 || point.offset <= newline
      : writerNarration.cell(beat)?.parentElement === writerNarration.cell(point.rowId)?.parentElement && newline === -1)) return;
    const target = beforeEdit?.();
    pendingHeading = null;
    try {
      const refusal = admissionRefusal();
      if (refusal) { refuseCommand(refusal); return; }
      const cell = writerNarration.cell(beat);
      if (!cell || finish(undefined, false, true)) return;
      const current = writerNarration.cell(beat);
      if (!current || !paintIsCurrent() || !shownWriterBeat(current, beat)) { refuseCommand(STALE); return; }
      const keep = control?.selection() ?? range;
      const offset = keep?.head.kind === "beat" && keep.head.rowId === beat ? keep.head.offset : 0;
      const before = writerSelection(keep);
      const step = native.commands.finalizeHeading.withSelection(before, beat, offset, false);
      if (step.result.kind === "refused") { refuseHeading(beat, native.narrationHtml(beat), step.result.reason); return; }
      if (step.result.kind !== "written") return;
      const { heading, consumed, beat: landing, notice } = step.result;
      const remap = (point: FlowPos) => point.kind !== "beat" || point.rowId !== beat ? point
        : heading && point.offset < consumed
          ? headingPos(heading, Math.min(storedSceneName(native.document(), heading)?.length ?? 0, Math.max(0, point.offset - HEADING_MARKER.length)))
          : beatPos(landing, Math.max(0, point.offset - consumed));
      const after = keep && { anchor: remap(keep.anchor), head: remap(keep.head) };
      step.recordAfter(writerSelection(after));
      native.endTypingGroup();
      publish();
      if (focus && after) control?.place(after, true);
      if (notice) notices.show(notice, "warn");
      // why: a range captured inside a surviving beat stays bounded when only its prefix is removed.
      return { target: target && target.beat === beat ? { beat, from: target.from - consumed, to: target.to - consumed } : target };
    } catch (error) {
      report(error);
      refuseCommand(UNSUPPORTED);
    }
  }

  function settleHeadingBeforeEdit(narration: Element | null, beforeEdit?: () => WriterHeadingTarget | null) {
    if (!pendingHeading) return;
    const first = narration?.parentElement?.firstElementChild;
    if (first?.getAttribute("data-id") === pendingHeading && !first.querySelector("br")) return;
    return leaveHeadingLine(false, beforeEdit);
  }

  function structureCaret(cell: Element, selected = false, tag = false) {
    const refusal = admissionRefusal();
    if (refusal) { refuseCommand(refusal); return null; }
    const directed = readSelection(cell, document.getSelection());
    if (!directed || !selected && directed.anchor !== directed.head) { session.refuse(UNSUPPORTED); return null; }
    const backward = directed.anchor > directed.head;
    const selection = { from: Math.min(directed.anchor, directed.head), to: Math.max(directed.anchor, directed.head) };
    if (!tag && touchesProtectedText(cell, selection)) { session.refuse(UNSUPPORTED); return null; }
    const current = flushForInput(cell, selection, false);
    if (!current) return null;
    const beat = current.cell.getAttribute("data-id") ?? "";
    const row = documentReader.read(doc => doc?.rows.find(item => item.id === beat));
    const visual = visualTextSurface.cellAt(cell) === cell;
    const surface = visual ? visualTextSurface : narrationSurfaceOf(current.cell);
    const html = visual ? native.document().rows.find(item => item.id === beat)?.visualText : native.narrationHtml(beat);
    if (current.stale || !row || !surface.painted(current.cell, row) || row[visual ? "visualText" : "audioText"] !== html) {
      session.refuse(STALE);
      return null;
    }
    if (visual && !visualIsAddressable(beat, html)) { session.refuse(UNSUPPORTED); return null; }
    const { from: offset, to } = current.selection;
    const at = (at: number, right = false) => visual ? { beat, offset: at } : native.narrationCaret(beat, at, right);
    const anchor = (point: { beat: string; offset: number }) => {
      const result = native.commands.anchorText({ beat: point.beat, cell: visual ? "visual" : "narration" }, point.offset);
      return result.kind === "anchored" ? result.range : null;
    };
    const point = at(offset, offset !== to);
    const before = point && anchor(point);
    if (!point || !before) { session.refuse(STALE); return null; }
    if (offset === to) {
      if (selection.from !== selection.to) { session.refuse(STALE); return null; }
      return { beat, offset, endOffset: to, before, surface, html, range: null, backward: null };
    }
    const end = at(to);
    if (!end || point.beat !== end.beat) { session.refuse(UNSUPPORTED); return null; }
    const anchored = native.commands.anchorText(before.target, point.offset, end.offset);
    if (anchored.kind === "refused") { session.refuse(anchored.reason); return null; }
    const right = backward ? anchor(end) : null;
    if (backward && !right) { session.refuse(STALE); return null; }
    return { beat, offset, endOffset: to, before, surface, html, range: anchored.range, backward: right && { anchor: right, head: before } };
  }

  function insertWriterBeat(beat: string, side: "above" | "below", before: NativeTextRange, keep: boolean, transferParagraphStart = false): void {
    const step = native.commands.insertAdjacentBeat.withSelection(before, beat, side, editAttribution(), transferParagraphStart);
    if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
    const landing = keep ? beat : step.result.created;
    step.recordAfter(caretAnchor(landing, 0));
    publish();
    const fresh = writerNarration.cell(landing);
    if (fresh) writerNarration.place(fresh, landing, 0, 0, true);
  }

  function refuseWriterEnter(beat: string, from: number, to: number, cell: "narration" | "name"): false {
    const key = JSON.stringify([native.revision(), cell, beat, from, to]);
    if (key !== lastWriterEnterRefusal) {
      lastWriterEnterRefusal = key;
      refuseCommand(UNSUPPORTED);
    }
    return false;
  }

  function writerSplit(caret: NonNullable<ReturnType<typeof structureCaret>>, shown: ReturnType<typeof documentReader.current>): boolean {
    const doc = native.document(), index = doc.rows.findIndex(row => row.id === caret.beat);
    const row = doc.rows[index];
    if (!row) return false;
    const at = (offset: number) => beatPos(caret.beat, offset);
    const plan = enterAt(doc as unknown as FlowDoc, { anchor: at(caret.offset), head: at(caret.endOffset) }, writerFlowPorts);
    if (!plan) return false;
    const refuse = () => refuseWriterEnter(caret.beat, caret.offset, caret.endOffset, "narration");
    if (!("rows" in plan)) return refuse();
    if (plan.rows.length === doc.rows.length + 1) {
      const above = plan.rows[index]?.id !== row.id;
      const fresh = plan.rows[index + (above ? 0 : 1)];
      if (fresh?.audioText && !above) return true;
      const side = above ? "above" : "below";
      if (!fresh || caret.range || !sameNativeInsertPlacement(shown, doc, row.id, side)) {
        return refuse();
      }
      insertWriterBeat(row.id, side, caret.before, above, fresh.paragraphStart === true);
      return false;
    }
    const planned = plan.rows[index];
    // why: keep native splits available when standalone Enter also changes a paragraph flag
    if (!caret.range && plan.rows.length === doc.rows.length - 1) return true;
    if (plan.rows.length !== doc.rows.length || planned?.id !== row.id || planned.paragraphStart !== true) {
      return refuse();
    }
    if (caret.range) return row.paragraphStart === true ? refuse() : true;
    const step = native.commands.setField.withSelection(caret.before, { kind: "beat", id: row.id, field: "paragraphStart" }, true);
    if (step.result.kind === "refused") refuseCommand(step.result.reason);
    if (step.result.kind === "written") {
      step.recordAfter(caret.before);
      publish();
      show({ anchor: { target: caret.before.target, offset: caret.offset }, head: { target: caret.before.target, offset: caret.offset } });
    }
    return false;
  }

  function split(cell: Element, writer = false): void {
    if (draft?.composing) { refuseCommand(PENDING); return; }
    const shown = writer ? documentReader.current() : null;
    const caret = structureCaret(cell, true);
    if (!caret) return;
    if (caret.surface === writerNarration && !caret.range && headingCandidates.has(caret.beat)) {
      if (!paintIsCurrent()) { refuseCommand(STALE); return; }
      const step = native.commands.finalizeHeading.withSelection(caret.before, caret.beat, caret.offset, true);
      if (step.result.kind === "refused") { refuseHeading(caret.beat, caret.html, step.result.reason); return; }
      if (step.result.kind === "written") {
        const { beat, offset, notice } = step.result;
        if (pendingHeading === caret.beat) pendingHeading = null;
        step.recordAfter(caretAnchor(beat, offset));
        publish();
        const fresh = writerNarration.cell(beat);
        if (fresh) writerNarration.place(fresh, beat, offset, offset, true);
        if (notice) notices.show(notice, "warn");
        return;
      }
    }
    if (writer && !writerSplit(caret, shown)) return;
    const step = caret.range ? native.commands.deleteAndSplit.withSelection(caret.backward ?? caret.range, caret.range)
      : native.commands.splitRow.withSelection(caret.before, caret.before);
    if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
    if (step.result.kind === "unchanged") return;
    const beat = step.result.created;
    step.recordAfter(caretAnchor(beat, 0));
    publish();
    const fresh = caret.surface.cell(beat);
    if (fresh) caret.surface.place(fresh, beat, 0, 0, true);
  }

  function format(cell: Element, mark: NativePlainMark): void {
    if (stopped || draft?.composing) { beforePress(); return; }
    const selected = structureCaret(cell, true);
    if (!selected) return;
    if (!selected.range) { session.refuse(UNSUPPORTED); return; }
    const { offset, endOffset } = selected;
    const on = !markThroughout(scriptCellOf(selected.html ?? ""), offset, endOffset, mark);
    const before = selected.backward ?? selected.range;
    const step = native.commands.formatText.withSelection(before, selected.range, { kind: "plain", mark, on });
    if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
    if (step.result.kind === "unchanged") return;
    step.recordAfter(before);
    publish();
    const updated = selected.surface.cell(selected.beat);
    if (updated) selected.surface.place(updated, selected.beat, selected.backward ? endOffset : offset,
      selected.backward ? offset : endOffset, false);
  }

  function labelVisual(beat: string, from: number, to: number, label: NativeVisualLabel, landing: number, before: NativeUndoSelectionInput): void {
    const target = { beat, cell: "visual" } as const;
    const range = native.commands.anchorText(target, from, to);
    if (range.kind === "refused") { refuseCommand(range.reason); return; }
    const step = native.commands.labelVisual.withSelection(before, range.range, label);
    if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
    const after = native.commands.anchorText(target, landing);
    if (after.kind === "anchored") step.recordAfter(after.range);
    publish();
    const updated = visualTextSurface.cell(beat);
    if (updated) visualTextSurface.place(updated, beat, landing, landing, false);
  }

  function closeTagPicker(): void {
    tagPicker?.close();
    tagPicker = null;
  }

  function pickVisualTag(cell: HTMLElement): void {
    const prior = tagPicker;
    closeTagPicker();
    if (prior?.cell === cell) return;
    closeTypedTag();
    if (stopped || draft?.composing) { beforePress(); return; }
    const selected = structureCaret(cell, true, true);
    if (!selected) return;
    const { beat, offset, endOffset, html, range, backward } = selected;
    if (!range) { session.refuse(UNSUPPORTED); return; }
    const model = scriptCellOf(html ?? "");
    const phrase = plainTagPhrase(projection(model).slice(offset, endOffset));
    if (!phrase || sliceCell(model, offset, endOffset).some(run => run.atom || run.marks.href)) {
      session.refuse(UNSUPPORTED);
      return;
    }
    const unchanged = native.captureTextIdentity(range);
    const liveSelection = () => unchanged?.() ? native.resolveTextSelection(range) : null;
    const place = (fresh: HTMLElement, selection: NonNullable<ReturnType<typeof liveSelection>>) => {
      const { anchor, head } = selection;
      visualTextSurface.place(fresh, beat, (backward ? head : anchor).offset, (backward ? anchor : head).offset, false);
    };
    const open = (shown: HTMLElement): void => {
      const cancel = (restore: boolean) => {
        closeTagPicker();
        const selection = restore && liveSelection();
        if (selection && shown.isConnected) place(shown, selection);
      };
      const close = showToolbarTagPicker(shown, category => {
        cancel(false);
        const cat = tagCategoryId(category);
        if (!cat) return;
        const refusal = admissionRefusal();
        if (refusal) { refuseCommand(refusal); return; }
        const selection = liveSelection();
        const doc = native.document();
        if (!selection || !shown.isConnected || !visualIsAddressable(beat, doc.rows.find(row => row.id === beat)?.visualText)) {
          session.refuse(STALE);
          return;
        }
        const from = selection.anchor.offset, to = selection.head.offset;
        const name = registryEntryOf(doc, cat, phrase.name)?.name || phrase.name;
        labelVisual(beat, from + phrase.lead, to - phrase.trail, { cat, name, words: phrase.text }, to, backward ?? range);
      }, cancel);
      if (close) tagPicker = { cell: shown, close, reopen: () => {
        closeTagPicker();
        const fresh = visualTextSurface.cell(beat), selection = liveSelection();
        if (fresh?.closest("#rows") && selection && document.activeElement === document.body) {
          place(fresh, selection);
          open(fresh);
        }
      } };
    };
    open(cell);
  }

  function noteVisualTagKeyword(beat: string): void {
    if (typedTag) return;
    const cell = visualTextSurface.cell(beat), at = cell && plainTagKeywordAtCaret(cell);
    if (!cell || !at) return;
    const from = domToPos(cell, at.node, at.kwStart);
    if (from === null) return;
    const keyword = at.kw, start = from + keyword.length;
    const anchor = native.commands.anchorText({ beat, cell: "visual" }, from, start);
    if (anchor.kind !== "anchored") return;
    const candidates = { productionTags: native.document().productionTags.filter(tag => tag?.cat === keyword.cat) };
    typedTag = { keyword, range: anchor.range, cell, start, candidates, typed: "", suggestion: null, dismissed: null };
    showPlainTagHint(cell, from, keyword.cat, "");
  }

  function closeTypedTag(): void {
    if (!typedTag) return;
    typedTag = null;
    hidePlainTagHint();
  }

  function visualTagDraft(cell: Element, offset: number, html: string) {
    const opened = typedTag;
    if (!opened || opened.range.target.beat !== cell.getAttribute("data-id")) return null;
    const source = native.resolveTextSelection(opened.range);
    if (!source || source.head.offset > offset) return null;
    const from = source.anchor.offset, start = source.head.offset;
    const model = scriptCellOf(html), text = projection(model);
    if (text.slice(from, start) !== opened.keyword.keyword) return null;
    const limit = existingPlainTagEnd(model, start);
    if (offset > limit) return null;
    const end = offset === start ? limit : offset;
    return { opened, from, start, end, text, typed: text.slice(start, end) };
  }

  function refreshVisualTag(beat: string): void {
    const opened = typedTag, caret = document.getSelection();
    if (!opened || opened.range.target.beat !== beat) return;
    const { cell, start, keyword, candidates } = opened;
    const node = caret?.anchorNode;
    if (!cell.isConnected || !caret || !node || !caret.rangeCount || !caret.isCollapsed || !cell.contains(node)) { closeTypedTag(); return; }
    const at = domToPos(cell, node, caret.anchorOffset);
    if (at === null || at < start) { closeTypedTag(); return; }
    const point = posToDom(cell, start), range = caret.getRangeAt(0).cloneRange();
    range.setStart(point.node, point.offset);
    const typed = range.toString().replace(/\u200b/g, "");
    opened.typed = typed;
    const suggestion = typed === opened.dismissed ? null : registryCompletion(candidates, keyword.cat, typed)?.name ?? null;
    if (opened.suggestion === suggestion) return;
    opened.suggestion = suggestion;
    updatePlainTagHint(keyword.cat, suggestion ?? "");
  }

  function completeVisualTag(cell: Element): boolean {
    if (!typedTag || typedTag.range.target.beat !== cell.getAttribute("data-id")) return false;
    const selection = cellSelection(cell);
    if (!selection || selection.from !== selection.to) { closeTypedTag(); return false; }
    const selected = structureCaret(cell);
    if (!selected) { closeTypedTag(); return true; }
    const { beat, offset, before, html } = selected;
    const proposal = visualTagDraft(cell, offset, html ?? "");
    if (!proposal) { closeTypedTag(); return false; }
    const { opened, from, start, end, text, typed } = proposal;
    const phrase = plainTagPhrase(typed);
    if (!phrase) { closeTypedTag(); return true; }
    const doc = native.document(), { cat } = opened.keyword;
    const completion = opened.suggestion && registryCompletionOf(doc, cat, typed, opened.suggestion);
    if (opened.suggestion && !completion) {
      opened.suggestion = registryCompletion(doc, cat, opened.typed)?.name ?? null;
      updatePlainTagHint(cat, opened.suggestion ?? "");
      return true;
    }
    closeTypedTag();
    const name = completion ?? registryEntryOf(doc, cat, phrase.name)?.name ?? phrase.name;
    const wordStart = start + phrase.lead;
    labelVisual(beat, from, end - phrase.trail, { cat, name, words: phrase.text, prefix: text.slice(from, wordStart), completion },
      from + (completion ?? phrase.text).length + phrase.trail, before);
    return true;
  }

  function inlineText(cell: Element, text: string, line: boolean): void {
    if (stopped || draft?.composing) { beforePress(); return; }
    if (!line && cleanText(text) !== text) { refuseCommand(UNSUPPORTED); return; }
    const selected = structureCaret(cell, true);
    if (!selected) return;
    const { beat, offset, endOffset, range, before, backward, surface, html } = selected;
    let insert: readonly Run[] = [{ text, marks: {} }];
    let landing = offset + text.length;
    if (line ? surface !== writerNarration || !range : !cell.closest("#writer")) {
      const model = scriptCellOf(html ?? "");
      const broken = line ? breakLine(model, offset, endOffset) : null;
      const next = broken?.cell ?? replaceText(model, offset, endOffset, text);
      const added = cellLength(next) - cellLength(deleteRange(model, offset, endOffset));
      insert = sliceCell(next, offset, offset + added);
      landing = broken?.pos ?? offset + added;
    }
    const step = native.commands.replaceText.withSelection(backward ?? range ?? before, range ?? before,
      insert, editAttribution());
    if (step.result.kind === "recovery") { refuseCommand(step.result.reason); return; }
    if (step.result.kind === "unchanged") return;
    if (!line && surface === writerNarration && offset < HEADING_MARKER.length) {
      headingCandidates.delete(beat);
      refusedJoinedHeadings.delete(beat);
      if (pendingHeading === beat) pendingHeading = null;
    }
    const point = before.target.cell === "visual" ? { beat, offset: landing } : native.narrationCaret(beat, landing);
    const after = point && native.commands.anchorText({ ...before.target, beat: point.beat }, point.offset);
    if (after?.kind === "anchored") step.recordAfter(after.range);
    publish();
    const fresh = surface.cell(beat);
    if (fresh) surface.place(fresh, beat, landing, landing, false);
    if (before.target.cell === "visual" && fresh?.closest("#rows") && currentWhoList()?.isOpen()) {
      updateSplitVisualWhoList(beat);
    }
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
      if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
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
    if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
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

  function enterWriterHeading(heading: Element): void {
    const shown = documentReader.current(), id = heading.getAttribute("data-scene") ?? "";
    const refusal = admissionRefusal();
    if (refusal) { refuseCommand(refusal); return; }
    if (beforePress()) return;
    const doc = native.document(), scene = scenesInOrder(doc)?.find(item => item.id === id);
    const name = storedSceneName(doc, id), selection = cellSelection(heading);
    if (!scene || !name || heading.textContent !== name || !selection || selection.from !== selection.to) {
      session.refuse(UNSUPPORTED);
      return;
    }
    if (selection.from === name.length) {
      const fresh = writerNarration.cell(scene.firstSceneId);
      if (fresh) writerNarration.place(fresh, scene.firstSceneId, 0, 0, true);
      return;
    }
    const index = doc.rows.findIndex(row => row.id === scene.firstSceneId), previous = doc.rows[index - 1];
    if (selection.from !== 0 || !previous || !sameNativeInsertPlacement(shown, doc, previous.id, "below")) {
      refuseWriterEnter(id, selection.from, selection.to, "name");
      return;
    }
    const anchor = native.commands.anchorText({ beat: id, cell: "name" }, 0);
    if (anchor.kind === "refused") { refuseCommand(anchor.reason); return; }
    insertWriterBeat(previous.id, "below", anchor.range, false);
  }

  function headingInput(event: Event, heading: Element, remove: boolean): void {
    const refusal = admissionRefusal();
    if (refusal) { refuseCommand(refusal); return; }
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
      if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
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
    if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
    if (step.result.kind === "unchanged") return;
    const offset = range.from + text.length, after = native.commands.anchorText(target, offset);
    if (after.kind === "anchored") step.recordAfter(after.range);
    publish();
    const at = headingPos(id, offset);
    writerControls()?.writerFlowControl()?.place({ anchor: at, head: at });
  }

  function write(input: InputEvent, cell: Element, remappedTarget?: WriterHeadingTarget | null): void {
    const deletion = /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/.test(input.inputType);
    const text = input.data ?? "";
    const isTitle = cell instanceof HTMLInputElement;
    const insertAllowed = (input.inputType === "insertText" || isTitle && input.inputType === "insertReplacementText")
      && text && cleanText(text) === text && (!isTitle || !/[\r\n]/.test(text));
    if (input.isComposing || !(deletion || insertAllowed)) { refuseCommand(UNSUPPORTED); return; }
    const refusal = admissionRefusal();
    if (refusal) { refuseCommand(refusal); return; }
    let ranged: CellRange | "boundary" | null;
    if (remappedTarget === undefined) {
      ranged = isTitle ? titleInputRange(input, cell) : inputRange(input, cell);
    } else {
      if (!remappedTarget || remappedTarget.beat !== cell.getAttribute("data-id")) return;
      const from = Math.max(0, remappedTarget.from), to = remappedTarget.to;
      if (from > to || deletion && from === to) return;
      ranged = { from, to };
    }
    if (ranged === "boundary") return;
    const selection = ranged;
    if (!selection || deletion && selection.from === selection.to) { session.refuse(deletion ? UNSUPPORTED : STALE); return; }
    const buffered = draft;
    if (buffered && !buffered.deletion && insideDraft(buffered, cell, selection)) {
      reviseDraft(buffered, selection, text);
      preview(cell, selection, text);
      if (text.endsWith(":") && buffered.field === "audioText") finishTypedCue(buffered);
      else if (atBatchBoundary(buffered)) finish();
      return;
    }
    if (!isTitle && touchesProtectedText(cell, selection)) { session.refuse(UNSUPPORTED); return; }
    const shown = deletion ? readCellSelection(cell) : null;
    const gesture = shown && shown.from === shown.to ? { direction: input.inputType.endsWith("Backward") ? -1 : 1, at: now() } as const : null;
    const seams = isTitle || selection.from === selection.to ? null : joinSeams(cell);
    if (crossesJoin(cell, selection, seams)) { refuseJoinedEdit(cell); return; }
    const joinedDeletion = deletion && seams !== null;
    const current = flushForInput(cell, selection, !joinedDeletion);
    if (!current) return;
    const next = begin(current.cell, current.selection, false, text, gesture);
    let anchored: Draft | string;
    try { anchored = current.stale ? STALE : anchor(next); }
    catch (error) { report(error); anchored = PENDING; }
    if (joinedDeletion && anchored === STALE) { refuseJoinedEdit(current.cell); return; }
    if (anchored === UNSUPPORTED) { session.refuse(anchored); return; }
    draft = typeof anchored === "string" ? next : anchored;
    preview(current.cell, current.selection, text);
    if (typeof anchored === "string") { stop(anchored); return; }
    if (text.endsWith(":") && anchored.field === "audioText") { finishTypedCue(anchored); return; }
    if (anchored.field === "visualText" || atBatchBoundary(anchored)) {
      const reason = finish();
      if (!reason && anchored.field === "visualText" && anchored.cell.closest("#rows")) {
        updateSplitVisualWhoList(anchored.beat, input);
        if (input.data?.endsWith(":")) noteVisualTagKeyword(anchored.beat);
        if (typedTag) refreshVisualTag(anchored.beat);
      }
    }
    else timer = setTimeout(() => {
      const shown = readCellSelection(anchored.cell);
      finish(undefined, shown?.from === anchored.previewCaret && shown.to === anchored.previewCaret || !anchored.cell.isConnected);
    }, BATCH_MS);
  }

  function transferTitle(input: HTMLInputElement, text: string, cutData?: DataTransfer | null): void {
    if (stopped || draft?.composing) { beforePress(); return; }
    if (text && (/[\r\n]/.test(text) || cleanText(text) !== text)) { refuseCommand(UNSUPPORTED); return; }
    const refusal = admissionRefusal();
    if (refusal) { refuseCommand(refusal); return; }
    const selection = titleSelection(input);
    if (!selection) { session.refuse(STALE); return; }
    if (cutData && selection.from === selection.to) return;
    const backward = input.selectionDirection === "backward";
    const current = flushForInput(input, selection, false);
    if (!current || !(current.cell instanceof HTMLInputElement)) return;
    const liveEl = current.cell;
    const shownTitle = documentReader.current()?.title ?? "";
    const liveTitle = native.document().title;
    if (current.stale || liveEl.value !== shownTitle || shownTitle !== liveTitle) { session.refuse(STALE); return; }
    const { from, to } = current.selection;
    if (cutData) {
      if (from === to) return;
      cutData.setData("text/plain", liveTitle.slice(from, to));
    }
    const target = { beat: "", cell: "title" } as const;
    const anchored = native.commands.anchorText(target, from, to);
    if (anchored.kind === "refused") { session.refuse(anchored.reason); return; }
    const start = native.commands.anchorText(target, from), end = from === to ? start : native.commands.anchorText(target, to);
    if (start.kind === "refused" || end.kind === "refused") { session.refuse(STALE); return; }
    const before = backward && from !== to ? { anchor: end.range, head: start.range } : anchored.range;
    const step = text ? native.commands.replaceTitle.withSelection(before, anchored.range, text)
      : native.commands.deleteTitle.withSelection(before, anchored.range);
    if (step.result.kind === "refused") { refuseCommand(step.result.reason); return; }
    if (step.result.kind === "unchanged") return;
    const landing = from + text.length;
    const after = native.commands.anchorText(target, landing);
    if (after.kind === "anchored") step.recordAfter(after.range);
    publish();
    const fresh = titleTextSurface.cell("");
    if (fresh) titleTextSurface.place(fresh, "", landing, landing, false);
  }

  function composition(event: CompositionEvent, cell: Element): void {
    const isTitle = cell instanceof HTMLInputElement;
    if (event.type === "compositionstart") {
      const refusal = admissionRefusal();
      if (refusal) { refuseCommand(refusal); event.preventDefault(); return; }
      const selection = readCellSelection(cell);
      if (!selection || !isTitle && touchesProtectedText(cell, selection)) { session.refuse(STALE); event.preventDefault(); return; }
      if (draft?.composing) { event.preventDefault(); return; }
      if (!isTitle && selection.from !== selection.to && crossesJoin(cell, selection, joinSeams(cell))) {
        refusedJoinComposition = { cell, selection, html: cell.innerHTML, revision: !draft && paintIsCurrent() ? native.revision() : null };
        refuseJoinedEdit(cell);
        event.preventDefault();
        return;
      }
      composingText = "";
      compositionRefused = false;
      if (draft && !draft.deletion && insideDraft(draft, cell, selection)) {
        clearTimeout(timer);
        composingInside = { cell, selection, html: isTitle ? cell.value : cell.innerHTML };
        draft.composing = true;
        return;
      }
      const reason = finish();
      native.endDeletionGroup();
      if (reason || !cell.isConnected) { session.refuse(STALE); event.preventDefault(); return; }
      const anchored = anchor(begin(cell, selection, true, ""));
      if (typeof anchored === "string") { session.refuse(anchored); event.preventDefault(); return; }
      if (anchored.range) {
        if (selection.from === selection.to) {
          if (!isTitle) anchored.compositionCaret = native.captureCompositionCaret(anchored.range);
        } else anchored.compositionIdentity = native.captureTextIdentity(anchored.range);
      }
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
      finish(undefined, true, false, !!text);
      return;
    }
    if (!text) {
      restore(buffered);
      buffered.paint?.dispose();
      buffered.compositionCaret?.dispose();
      draft = null;
      clearMovePaint();
      publish();
      if (buffered.field === "visualText" && buffered.cell.closest("#rows")) updateSplitVisualWhoList(buffered.beat);
      return;
    }
    buffered.text = text;
    restore(buffered);
    preview(cell, buffered.selection, text);
    const reason = finish();
    if (draft !== buffered) buffered.compositionCaret?.dispose();
    if (!reason && buffered.field === "visualText" && buffered.cell.closest("#rows")) {
      updateSplitVisualWhoList(buffered.beat);
      if (typedTag) refreshVisualTag(buffered.beat);
    }
  }

  function intercept(event: Event, remappedTarget?: WriterHeadingTarget | null): void {
    const target = event.target instanceof Element ? event.target : null;
    if (event.type === "drop" && target?.closest("#rows .row") && rowDrag().dragging()) return;
    const button = event.type === "click" ? target?.closest("#rows .mini-toolbar button[data-cmd], #writer .wr-fmt[data-cmd]") ?? null : null;
    const cell = target?.closest(EDITABLE) ?? button?.closest(".field-wrap")?.querySelector(".cell-editable") ?? null;
    const narration = button?.closest("#writer") ? shownNarrationSurface().cellAt(document.querySelector("#writer-doc") ?? button)
      : target && cell ? narrationAt(target, cell) : null;
    const visual = cell && visualTextSurface.cellAt(cell);
    const titleInput = titleInputOf(cell);
    const editableText = narration ?? visual;
    const bufferedTarget = editableText ?? titleInput;
    const heading = headingAt(cell ?? null);
    const removeHeading = heading && joinDirection(event, heading) === -1;
    const joining = narration && joinDirection(event, narration);
    const key = event.type === "keydown" ? event as KeyboardEvent : null;
    const adding = key?.key === "Enter" && (key.ctrlKey || key.metaKey) && !!editableText?.closest("#rows");
    const mark = formattingMark(event, button, key);
    const input = event.type === "beforeinput" ? event as InputEvent : null;
    const inputType = input?.inputType;
    const commandInput = input?.cancelable && !input.isComposing;
    const writer = cell?.id === "writer-doc";
    const modified = key && (key.ctrlKey || key.metaKey);
    const enter = key?.key === "Enter" && (writer || !modified);
    const line = key ? enter && !modified && !key.altKey && (key.shiftKey || !writer)
      : commandInput && (inputType === "insertLineBreak" || inputType === "insertParagraph" && !writer);
    const moving = key && moveDirection(key);
    const splitting = key ? enter && (writer ? !key.altKey && (!key.shiftKey || modified) : key.altKey) : writer && commandInput && inputType === "insertParagraph";
    if (refusedJoinComposition && cell) {
      const change = event.type === "input" ? event as InputEvent : input;
      if (event.type === "compositionupdate" || event.type === "compositionend" || change?.isComposing || change?.inputType?.includes("Composition")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === "input") {
          publish();
          if (refusedJoinComposition.cell.isConnected && refusedJoinComposition.revision === native.revision()) restore(refusedJoinComposition);
          else restoreUnsupportedInput(cell);
        }
        return;
      }
      if (event.type === "compositionstart" || input) refusedJoinComposition = null;
    }
    if (event.type === "focusin") {
      if (titleInput) syncTitleTrack(titleInput);
      return;
    }
    if (event.type === "focusout") {
      if (titleInput && titleTrack?.input === titleInput) clearTitleTrack();
      if (imeTarget === cell) imeTarget = null;
      const next = (event as FocusEvent).relatedTarget;
      if (typedTag && visual && next instanceof Element && next !== document.body && visualTextSurface.cellAt(next) !== visual) closeTypedTag();
      if (cell && next instanceof Element && next.closest(ROW_MENU_BUTTON)) {
        insertMenuSelection = captureInsertMenuSelection(cell) ?? insertMenuSelection;
      }
      if (writer) {
        lastWriterEnterRefusal = null;
        if (next && next !== document.body) leaveHeadingLine(true);
      }
      if (cell) leaveTextCell(cell, next);
      return;
    }
    if (event.type === "pointerdown") {
      if (typedTag && target?.closest("#tag-open-hint")) {
        const active = visualTextSurface.cell(typedTag.range.target.beat);
        if (active?.closest("#rows")) completeVisualTag(active);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      closeTypedTag();
      imeTarget = null;
      lastWriterEnterRefusal = null;
      if (!draft?.composing && !stopped) {
        finish();
        native.endDeletionGroup();
      }
      if (target?.closest(ROW_MENU_BUTTON)) insertMenuSelection = captureInsertMenuSelection();
      else if (!target?.closest("#rows .row-menu")) insertMenuSelection = null;
      return;
    }
    if (event.type === "click") {
      if (target?.closest(ROW_MENU_BUTTON)) insertMenuSelection = captureInsertMenuSelection() ?? insertMenuSelection;
      else if (!target?.closest("#rows .row-menu")) insertMenuSelection = null;
      if (!button) return;
    } else if (!cell && !(event.type === "drop" && target?.closest("#rows .visual-cell"))) return;
    if (key) {
      const imeKey = key.isComposing || key.keyCode === 229, undoing = undoGesture(key);
      imeTarget = imeKey ? cell : null;
      if (key.key === "Enter" && key.altKey && cell?.id === "writer-doc") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if ((bufferedTarget || heading || cell?.id === "writer-doc") && (draft?.composing || imeKey)) {
        event.stopImmediatePropagation();
        if (undoing || adding || draft?.composing && (splitting || joining || removeHeading || moving || mark || line)) {
          event.preventDefault();
          if (!stopped && (undoing || !imeKey)) refuseCommand(PENDING);
        }
        return;
      }
      if (undoing && (visual?.closest("#writer") || titleInput)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        sharedUndoRoute()?.replay?.(undoing);
        return;
      }
      if (undoing && cell?.matches(UNDO_SURFACES)) { closeTypedTag(); return; }
      if (titleInput) {
        if (key.key === "Enter" || key.key.startsWith("Arrow") || key.key === "Home" || key.key === "End" || key.key === "Tab") {
          finish();
          native.endDeletionGroup();
        }
        return;
      }
      if (typedTag && visual?.closest("#rows")) {
        if (key.key === "Tab" && !modified && !key.altKey && !key.shiftKey && completeVisualTag(visual)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (key.key === "Escape") {
          if (typedTag.suggestion) {
            typedTag.dismissed = typedTag.typed;
            refreshVisualTag(typedTag.range.target.beat);
          } else closeTypedTag();
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (enter || key.key.startsWith("Arrow") || key.key === "Home" || key.key === "End") closeTypedTag();
      }
      if (key.key === "Tab" && visual?.closest("#rows")
        && currentWhoList()?.keydown(key, visual, () => refuseCommand(UNSUPPORTED))) {
        event.stopImmediatePropagation();
        return;
      }
      if (!editingKey(key) && !joining && !removeHeading) {
        if (key.key.startsWith("Arrow") || key.key === "Home" || key.key === "End" || key.key === "Tab") {
          finish();
          native.endDeletionGroup();
        }
        return;
      }
    }
    if (input || event.type.startsWith("composition")) {
      const followsImeKey = imeTarget !== null && imeTarget === cell;
      imeTarget = null;
      if (followsImeKey && !draft?.composing && commandInput && (inputType === "insertParagraph" || inputType === "insertLineBreak")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!stopped) refuseCommand(UNSUPPORTED);
        return;
      }
    }
    if (bufferedTarget && !stopped) {
      if (event.type.startsWith("composition")) {
        if (writer && event.type === "compositionstart" && settleHeadingBeforeEdit(narration)) {
          intercept(event);
          return;
        }
        event.stopImmediatePropagation();
        try { composition(event as CompositionEvent, bufferedTarget); }
        catch (error) { report(error); stop(PENDING); }
        return;
      }
      if (draft?.composing && draft.cell === bufferedTarget && (event.type === "beforeinput" || event.type === "input")) {
        const change = event as InputEvent;
        if (event.type === "beforeinput" && !change.isComposing && !change.inputType.includes("Composition")) {
          event.preventDefault();
          refuseCommand(PENDING);
        }
        if (event.type === "input" && (change.isComposing || change.inputType.includes("Composition"))) {
          if (change.data !== null) composingText = change.data;
          else if (change.inputType === "deleteCompositionText") composingText = "";
          if (visual?.closest("#rows") && currentWhoList()?.isOpen(visual)) currentWhoList()?.refresh();
        }
        event.stopImmediatePropagation();
        return;
      }
      if (event.type === "input" && draft?.cell === bufferedTarget) {
        event.stopImmediatePropagation();
        uncertain = true;
        stop(PENDING);
        return;
      }
    }
    if (inputType && (cell?.matches(UNDO_SURFACES) || titleInput) && HISTORY.test(inputType)) {
      closeTypedTag();
      if (visual?.closest("#writer") || titleInput) {
        event.preventDefault();
        event.stopImmediatePropagation();
        sharedUndoRoute()?.replay?.(inputType === "historyUndo" ? "undo" : "redo");
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (native.isClosingOrClosed()) return;
      if (stopped && (bufferedTarget || heading || writer)) {
        if (stopped !== "full" && (narration || titleInput) && !splitting && !joining && !moving && !mark && !line && !adding
          && event.type !== "paste" && !inputType?.startsWith("delete")) session.refuse(stopped);
        return;
      }
      if (pendingHeading && (writer || narration?.closest("#writer-doc"))) {
        const paste = event.type === "paste" ? (event as ClipboardEvent).clipboardData : null;
        const text = paste?.getData("text/plain");
        const edits = moving || joining || splitting || line || removeHeading ||
          mark && !document.getSelection()?.isCollapsed ||
          text && !/[\r\n]/.test(text) && paste?.types.every(type => type === "text/plain") ||
          commandInput && (inputType === "insertText" || inputType?.startsWith("delete") || !!heading);
        // why: the browser's target nodes may detach when heading conversion repaints the beat.
        const rememberTarget = input && narration && !heading ? () => {
          const beat = narration.getAttribute("data-id");
          const target = inputRange(input, narration);
          return beat && target ? { beat, ...target } : null;
        } : undefined;
        const departure = edits && settleHeadingBeforeEdit(narration, rememberTarget);
        if (departure) {
          intercept(event, departure.target);
          return;
        }
      }
      if (titleInput) {
        if (event.type === "paste") {
          const data = (event as ClipboardEvent).clipboardData;
          const text = data?.getData("text/plain") ?? "";
          if (text && !/[\r\n]/.test(text) && cleanText(text) === text) {
            transferTitle(titleInput, text);
            return;
          }
        }
        if (event.type === "cut") {
          const data = (event as ClipboardEvent).clipboardData;
          if (data) {
            transferTitle(titleInput, "", data);
            return;
          }
        }
        if (event.type === "beforeinput" && event.cancelable) { write(event as InputEvent, titleInput); return; }
        if (event.type === "input") restoreUnsupportedInput(titleInput);
        session.refuse(UNSUPPORTED);
        return;
      }
      if (adding && editableText) {
        const id = editableText.getAttribute("data-id");
        if (id) {
          const command = addBeatCommand(id, randomIds.id("r"), sessionStamps);
          const outcome = session.run({ ...command, structure: { kind: "insert-beat", id, focus: visual ? "visual" : "narration" } });
          if (outcome.kind === "failed") report(outcome.error);
        }
        return;
      }
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
      if (heading && splitting) { enterWriterHeading(heading); return; }
      if (heading && (removeHeading || event.type === "beforeinput" && event.cancelable)) {
        headingInput(event, heading, !!removeHeading);
        return;
      }
      if (narration && splitting) {
        split(narration, writer);
        return;
      }
      if (button?.getAttribute("data-cmd") === "tag" && visual instanceof HTMLElement && visual.closest("#rows")) {
        pickVisualTag(visual);
        return;
      }
      if (editableText && mark) { format(editableText, mark); return; }
      if (editableText && line) { inlineText(editableText, "\n", true); return; }
      if (editableText && event.type === "paste") {
        const data = (event as ClipboardEvent).clipboardData;
        const text = data?.getData("text/plain") ?? "";
        if (text && !/[\r\n]/.test(text) && data?.types.every(type => type === "text/plain")) {
          inlineText(editableText, text, false);
          return;
        }
      }
      if (event.type === "beforeinput" && editableText && event.cancelable) { write(event as InputEvent, editableText, remappedTarget); return; }
      if (event.type === "input" && cell) restoreUnsupportedInput(cell);
      session.refuse(UNSUPPORTED);
    } catch (error) {
      report(error);
      session.refuse(UNSUPPORTED);
    }
  }
  function leaveTextCell(cell: Element, next: EventTarget | null): void {
    const buffered = draft && cell.contains(draft.cell) ? draft : null;
    const settle = () => { if (buffered && draft === buffered) settleBlur(buffered); };
    const beat = cell.getAttribute("data-id");
    const field = cell.getAttribute("data-field");
    const selector = cell.matches(".wr-flow-visual-text") ? ".wr-flow-visual-text" : "#rows .cell-editable";
    const sameCell = (target: EventTarget | null) => target instanceof Node && (cell.contains(target)
      || !!beat && target instanceof Element && target.matches(selector) && target.getAttribute("data-id") === beat
      && target.getAttribute("data-field") === field);
    if (next && next !== document.body) {
      if (!sameCell(next)) {
        if (buffered?.deletion) buffered.endsGroup = true;
        else native.endDeletionGroup();
      }
      if (buffered) queueMicrotask(settle);
      return;
    }
    // why: replacing a focused cell can blur it before the publication restores focus to its successor
    queueMicrotask(() => {
      const departed = !sameCell(document.activeElement);
      settle();
      if (departed) native.endDeletionGroup();
    });
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
    if (selection.head.target.cell === "title") {
      const fresh = titleTextSurface.cell("");
      if (!fresh) return;
      const anchor = selection.anchor.target.cell === "title" ? selection.anchor.offset : selection.head.offset;
      titleTextSurface.place(fresh, "", anchor, selection.head.offset, false);
      syncTitleTrack(fresh);
      return;
    }
    if (selection.head.target.cell === "visual") {
      const { beat } = selection.head.target;
      if (document.activeElement?.id === "writer-doc" && document.querySelector(".wr-flow-visual-box[hidden]")) {
        const flow = writerControls()?.writerFlowControl();
        const range = flow?.selection();
        // why: placing Visual's caret in a hidden box leaves Writer focus with selection outside its editing host
        if (flow && range) flow.place(range);
        return;
      }
      let cell = visualTextSurface.cell(beat);
      if (!cell) {
        writerControls()?.writerFlowControl()?.openVisual(beat);
        cell = visualTextSurface.cell(beat);
      }
      if (!cell) return;
      const anchor = selection.anchor.target.cell === "visual" && selection.anchor.target.beat === beat ? selection.anchor : selection.head;
      visualTextSurface.place(cell, beat, anchor.offset, selection.head.offset, false);
      return;
    }
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
      noteHeadingSelection();
      return;
    }
    if (cell) surface.place(cell, head.row, anchor?.row === head.row ? anchor.offset : head.offset, head.offset, true);
    if (surface === writerNarration) noteHeadingSelection();
  }

  function beforePress(): string | null {
    if (native.isClosingOrClosed()) return "closed";
    if (stopped) return stopped;
    if (!draft) {
      if (emptyWriter?.composing()) {
        refuseCommand(PENDING);
        return PENDING;
      }
      return emptyWriter?.hasText() ? emptyWriter.commit(true) : null;
    }
    if (!draft.composing) {
      const selection: SelectionCapture = { indices: [null, null] };
      return finish(selection, true, true) ?? (selection.removed === "discarded" ? NATIVE_REMOVED_TYPING : null);
    }
    refuseCommand(PENDING);
    return PENDING;
  }

  function visualSelection(beat: string, active = document.activeElement) {
    const cell = active && visualTextSurface.cellAt(active);
    if (cell?.getAttribute("data-id") !== beat) return null;
    const selection = readSelection(cell, document.getSelection());
    if (!selection) return null;
    const target = { beat, cell: "visual" } as const;
    const anchor = native.commands.anchorText(target, selection.anchor);
    const head = native.commands.anchorText(target, selection.head);
    return anchor.kind === "anchored" && head.kind === "anchored" ? { anchor: anchor.range, head: head.range } : null;
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

  function captureInsertMenuSelection(active = document.activeElement) {
    if (!active?.closest("#rows .cell-editable")) return null;
    const narration = captureMoveSelection(active);
    const visual = visualSelection(active.getAttribute("data-id") ?? "", active);
    return narration || visual ? { narration, visual } : null;
  }

  function takeInsertMenuSelection() {
    const selection = insertMenuSelection;
    insertMenuSelection = null;
    return selection;
  }

  function captureMoveSelection(active = document.activeElement) {
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
    const current = paintIsCurrent();
    function capture({ cell, offset }: MoveEndpoint, assoc: 0 | -1) {
      const beat = cell.getAttribute("data-id") ?? "";
      if (buffered?.cell === cell) return { beat, offset, preview: draftEndpoint(buffered, offset, assoc, true) };
      if (!shownWriterBeat(cell, beat)) return null;
      if (current) return { beat, offset };
      const point = movePaint.get(cell)?.point(offset, assoc);
      return point && native.narrationOffset(beat, { from: point }, assoc) !== null ? { beat, point } : null;
    }
    const start = capture(backward ? head : anchor, 0), end = capture(backward ? anchor : head, -1);
    if (!start || !end) return null;
    const selection: SelectionCapture = { indices: [start.preview?.index ?? null, end.preview?.index ?? null] };
    const reason = finish(selection, false);
    if (reason) return { kind: "refused", reason } as const;
    if (selection.removed) return { kind: "refused", reason: selection.removed === "discarded" ? NATIVE_REMOVED_TYPING : "missing" } as const;
    if (!buffered) publish();
    function resolve(point: NonNullable<typeof start>, index: 0 | 1, assoc: 0 | -1) {
      const { beat, preview } = point, html = native.narrationHtml(beat);
      const cell = writerNarration.cell(beat), row = documentReader.read(doc => doc?.rows.find(item => item.id === beat));
      if (!cell || !row || !writerNarration.painted(cell, row) || row.audioText !== html) return null;
      const rebased = preview ? resolveDraftEndpoint(beat, "audioText", preview, selection.inserted?.[index], assoc)
        : point.point ? native.narrationOffset(beat, { from: point.point }, assoc) : point.offset ?? null;
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
  const rows = document.getElementById("rows");
  let stopUnload: (() => void) | undefined;
  const dispose = (): void => {
    clearTimeout(timer);
    clearTitleTrack();
    draft?.compositionCaret?.dispose();
    draft?.paint?.dispose();
    draft = null;
    stopWriterPaint?.();
    if (currentWhoList()?.isOpen()) currentWhoList()?.cancel();
    closeTypedTag();
    closeTagPicker();
    stopPaint();
    stopSize();
    stopUnload?.();
    window.removeEventListener("pagehide", pageHide);
    document.removeEventListener("visibilitychange", visibility);
    for (const type of EVENTS) window.removeEventListener(type, intercept, true);
    rows?.removeAttribute("data-native-shared-input");
  };
  try {
    stopUnload = guardUnload(window, () => !!finish());
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibility);
    for (const type of EVENTS) window.addEventListener(type, intercept, true);
    rows?.setAttribute("data-native-shared-input", "");
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    finish,
    settleLeave,
    beforePress,
    refuseCommand,
    currentCaret,
    visualSelection,
    takeInsertMenuSelection,
    bindWriterPaint,
    clearMovePaint,
    captureMoveSelection,
    settleMoveSelection,
    show,
    endGroup: (): void => {
      if (draft) draft.endsGroup = true;
      else native.endTypingGroup();
    },
    buffered: () => draft !== null || (emptyWriter?.composing() ?? false),
    bufferedIn: (beat: string, field: "audioText" | "visualText") => draft?.beat === beat && draft.field === field,
    abandonComposition: () => {
      emptyWriter?.abandon();
      if (draft?.composing && !stopped) endComposition(draft, "");
    },
    hasWriterPreview: (beat: string) => draft?.surface === writerNarration && draft.beat === beat,
    stop: () => { if (!stopped) stop(PENDING); },
    recover: (reopened: ReturnType<typeof openNativeSession>): Uint8Array | null => {
      if (!draft || draft.composing || uncertain || !draft.range) return null;
      const result = commit(draft, reopened);
      if (!result || result.kind === "recovery" || result.kind === "refused") return null;
      const bytes = reopened.encodeState();
      draft.paint?.dispose();
      draft.compositionCaret?.dispose();
      draft = null;
      clearMovePaint();
      stopped = null;
      return bytes;
    },
    dispose
  };
}

export function keepNativeFieldPaint(buffered: Pick<Draft, "cell" | "beat" | "field">, row: Parameters<typeof noteFieldPainted>[2] | undefined): void {
  if (buffered.field !== "title" && row?.[buffered.field] === buffered.cell.innerHTML) noteFieldPainted(buffered.cell, buffered.field, row);
}
