import * as Y from "yjs";
import { continuesSharedTypingWord } from "../../../application/editing/undo/shared-undo.ts";
import type { ValidatedDocument } from "../../../core/document/validated.ts";
import type { MigratePorts } from "../../../core/migrate.ts";
import type { Marks, Run } from "../../../core/text/runs.ts";
import {
  createNativeComment, createNativeReply, removeNativeComment, reopenNativeComment, resolveNativeComment, setNativeCommentBody
} from "./comment-commands.ts";
import type { NativeCommentTarget, NativeNewComment, NativeNewReply } from "./comment-commands.ts";
import { convertToNativeScript } from "./convert.ts";
import type { NativeConversionPorts } from "./convert.ts";
import { formatNativeCue, formatNativeText, labelNativeVisual } from "./format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "./heading-commands.ts";
import { createFirstNativeBeat, insertNativeBeatAdjacent, putBackNativeBeat } from "./insert-commands.ts";
import { compareNativeOfflineNotice } from "./offline-notice.ts";
import { nativeBeatPlacements, openNativePendingEdits } from "./pending-edits.ts";
import type { NativePendingEditsData } from "./pending-edits.ts";
import type { OfflineSavedBeat } from "../../../application/collaboration/offline-clashes.ts";
import { moveNativeBlocks } from "./move-commands.ts";
import { clearNativeField, setNativeField } from "./record-commands.ts";
import { changeNativeRegistry, closeNativeBroll } from "./registry-commands.ts";
import { beforeNativeWrite, openNativeScript, withNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { createNativeSizeTracker, resolveNativeSizeOptions } from "./size.ts";
import type { NativeSessionSize, NativeSizeOptions } from "./size.ts";
import { deleteAndSplitNativeRow, finalizeNativeHeading, joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "./structure-commands.ts";
import { anchorNativeText, captureNativeCompositionCaret, captureNativeTextIdentity, deleteNativeText, editNativeTitle, replaceAllNativeText, replaceNativeText, resolveNativeTextPoint, resolveNativeUndoSelection, snapshotNativeUndoAnchor, typeNativeText } from "./text-commands.ts";
import type { NativeEditStamp, NativeLiveRange, NativeTextPlacement, NativeTextRange, NativeTextTarget, NativeUndoSelectionInput } from "./text-commands.ts";
import { openNativeUndo } from "./undo-commands.ts";
import type { NativeUndoOutcome } from "./undo-commands.ts";
import { NATIVE_FORMAT_VERSION } from "./roots.ts";
import { nativeCellView, nativeStoredOffset } from "./inline.ts";
import type { PresenceLocation, PresencePoint } from "../../../application/collaboration/presence.ts";

export type NativeSessionSource =
  | { readonly kind: "empty" }
  | { readonly kind: "document"; readonly document: ValidatedDocument; readonly conversion: NativeConversionPorts }
  | { readonly kind: "state"; readonly state: Uint8Array }
  | { readonly kind: "stored-script"; readonly state: Uint8Array };

export interface NativeSessionOptions extends NativeSizeOptions {
  readonly actor: string;
  readonly sanitize: MigratePorts["sanitize"];
  readonly noticeJournal?: true | NativePendingEditsData;
}

type CloseReason = "requested" | "failed";

export type NativeSessionChange =
  | { readonly kind: "changed" }
  | { readonly kind: "size"; readonly state: NativeSessionSize }
  | { readonly kind: "closed"; readonly reason: CloseReason; readonly state: Uint8Array };

type ChangeListener = (change: NativeSessionChange) => void;

type CaptureGroup =
  | { readonly kind: "typing"; readonly target: NativeTextTarget; readonly endsInSpace: boolean }
  | { readonly kind: "deletion"; readonly target: NativeTextTarget; readonly direction: -1 | 1; readonly at: number; readonly caret: Y.RelativePosition };

type PresenceSide = NonNullable<PresenceLocation["side"]>;

function presencePointOf(position: Y.RelativePosition | null): PresencePoint | null {
  const json: unknown = position && Y.relativePositionToJSON(position);
  if (!json || typeof json !== "object") return null;
  const { type, item, tname, assoc } = json as { type?: Y.ID; item?: Y.ID; tname?: string; assoc?: number };
  if (!type || tname !== undefined || (assoc !== 0 && assoc !== -1)) return null;
  return Object.freeze({
    type: Object.freeze({ client: type.client, clock: type.clock }),
    item: item ? Object.freeze({ client: item.client, clock: item.clock }) : null,
    assoc
  });
}

const DELETE_PAUSE_MS = 1000;
const COMPOUND_RANGE_REFUSAL = Object.freeze({ kind: "refused", reason: "range" } as const);

function applyStoredState(doc: Y.Doc, bytes: Uint8Array): void {
  Y.applyUpdate(doc, bytes);
  if (!Y.snapshotContainsUpdate(Y.snapshot(doc), bytes)) {
    throw new Error("The stored state is missing a Yjs update");
  }
}

export function hasNativeFormat(bytes: Uint8Array): boolean {
  const doc = new Y.Doc();
  try {
    const meta = doc.getMap("meta");
    applyStoredState(doc, bytes);
    return typeof meta.get("format") === "number" && meta.get("title") instanceof Y.Text
      && doc.getMap("births").size > 0;
  } catch {
    return false;
  } finally { doc.destroy(); }
}

function openSessionScript(
  source: NativeSessionSource,
  sizeOptions: ReturnType<typeof resolveNativeSizeOptions>,
  updated: (update: Uint8Array, transaction: Y.Transaction) => void,
  publishRecovery: () => void,
  sizeRefusal: NonNullable<NativeScript["sizeRefusal"]>,
  saved?: NativeSessionOptions["noticeJournal"],
  onJournalChange?: () => void
) {
  const doc = new Y.Doc(), script = openNativeScript(doc);
  try {
    if (source.kind === "stored-script") applyStoredState(doc, source.state);
    else if (source.kind === "state") Y.applyUpdate(doc, source.state);
    else if (source.kind === "document") convertToNativeScript(script, source.document, source.conversion);
    const journal = saved ? openNativePendingEdits(script.reader, saved === true ? undefined : saved, onJournalChange) : null;
    const size = createNativeSizeTracker(doc, sizeOptions, publishRecovery);
    const undo = openNativeUndo({ ...script, sizeRefusal });
    const { guardSharedCallback } = script;
    const publishUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) =>
      guardSharedCallback(() => updated(update, transaction));
    doc.on("update", publishUpdate);
    return { script, size, undo, publishUpdate, journal };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

export function openNativeSession(source: NativeSessionSource, options: NativeSessionOptions) {
  const sizeOptions = resolveNativeSizeOptions(options);
  const { actor, sanitize } = options;
  const listeners = new Set<ChangeListener>();
  const localUpdates = new Set<(update: Uint8Array) => void>();
  const journalListeners = new Set<() => void>();
  const commandSettledListeners = new Set<() => void>();
  let caretObservers: Set<(transaction: Y.Transaction) => void> | undefined;
  const body = { sanitize };
  let active = false, runningCommand = false, scheduled = false, publishing = false, changed = false, holds = 0;
  let closing: CloseReason | null = null, revision = 0, peerRevision = 0;
  let group: CaptureGroup | null = null;
  function notifySet(subscribers: ReadonlySet<() => void>): void {
    for (const listener of [...subscribers]) {
      try { listener(); } catch { continue; }
    }
  }
  const { script, size, undo, publishUpdate, journal } = openSessionScript(
    source, sizeOptions, updated, schedule, sizeRefusal, options.noticeJournal, () => notifySet(journalListeners)
  );
  const doc = script.doc;
  let reportedSize: NativeSessionSize = size.state;
  const writing = { ...script, sizeRefusal };
  const adding = { ...script, sizeRefusal: () => sizeRefusal(true) };
  const compoundWriting = { ...writing, closed: () => closing !== null || script.closed() };

  function schedule(): void {
    if (scheduled) return;
    // why: only after the stack unwinds can a busy flag distinguish interrupted cleanup from an active transaction
    queueMicrotask(publish);
    scheduled = true;
  }

  function updated(update: Uint8Array, transaction: Y.Transaction): void {
    // why: successive peer updates can remove and restore a caret before publication's microtask
    caretObservers?.forEach(observe => script.guardSharedCallback(() => observe(transaction)));
    if (!transaction.local) {
      peerRevision = revision + 1;
      journal?.peer();
    }
    revision++;
    changed = true;
    size.recordUpdate(update.byteLength, transaction.deleteSet.clients.size > 0);
    schedule();
    if (transaction.local && localUpdates.size) {
      for (const listener of [...localUpdates]) {
        try { listener(update.slice()); } catch { continue; }
      }
    }
  }

  function emit(subscribers: ReadonlySet<ChangeListener>, change: NativeSessionChange): void {
    for (const listener of [...subscribers]) {
      // why: one failed subscriber must not interrupt delivery to the others
      try { listener(change); } catch { continue; }
    }
  }

  function publish(): void {
    scheduled = false;
    publishing = true;
    if (changed) {
      changed = false;
      emit(listeners, { kind: "changed" });
    }
    if (!scheduled && size.state !== reportedSize) {
      reportedSize = size.state;
      emit(listeners, { kind: "size", state: reportedSize });
    }
    if (script.busy()) requestClose("failed");
    publishing = false;
    if (closing && !scheduled) finishClose(closing);
  }

  function finishClose(reason: CloseReason): void {
    const state = Y.encodeStateAsUpdate(doc);
    doc.off("update", publishUpdate);
    caretObservers?.clear();
    caretObservers = undefined;
    undo.destroy();
    script.close();
    try { doc.destroy(); } catch {
      // why: an external destroy listener must not prevent the terminal state from reaching subscribers
    }
    emit(listeners, { kind: "closed", reason, state });
    listeners.clear();
    localUpdates.clear();
    journalListeners.clear();
    commandSettledListeners.clear();
  }

  function perform<T>(run: () => T): T {
    active = true;
    try { return run(); } finally {
      active = false;
      if (script.busy()) requestClose("failed");
    }
  }

  function requestClose(reason: CloseReason): void {
    closing = reason;
    size.stopRecovery();
    if (!publishing) schedule();
  }

  function refusal(): "busy" | "closed" | null {
    if (active || holds) return "busy";
    if (closing) return "closed";
    if (!script.busy()) return null;
    schedule();
    return "busy";
  }

  function sizeRefusal(adds = false): "full" | null {
    if (adds && size.state === "full") {
      if (size.checkRecovery()) schedule();
      if (size.state === "full") return "full";
    }
    return size.atCeiling ? "full" : null;
  }

  function endTypingGroup(): void {
    if (refusal()) return;
    group = null;
    undo.stopCapturing();
  }

  function bindCommand<Args extends unknown[], Result extends { readonly created?: string; readonly kind: string }>(
    command: (script: NativeScript, ...args: Args) => Result, commandScript: NativeScript, separate: boolean,
    journalMode: "none" | "edit" | "split", selectionRefusal?: () => Result
  ) {
    function run(args: Args, capture?: (write: (prepareWrite: () => boolean) => Result) => Result): Result {
      const reason = refusal();
      if (reason) {
        // why: reentry during argument copying must keep each command's own refusal shape
        return command({ ...script, busy: () => reason === "busy", closed: () => reason === "closed" }, ...args);
      }
      return perform(() => {
        if (separate) {
          group = null;
          undo.stopCapturing();
        }
        if (journalMode !== "none") journal?.sync();
        if (journalMode !== "none") runningCommand = true;
        let synced = false;
        try {
          const result = capture ? capture(prepareWrite => {
            if (!selectionRefusal) return command({ ...commandScript, prepareWrite }, ...args);
            return withNativeCommand(commandScript, prepareWrite) ? command(commandScript, ...args) : selectionRefusal();
          })
            : command(commandScript, ...args);
          if (journalMode !== "none") {
            synced = true;
            journal?.sync(result.created ? { created: result.created, split: journalMode === "split" } : {});
          }
          return result;
        } finally {
          if (journalMode !== "none") {
            if (!synced) {
              try { journal?.sync({}); } catch {
                // why: journal sync must not mask the command failure that triggered close
              }
            }
            runningCommand = false;
            notifySet(commandSettledListeners);
          }
        }
      });
    }
    return {
      run: (...args: Args) => run(args),
      withSelection(before: NativeUndoSelectionInput | null, ...args: Args) {
        let finish: ((after?: NativeUndoSelectionInput | null) => void) | undefined;
        const result = run(args, write => {
          const recorded = undo.captureSelection(before, write, selectionRefusal !== undefined);
          finish = recorded.recordAfter;
          return recorded.result;
        });
        return Object.freeze({
          result,
          recordAfter(after?: NativeUndoSelectionInput | null): void {
            const record = finish;
            if (record && !refusal()) perform(() => record(after));
          }
        });
      }
    };
  }

  function bind<Args extends unknown[], Result extends { readonly created?: string; readonly kind: string }>(
    command: (script: NativeScript, ...args: Args) => Result, commandScript: NativeScript, separate = true,
    journalMode: "edit" | "split" = "edit", selectionRefusal?: () => Result
  ) {
    const { run, withSelection } = bindCommand(command, commandScript, separate, journalMode, selectionRefusal);
    return Object.freeze(Object.assign(run, { withSelection }));
  }

  function bindCompound<Args extends unknown[], Result extends { readonly created?: string; readonly kind: string }>(
    command: (script: NativeScript, ...args: Args) => Result, journalMode: "edit" | "split" = "edit"
  ) {
    return bind<Args, Result | typeof COMPOUND_RANGE_REFUSAL>(command, compoundWriting, true, journalMode, () => COMPOUND_RANGE_REFUSAL);
  }

  function press(direction: "undo" | "redo"): NativeUndoOutcome {
    const reason = refusal();
    if (reason) return { kind: "refused", reason };
    return perform(() => {
      group = null;
      journal?.sync();
      runningCommand = true;
      let synced = false;
      try {
        const result = undo[direction]();
        synced = true;
        journal?.sync({ press: direction });
        return result;
      } finally {
        if (!synced) {
          try { journal?.sync({ press: direction }); } catch {
            // why: journal sync must not mask the command failure that triggered close
          }
        }
        runningCommand = false;
        notifySet(commandSettledListeners);
      }
    });
  }

  function beforeTyping(target: NativeTextTarget, text: string): void {
    const previous = group?.kind === "typing" && group.target.beat === target.beat && group.target.cell === target.cell ? group : null;
    if (!previous || !continuesSharedTypingWord(previous.endsInSpace, text)) undo.stopCapturing();
    group = { kind: "typing", target, endsInSpace: text ? /\s$/.test(text) : previous?.endsInSpace ?? false };
  }

  function beforeDeletion(target: NativeTextTarget, live: NativeLiveRange, direction: -1 | 1, at: number): void {
    const previous = group?.kind === "deletion" && group.target.beat === target.beat && group.target.cell === target.cell
      && group.direction === direction && at - group.at < DELETE_PAUSE_MS ? group : null;
    const caret = previous && Y.createAbsolutePositionFromRelativePosition(previous.caret, doc);
    const edge = direction === -1 ? live.pieces.at(-1) ?? live : live;
    if (!caret || caret.type !== edge.text || caret.index !== (direction === -1 ? edge.until : edge.from)) undo.stopCapturing();
    group = { kind: "deletion", target, direction, at, caret: Y.createRelativePositionFromTypeIndex(live.text, live.from, -1) };
  }

  function presenceVisual(row: string) {
    const text = script.roots.visuals.get(row);
    if (!script.reader.beatBoundary(row) || !(text instanceof Y.Text)) return null;
    return { text, view: nativeCellView(script.reader.visualItems(row)) };
  }

  const commands = Object.freeze({
    createFirstBeat: bindCompound(createFirstNativeBeat),
    insertAdjacentBeat: bindCompound(insertNativeBeatAdjacent),
    anchorText: bindCommand(anchorNativeText, script, false, "none").run,
    typeText: bind((script: NativeScript, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp, placement?: NativeTextPlacement) =>
      typeNativeText(script, range, text, marks, stamp, target => beforeTyping(target, text), undo.typingRecorder, placement), writing, false),
    replaceText: bind((script: NativeScript, range: NativeTextRange, runs: readonly Run[], stamp?: NativeEditStamp, placement?: NativeTextPlacement) =>
      replaceNativeText(script, range, runs, stamp, undefined, undefined, undefined, placement), writing),
    replaceAll: bindCompound(replaceAllNativeText),
    deleteText: bind(deleteNativeText, writing),
    deleteTextInRun: bind((script: NativeScript, range: NativeTextRange, direction: -1 | 1, at: number,
      stamp?: NativeEditStamp, placement?: NativeTextPlacement) => replaceNativeText(script, range, [], stamp,
      (target, live) => beforeDeletion(target, live, direction, at), false, undefined, placement), writing, false),
    typeTitle: bind((script: NativeScript, range: NativeTextRange, text: string, placement?: NativeTextPlacement) =>
      editNativeTitle(script, range, text, target => beforeTyping(target, text), text !== "", undo.typingRecorder, placement), writing, false),
    replaceTitle: bind((script: NativeScript, range: NativeTextRange, text: string, placement?: NativeTextPlacement) =>
      editNativeTitle(script, range, text, undefined, undefined, undefined, placement), writing),
    deleteTitle: bind((script: NativeScript, range: NativeTextRange, placement?: NativeTextPlacement) =>
      editNativeTitle(script, range, "", undefined, false, undefined, placement), writing),
    deleteTitleInRun: bind((script: NativeScript, range: NativeTextRange, direction: -1 | 1, at: number, placement?: NativeTextPlacement) =>
      editNativeTitle(script, range, "", (target, live) => beforeDeletion(target, live, direction, at), false, undefined, placement), writing, false),
    formatText: bind(formatNativeText, adding),
    formatCue: bind(formatNativeCue, adding),
    labelVisual: bind(labelNativeVisual, adding),
    splitRow: bind(splitNativeRow, adding, true, "split"),
    deleteAndSplit: bindCompound(deleteAndSplitNativeRow, "split"),
    putBack: bind(putBackNativeBeat, adding),
    joinRow: bind(joinNativeRow, adding),
    unjoinRow: bind(unjoinNativeRow, writing),
    removeRows: bind(removeNativeRows, writing),
    createHeading: bind(createNativeHeading, adding),
    finalizeHeading: bind(finalizeNativeHeading, adding),
    renameHeading: bind(renameNativeHeading, writing),
    removeHeading: bind(removeNativeHeading, writing),
    restoreHeading: bind(restoreNativeHeading, adding),
    moveBlocks: bind(moveNativeBlocks, adding),
    setField: bind(setNativeField, writing),
    clearField: bind(clearNativeField, writing),
    changeRegistry: bind(changeNativeRegistry, writing),
    closeBroll: bind(closeNativeBroll, adding),
    createComment: bind((script, comment: NativeNewComment) => createNativeComment(script, comment, body), adding),
    createReply: bind((script, comment: string, reply: NativeNewReply) => createNativeReply(script, comment, reply, body), adding),
    setCommentBody: bind((script, target: NativeCommentTarget, html: string) => setNativeCommentBody(script, target, actor, html, body), adding),
    resolveComment: bind(resolveNativeComment, adding),
    reopenComment: bind(reopenNativeComment, adding),
    removeComment: bind(removeNativeComment, writing),
    undo: () => press("undo"),
    redo: () => press("redo")
  });

  return Object.freeze({
    commands,
    endTypingGroup,
    endDeletionGroup: () => { if (group?.kind === "deletion") endTypingGroup(); },
    // why: peers apply updates directly between commands. Applying one from a transaction listener is unsupported
    // because Yjs can fold it into local undo
    ydoc: doc,
    isClosingOrClosed: () => closing !== null,
    checkPeerDelivery(): boolean {
      if (!script.busy()) return true;
      schedule();
      return false;
    },
    get size(): NativeSessionSize { return reportedSize; },
    sizeLimits: sizeOptions.limits,
    document: (joinedNarration?: Parameters<typeof script.reader.document>[0]) => script.reader.document(joinedNarration),
    tagGroup: (id: string) => script.reader.tagGroup(id),
    brollClaimState: (id: string) => script.reader.brollClaims().get(id)?.state,
    shotAlternatives: () => script.reader.shotAlternatives(),
    pictureReferences: () => script.reader.pictureReferences(),
    revision: () => revision,
    peerRevision: () => peerRevision,
    captureTextIdentity: (range: NativeTextRange) => {
      if (refusal()) return null;
      const intact = captureNativeTextIdentity(script, range);
      const capturedAt = revision;
      return intact && (() => !refusal() && (capturedAt === revision || intact()));
    },
    captureCompositionCaret: (range: NativeTextRange) => refusal() ? null : captureNativeCompositionCaret(script, range, observe => {
      const observers = caretObservers ??= new Set();
      observers.add(observe);
      return () => {
        observers.delete(observe);
        if (observers === caretObservers && !observers.size) caretObservers = undefined;
      };
    }),
    resolveTextSelection: (range: NativeTextRange) => { const anchor = snapshotNativeUndoAnchor(script, range); return anchor && resolveNativeUndoSelection(script, anchor); },
    narrationCaret: (row: string, offset: number, right?: boolean) => script.reader.narrationCaret(row, offset, right),
    readBeat: (beat: string) => script.reader.noticeBeat(beat),
    historyOutline() {
      const reader = script.reader;
      const { placements } = nativeBeatPlacements(reader);
      return reader.outline().flatMap<{ heading: string } | { beat: OfflineSavedBeat }>(entry => {
        if (entry.kind === "heading") return [{ heading: entry.name }];
        return (reader.row(entry.id)?.members ?? []).flatMap(id => {
          const beat = reader.noticeBeat(id), placement = placements.get(id);
          return beat && placement ? [{ beat: { ...beat, placement } }] : [];
        });
      });
    },
    readRow: (row: string) => script.reader.row(row),
    narrationHtml: (row: string) => script.reader.row(row)?.audioText,
    hasBeatMarker: (beat: string) => script.reader.hasBeatMarker(beat),
    narrationOffset: (row: string, range: Pick<NativeTextRange, "from">, assoc: 0 | -1 = 0) => {
      if (refusal()) return null;
      return perform(() => {
        try {
          const position = resolveNativeTextPoint(script, range.from, assoc);
          return position ? script.reader.narrationOffset(row, position) : null;
        } catch { return null; }
      });
    },
    trackNarrationPaint: (row: string) => {
      let retained: ReturnType<typeof script.reader.narrationPaint> | null = null;
      const dispose = beforeNativeWrite(script, () => { retained ??= script.reader.narrationPaint(row, true); });
      return {
        point: (offset: number, assoc: 0 | -1) => (retained ?? script.reader.narrationPaint(row, false))(offset, assoc),
        dispose
      };
    },
    trackVisualPeerSelection: (row: string, read: () => { readonly anchor: number; readonly head: number } | null) => {
      let paintedPeerRevision = peerRevision;
      let retained: readonly [Y.RelativePosition, Y.RelativePosition] | null = null;
      const capture = (transaction: Y.Transaction): void => {
        if (transaction.local || peerRevision !== paintedPeerRevision) return;
        script.guardSharedCallback(() => {
          retained = null;
          const selection = read(), visual = selection && presenceVisual(row);
          if (!selection || !visual || Math.max(selection.anchor, selection.head) > visual.view.length) return;
          const at = (offset: number, assoc: 0 | -1) =>
            Y.createRelativePositionFromTypeIndex(visual.text, nativeStoredOffset(visual.view, offset), assoc);
          const anchor = at(selection.anchor, selection.anchor < selection.head ? 0 : -1);
          const head = selection.anchor === selection.head ? anchor : at(selection.head, selection.head < selection.anchor ? 0 : -1);
          retained = [anchor, head];
        });
      };
      doc.on("beforeTransaction", capture);
      return {
        take() {
          const positions = retained;
          retained = null;
          paintedPeerRevision = peerRevision;
          const visual = positions && presenceVisual(row);
          if (!positions || !visual) return null;
          const offset = (point: Y.RelativePosition) => {
            const at = Y.createAbsolutePositionFromRelativePosition(point, doc);
            return at?.type === visual.text ? visual.view.ends.filter(end => end <= at.index).length : null;
          };
          const anchor = offset(positions[0]), head = offset(positions[1]);
          return anchor === null || head === null ? null : { anchor, head };
        },
        dispose: () => { doc.off("beforeTransaction", capture); }
      };
    },
    titleOffset: (range: Pick<NativeTextRange, "from">, assoc: 0 | -1 = 0) => {
      if (refusal()) return null;
      return perform(() => {
        try {
          const title = script.roots.meta.get("title");
          if (!(title instanceof Y.Text)) return null;
          const position = resolveNativeTextPoint(script, range.from, assoc);
          return position && position.type === title && position.index >= 0 && position.index <= title.length ? position.index : null;
        } catch { return null; }
      });
    },
    presencePoint: (row: string, side: PresenceSide, offset: number, assoc: 0 | -1): PresencePoint | null => {
      if (refusal() || !Number.isSafeInteger(offset) || offset < 0) return null;
      return perform(() => {
        try {
          if (side === "audioText") return presencePointOf(script.reader.narrationPaint(row, false)(offset, assoc));
          const visual = presenceVisual(row);
          if (!visual || offset > visual.view.length) return null;
          return presencePointOf(Y.createRelativePositionFromTypeIndex(visual.text, nativeStoredOffset(visual.view, offset), assoc));
        } catch { return null; }
      });
    },
    presenceOffset: (row: string, side: PresenceSide, point: PresencePoint): number | null => {
      if (refusal()) return null;
      return perform(() => {
        try {
          const position = resolveNativeTextPoint(script, point, point.assoc);
          if (!position) return null;
          if (side === "audioText") return script.reader.narrationOffset(row, position);
          const visual = presenceVisual(row);
          return visual && position.type === visual.text ? visual.view.ends.filter(unit => unit <= position.index).length : null;
        } catch { return null; }
      });
    },
    trackTitlePaint: () => {
      let retained: ((offset: number, assoc: 0 | -1) => Y.RelativePosition | null) | null = null;
      const capture = (retain: boolean) => {
        const title = script.roots.meta.get("title");
        if (!(title instanceof Y.Text)) return () => null;
        const length = title.length;
        if (!retain) return (offset: number, assoc: 0 | -1) =>
          offset >= 0 && offset <= length ? Y.createRelativePositionFromTypeIndex(title, offset, assoc) : null;
        const starts = new Map<number, Y.RelativePosition>(), ends = new Map<number, Y.RelativePosition>();
        for (let unit = 0; unit <= length; unit++) {
          starts.set(unit, Y.createRelativePositionFromTypeIndex(title, unit, 0));
          ends.set(unit, Y.createRelativePositionFromTypeIndex(title, unit, -1));
        }
        return (offset: number, assoc: 0 | -1) => (assoc === 0 ? starts : ends).get(offset) ?? null;
      };
      const dispose = beforeNativeWrite(script, () => { retained ??= capture(true); });
      return {
        point: (offset: number, assoc: 0 | -1) => (retained ?? capture(false))(offset, assoc),
        dispose
      };
    },
    isStoredScript: () => script.roots.meta.get("format") === NATIVE_FORMAT_VERSION
      && script.roots.meta.get("title") instanceof Y.Text && script.roots.births.size > 0
      && !!script.reader.document().docId && !script.reader.problems().some(({ kind }) =>
        ["bad-value", "bad-key", "no-text", "no-segment", "no-order", "unknown-embed"].includes(kind)),
    holdIngress: () => {
      holds++;
      let held = true;
      return () => { if (held) { held = false; holds--; } };
    },
    acceptsPeerUpdate: () => refusal() === null,
    inCommand: () => runningCommand,
    encodeState: () => Y.encodeStateAsUpdate(doc),
    pendingEdits: journal && Object.freeze({
      data: journal.data, confirmationPoint: journal.confirmationPoint, clearThrough: journal.clearThrough,
      revision: journal.revision, through: journal.through, hasPending: journal.hasPending,
      hasPendingThrough: journal.hasPendingThrough,
      subscribe(listener: () => void): () => void {
        if (closing) return () => undefined;
        journalListeners.add(listener);
        return () => { journalListeners.delete(listener); };
      }
    }),
    offlineNotice: (connection: "returning" | "online") =>
      connection === "returning" && journal ? compareNativeOfflineNotice(journal.pending(), script.reader) : [],
    subscribe(listener: ChangeListener): () => void {
      if (closing) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeLocalUpdates(listener: (update: Uint8Array) => void): () => void {
      if (closing) return () => undefined;
      localUpdates.add(listener);
      return () => { localUpdates.delete(listener); };
    },
    subscribeCommandSettled(listener: () => void): () => void {
      if (closing) return () => undefined;
      commandSettledListeners.add(listener);
      return () => { commandSettledListeners.delete(listener); };
    },
    close(): void {
      if (closing) return;
      requestClose("requested");
    }
  });
}
