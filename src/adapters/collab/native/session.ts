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
import { openNativeScript, throwNativeFailures } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { createNativeSizeTracker, FULL_REFUSAL, fullRecovery, resolveNativeSizeLimits } from "./size.ts";
import type { NativeSessionSize, NativeSizeRecovery, NativeSizeRefusal } from "./size.ts";
import { joinNativeRow, removeNativeRows, splitNativeRow, unjoinNativeRow } from "./structure-commands.ts";
import { anchorNativeText, deleteNativeText, replaceNativeText, typeNativeText } from "./text-commands.ts";
import type { NativeEditStamp, NativeTextRange, NativeTextTarget } from "./text-commands.ts";
import { openNativeUndo } from "./undo-commands.ts";
import type { NativeUndoOutcome } from "./undo-commands.ts";

export type NativeSessionSource =
  | { readonly kind: "empty" }
  | { readonly kind: "document"; readonly document: ValidatedDocument; readonly conversion: NativeConversionPorts }
  | { readonly kind: "state"; readonly state: Uint8Array };

export interface NativeSessionOptions {
  readonly actor: string;
  readonly sanitize: MigratePorts["sanitize"];
  readonly sizeLimit?: number;
  readonly sizeWarning?: number;
}

type CloseReason = "requested" | "failed";

export type NativeSessionChange =
  | { readonly kind: "changed" }
  | { readonly kind: "size"; readonly state: NativeSessionSize }
  | { readonly kind: "closed"; readonly reason: CloseReason; readonly state: Uint8Array };

type ChangeListener = (change: NativeSessionChange) => void;

interface FullPolicy<Args extends unknown[], Full> {
  readonly adds?: (...args: Args) => boolean;
  readonly refuse: (...args: Args) => Full;
}

const REFUSE_FULL = Object.freeze({ refuse: () => FULL_REFUSAL });
const TYPE_FULL: FullPolicy<[NativeTextRange, string, Marks, (NativeEditStamp | undefined)?], NativeSizeRecovery> = Object.freeze({
  adds: (_range: NativeTextRange, text: string) => typeof text !== "string" || text.length > 0,
  refuse: (_range: NativeTextRange, text: string, marks: Marks) => fullRecovery(text ? [{ text, marks }] : [])
});
const REPLACE_FULL: FullPolicy<[NativeTextRange, readonly Run[], (NativeEditStamp | undefined)?], NativeSizeRecovery> = Object.freeze({
  adds: (_range: NativeTextRange, runs: readonly Run[]) => !Array.isArray(runs) || runs.length > 0,
  refuse: (_range: NativeTextRange, runs: readonly Run[]) => fullRecovery(runs)
});
const RENAME_FULL: FullPolicy<[NativeTextRange, string], NativeSizeRefusal> = Object.freeze({
  adds: (_range: NativeTextRange, name: string) => typeof name !== "string" || name.length > 0,
  refuse: () => FULL_REFUSAL
});

