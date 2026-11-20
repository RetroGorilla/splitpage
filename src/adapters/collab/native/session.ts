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
import { moveNativeBlocks } from "./move-commands.ts";
import { clearNativeField, setNativeField } from "./record-commands.ts";
import { changeNativeRegistry } from "./registry-commands.ts";
import { openNativeScript } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { createNativeSizeTracker, resolveNativeSizeOptions } from "./size.ts";
import type { NativeSessionSize, NativeSizeOptions } from "./size.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "./structure-commands.ts";
import { anchorNativeText, deleteNativeText, replaceNativeText, typeNativeText } from "./text-commands.ts";
import type { NativeEditStamp, NativeTextRange, NativeTextTarget, NativeUndoSelectionInput } from "./text-commands.ts";
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
}

type CloseReason = "requested" | "failed";

export type NativeSessionChange =
  | { readonly kind: "changed" }
  | { readonly kind: "size"; readonly state: NativeSessionSize }
  | { readonly kind: "closed"; readonly reason: CloseReason; readonly state: Uint8Array };

type ChangeListener = (change: NativeSessionChange) => void;

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
  sizeRefusal: NonNullable<NativeScript["sizeRefusal"]>
) {
  const doc = new Y.Doc(), script = openNativeScript(doc);
  try {
    if (source.kind === "state") Y.applyUpdate(doc, source.state);
    if (source.kind === "document") convertToNativeScript(script, source.document, source.conversion);
    const size = createNativeSizeTracker(doc, sizeOptions, publishRecovery);
    const undo = openNativeUndo({ ...script, sizeRefusal });
    const { guardSharedCallback } = script;
    const publishUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) =>
      guardSharedCallback(() => updated(update, transaction));
    doc.on("update", publishUpdate);
    return { script, size, undo, publishUpdate };
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
  let closing: CloseReason | null = null;
  let typing: { readonly target: NativeTextTarget; readonly endsInSpace: boolean } | null = null;
  const { script, size, undo, publishUpdate } = openSessionScript(source, sizeOptions, updated, schedule, sizeRefusal), doc = script.doc;
  let reportedSize: NativeSessionSize = size.state;
  const writing = { ...script, sizeRefusal };
  const adding = { ...script, sizeRefusal: () => sizeRefusal(true) };

  function schedule(): void {
    if (scheduled) return;
    // why: only after the stack unwinds can a busy flag distinguish interrupted cleanup from an active transaction
    queueMicrotask(publish);
    scheduled = true;
  }

  function updated(update: Uint8Array, transaction: Y.Transaction): void {
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

  function bindCommand<Args extends unknown[], Result>(
    command: (script: NativeScript, ...args: Args) => Result, commandScript: NativeScript, separate: boolean
  ) {
    function run(args: Args, capture?: (write: (prepareWrite: () => void) => Result) => Result): Result {
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
        return capture ? capture(prepareWrite => command({ ...commandScript, prepareWrite }, ...args)) : command(commandScript, ...args);
      });
    }
    return {
      run: (...args: Args) => run(args),
      withSelection(before: NativeUndoSelectionInput | null, ...args: Args) {
        let finish: ((after?: NativeUndoSelectionInput | null) => void) | undefined;
        const result = run(args, write => {
          const recorded = undo.captureSelection(before, write);
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

  function bind<Args extends unknown[], Result>(
    command: (script: NativeScript, ...args: Args) => Result, commandScript: NativeScript, separate = true
  ) {
    const { run, withSelection } = bindCommand(command, commandScript, separate);
    return Object.freeze(Object.assign(run, { withSelection }));
  }

  function press(direction: "undo" | "redo"): NativeUndoOutcome {
    const reason = refusal();
    if (reason) return { kind: "refused", reason };
    return perform(() => {
      typing = null;
      return undo[direction]();
    });
  }

  const commands = Object.freeze({
    anchorText: bindCommand(anchorNativeText, script, false).run,
    typeText: bind((script: NativeScript, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp) =>
      typeNativeText(script, range, text, marks, stamp, target => {
        const previous = typing?.target.beat === target.beat && typing.target.cell === target.cell ? typing : null;
        if (!previous || !continuesSharedTypingWord(previous.endsInSpace, text)) undo.stopCapturing();
        typing = { target, endsInSpace: text ? /\s$/.test(text) : previous?.endsInSpace ?? false };
      }, undo.typingRecorder), writing, false),
    replaceText: bind((script: NativeScript, range: NativeTextRange, runs: readonly Run[], stamp?: NativeEditStamp) =>
      replaceNativeText(script, range, runs, stamp), writing),
    deleteText: bind(deleteNativeText, writing),
    formatText: bind(formatNativeText, adding),
    splitRow: bind(splitNativeRow, adding),
    joinRow: bind(joinNativeRow, adding),
    unjoinRow: bind(unjoinNativeRow, writing),
    removeRows: bind(removeNativeRows, writing),
    createHeading: bind(createNativeHeading, adding),
    renameHeading: bind(renameNativeHeading, writing),
    removeHeading: bind(removeNativeHeading, writing),
    restoreHeading: bind(restoreNativeHeading, adding),
    moveBlocks: bind(moveNativeBlocks, adding),
    setField: bind(setNativeField, adding),
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
    narrationCaret: (row: string, offset: number) => script.reader.narrationCaret(row, offset),
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
