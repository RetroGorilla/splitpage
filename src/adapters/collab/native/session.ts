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
import { formatNativeText } from "./format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "./heading-commands.ts";
import { createFirstNativeBeat, putBackNativeBeat } from "./insert-commands.ts";
import { compareNativeOfflineNotice } from "./offline-notice.ts";
import { openNativePendingEdits } from "./pending-edits.ts";
import type { NativePendingEditsData } from "./pending-edits.ts";
import { moveNativeBlocks } from "./move-commands.ts";
import { clearNativeField, setNativeField } from "./record-commands.ts";
import { changeNativeRegistry } from "./registry-commands.ts";
import { beforeNativeWrite, openNativeScript, withNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { createNativeSizeTracker, resolveNativeSizeOptions } from "./size.ts";
import type { NativeSessionSize, NativeSizeOptions } from "./size.ts";
import { deleteAndSplitNativeRow, joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "./structure-commands.ts";
import { anchorNativeText, deleteNativeText, replaceNativeText, resolveNativeTextPoint, typeNativeText } from "./text-commands.ts";
import type { NativeEditStamp, NativeTextPlacement, NativeTextRange, NativeTextTarget, NativeUndoSelectionInput } from "./text-commands.ts";
import { openNativeUndo } from "./undo-commands.ts";
import type { NativeUndoOutcome } from "./undo-commands.ts";
import { NATIVE_FORMAT_VERSION } from "./roots.ts";

export type NativeSessionSource =
  | { readonly kind: "empty" }
  | { readonly kind: "document"; readonly document: ValidatedDocument; readonly conversion: NativeConversionPorts }
  | { readonly kind: "state"; readonly state: Uint8Array };

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
const COMPOUND_RANGE_REFUSAL = Object.freeze({ kind: "refused", reason: "range" } as const);

export function hasNativeFormat(bytes: Uint8Array): boolean {
  const doc = new Y.Doc();
  try {
    const meta = doc.getMap("meta");
    Y.applyUpdate(doc, bytes);
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
  saved?: NativeSessionOptions["noticeJournal"]
) {
  const doc = new Y.Doc(), script = openNativeScript(doc);
  try {
    if (source.kind === "state") Y.applyUpdate(doc, source.state);
    if (source.kind === "document") convertToNativeScript(script, source.document, source.conversion);
    const journal = saved ? openNativePendingEdits(script.reader, saved === true ? undefined : saved) : null;
    const size = createNativeSizeTracker(doc, sizeOptions, publishRecovery);
    const undo = openNativeUndo({ ...script, sizeRefusal });
    const { guardSharedCallback } = script;
    const publishUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) =>
      guardSharedCallback(() => {
        if (!transaction.local) journal?.peer();
        updated(update, transaction);
      });
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
  const body = { sanitize };
  let active = false, scheduled = false, publishing = false, changed = false, holds = 0;
  let closing: CloseReason | null = null, revision = 0;
  let typing: { readonly target: NativeTextTarget; readonly endsInSpace: boolean } | null = null;
  const { script, size, undo, publishUpdate, journal } = openSessionScript(source, sizeOptions, updated, schedule, sizeRefusal, options.noticeJournal);
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
    revision++;
    changed = true;
    size.recordUpdate(update.byteLength, transaction.deleteSet.clients.size > 0);
    schedule();
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
    undo.destroy();
    script.close();
    try { doc.destroy(); } catch {
      // why: an external destroy listener must not prevent the terminal state from reaching subscribers
    }
    emit(listeners, { kind: "closed", reason, state });
    listeners.clear();
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
    typing = null;
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
          typing = null;
          undo.stopCapturing();
        }
        if (journalMode !== "none") journal?.sync();
        const result = capture ? capture(prepareWrite => {
          if (!selectionRefusal) return command({ ...commandScript, prepareWrite }, ...args);
          return withNativeCommand(commandScript, prepareWrite) ? command(commandScript, ...args) : selectionRefusal();
        })
          : command(commandScript, ...args);
        if (journalMode !== "none") journal?.sync(result.created ? { created: result.created, split: journalMode === "split" } : {});
        return result;
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
    command: (script: NativeScript, ...args: Args) => Result | typeof COMPOUND_RANGE_REFUSAL, journalMode: "edit" | "split" = "edit"
  ) {
    return bind(command, compoundWriting, true, journalMode, () => COMPOUND_RANGE_REFUSAL);
  }

  function press(direction: "undo" | "redo"): NativeUndoOutcome {
    const reason = refusal();
    if (reason) return { kind: "refused", reason };
    return perform(() => {
      typing = null;
      journal?.sync();
      const result = undo[direction]();
      journal?.sync({ press: direction });
      return result;
    });
  }

  const commands = Object.freeze({
    createFirstBeat: bindCompound(createFirstNativeBeat),
    anchorText: bindCommand(anchorNativeText, script, false, "none").run,
    typeText: bind((script: NativeScript, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp, placement?: NativeTextPlacement) =>
      typeNativeText(script, range, text, marks, stamp, target => {
        const previous = typing?.target.beat === target.beat && typing.target.cell === target.cell ? typing : null;
        if (!previous || !continuesSharedTypingWord(previous.endsInSpace, text)) undo.stopCapturing();
        typing = { target, endsInSpace: text ? /\s$/.test(text) : previous?.endsInSpace ?? false };
      }, undo.typingRecorder, placement), writing, false),
    replaceText: bind((script: NativeScript, range: NativeTextRange, runs: readonly Run[], stamp?: NativeEditStamp, placement?: NativeTextPlacement) =>
      replaceNativeText(script, range, runs, stamp, undefined, undefined, undefined, placement), writing),
    deleteText: bind(deleteNativeText, writing),
    formatText: bind(formatNativeText, adding),
    splitRow: bind(splitNativeRow, adding, true, "split"),
    deleteAndSplit: bindCompound(deleteAndSplitNativeRow, "split"),
    putBack: bind(putBackNativeBeat, adding),
    joinRow: bind(joinNativeRow, adding),
    unjoinRow: bind(unjoinNativeRow, writing),
    removeRows: bind(removeNativeRows, writing),
    createHeading: bind(createNativeHeading, adding),
    renameHeading: bind(renameNativeHeading, writing),
    removeHeading: bind(removeNativeHeading, writing),
    restoreHeading: bind(restoreNativeHeading, adding),
    moveBlocks: bind(moveNativeBlocks, adding),
    setField: bind(setNativeField, writing),
    clearField: bind(clearNativeField, writing),
    changeRegistry: bind(changeNativeRegistry, writing),
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
    document: () => script.reader.document(),
    revision: () => revision,
    narrationCaret: (row: string, offset: number, right?: boolean) => script.reader.narrationCaret(row, offset, right),
    narrationHtml: (row: string) => script.reader.row(row)?.audioText,
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
    encodeState: () => Y.encodeStateAsUpdate(doc),
    pendingEdits: journal && Object.freeze({
      data: journal.data, confirmationPoint: journal.confirmationPoint, clearThrough: journal.clearThrough
    }),
    offlineNotice: (connection: "returning" | "online") =>
      connection === "returning" && journal ? compareNativeOfflineNotice(journal.pending(), script.reader) : [],
    subscribe(listener: ChangeListener): () => void {
      if (closing) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close(): void {
      if (closing) return;
      requestClose("requested");
    }
  });
}