function openSessionScript(source: NativeSessionSource, updated: (update: Uint8Array, transaction: Y.Transaction) => void) {
  const doc = new Y.Doc(), script = openNativeScript(doc);
  try {
    if (source.kind === "state") Y.applyUpdate(doc, source.state);
    if (source.kind === "document") convertToNativeScript(script, source.document, source.conversion);
    const undo = openNativeUndo(script);
    const { guardSharedCallback } = script;
    const publishUpdate = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) =>
      guardSharedCallback(() => updated(update, transaction));
    doc.on("update", publishUpdate);
    return { script, undo, publishUpdate };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

export function openNativeSession(source: NativeSessionSource, { actor, sanitize, sizeLimit, sizeWarning }: NativeSessionOptions) {
  const limits = resolveNativeSizeLimits(sizeLimit, sizeWarning);
  const listeners = new Set<ChangeListener>();
  const body = { sanitize };
  let active = false, scheduled = false, publishing = false, changed = false;
  let closing: CloseReason | null = null;
  let typing: { readonly target: NativeTextTarget; readonly endsInSpace: boolean } | null = null;
  const { script, undo, publishUpdate } = openSessionScript(source, updated), doc = script.doc;
  const size = createNativeSizeTracker(doc, limits);
  let reportedSize: NativeSessionSize = size.state;

  function schedule(): void {
    if (scheduled) return;
    // why: only after the stack unwinds can a busy flag distinguish interrupted cleanup from an active transaction
    queueMicrotask(publish);
    scheduled = true;
  }

  function updated(update: Uint8Array, transaction: Y.Transaction): void {
    changed = true;
    size.recordUpdate(update.byteLength, transaction, active);
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
    publishing = false;
    if (script.busy()) closing = "failed";
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
    if (!publishing) schedule();
  }

  function refusal(): "busy" | "closed" | null {
    if (active) return "busy";
    if (closing) return "closed";
    if (!script.busy()) return null;
    schedule();
    return "busy";
  }

  function fullForAdd(): boolean {
    if (!size.mayBeFull()) return false;
    throwNativeFailures(script);
    if (script.closed() || script.reader.isClosed()) return false;
    const full = size.isFullForAdd();
    if (size.state !== reportedSize) schedule();
    return full;
  }

  function bind<Args extends unknown[], Result, Full = never>(
    command: (script: NativeScript, ...args: Args) => Result,
    separate = true,
    onFull?: { readonly adds?: (...args: NoInfer<Args>) => boolean; readonly refuse: (...args: NoInfer<Args>) => Full }
  ) {
    return (...args: Args): Result | Full => {
      const reason = refusal();
      if (reason) {
        // why: reentry during argument copying must keep each command's own refusal shape
        return command({ ...script, busy: () => reason === "busy", closed: () => reason === "closed" }, ...args);
      }
      if (onFull && (!onFull.adds || onFull.adds(...args)) && fullForAdd()) return onFull.refuse(...args);
      return perform(() => {
        if (separate) {
          typing = null;
          undo.stopCapturing();
        }
        return command(script, ...args);
      });
    };
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
    anchorText: bind(anchorNativeText, false),
    typeText: bind((script: NativeScript, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp) =>
      typeNativeText(script, range, text, marks, stamp, target => {
        const previous = typing?.target.beat === target.beat && typing.target.cell === target.cell ? typing : null;
        if (!previous || !continuesSharedTypingWord(previous.endsInSpace, text)) undo.stopCapturing();
        typing = { target, endsInSpace: text ? /\s$/.test(text) : previous?.endsInSpace ?? false };
      }), false, TYPE_FULL),
    replaceText: bind((script: NativeScript, ...args: [NativeTextRange, Parameters<typeof replaceNativeText>[2], NativeEditStamp?]) =>
      replaceNativeText(script, ...args), true, REPLACE_FULL),
    deleteText: bind(deleteNativeText),
    formatText: bind(formatNativeText, true, REFUSE_FULL),
    splitRow: bind(splitNativeRow, true, REFUSE_FULL),
    joinRow: bind(joinNativeRow, true, REFUSE_FULL),
    unjoinRow: bind(unjoinNativeRow),
    removeRows: bind(removeNativeRows),
    createHeading: bind(createNativeHeading, true, REFUSE_FULL),
    renameHeading: bind(renameNativeHeading, true, RENAME_FULL),
    removeHeading: bind(removeNativeHeading),
    restoreHeading: bind(restoreNativeHeading, true, REFUSE_FULL),
    moveBlocks: bind(moveNativeBlocks, true, REFUSE_FULL),
    setField: bind(setNativeField, true, REFUSE_FULL),
    clearField: bind(clearNativeField),
    createComment: bind((script, comment: NativeNewComment) => createNativeComment(script, comment, body), true, REFUSE_FULL),
    createReply: bind((script, comment: string, reply: NativeNewReply) => createNativeReply(script, comment, reply, body), true, REFUSE_FULL),
    setCommentBody: bind((script, target: NativeCommentTarget, html: string) => setNativeCommentBody(script, target, actor, html, body), true, REFUSE_FULL),
    resolveComment: bind(resolveNativeComment, true, REFUSE_FULL),
    reopenComment: bind(reopenNativeComment, true, REFUSE_FULL),
    removeComment: bind(removeNativeComment),
    undo: () => press("undo"),
    redo: () => press("redo")
  });

  return Object.freeze({
    commands,
    // why: peers apply updates directly between commands. Applying one from a transaction listener is unsupported
    // because Yjs can fold it into local undo
    ydoc: doc,
    isClosingOrClosed: () => closing !== null,
    checkPeerDelivery(): boolean {
      if (!script.busy()) return true;
      schedule();
      return false;
    },
    get size(): NativeSessionSize { return size.state; },
    sizeLimits: limits,
    document: () => script.reader.document(),
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
