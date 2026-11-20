import * as Y from "yjs";
import { continuesSharedTypingWord } from "../../../application/editing/undo/shared-undo.ts";
import type { ValidatedDocument } from "../../../core/document/validated.ts";
import type { MigratePorts } from "../../../core/migrate.ts";
import type { Marks } from "../../../core/text/runs.ts";
import {
  createNativeComment, createNativeReply, removeNativeComment, reopenNativeComment, resolveNativeComment, setNativeCommentBody
} from "./comment-commands.ts";
import type { NativeCommentTarget, NativeNewComment, NativeNewReply } from "./comment-commands.ts";
import { convertToNativeScript } from "./convert.ts";
import type { NativeConversionPorts } from "./convert.ts";
import { formatNativeText } from "./format-commands.ts";
import { createNativeHeading, removeNativeHeading, renameNativeHeading, restoreNativeHeading } from "./heading-commands.ts";
import { putBackNativeBeat } from "./insert-commands.ts";
import { moveNativeBlocks } from "./move-commands.ts";
import { compareNativeOfflineNotice } from "./offline-notice.ts";
import { openNativePendingEdits } from "./pending-edits.ts";
import type { NativePendingEditsData } from "./pending-edits.ts";
import { clearNativeField, setNativeField } from "./record-commands.ts";
import { openNativeScript } from "./script.ts";
import type { NativeScript } from "./script.ts";
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
  readonly noticeJournal?: true | NativePendingEditsData;
}

type CloseReason = "requested" | "failed";

export type NativeSessionChange =
  | { readonly kind: "changed" }
  | { readonly kind: "closed"; readonly reason: CloseReason; readonly state: Uint8Array };

type ChangeListener = (change: NativeSessionChange) => void;

function openSessionScript(source: NativeSessionSource, updated: () => void, saved?: NativeSessionOptions["noticeJournal"]) {
  const doc = new Y.Doc(), script = openNativeScript(doc);
  try {
    if (source.kind === "state") Y.applyUpdate(doc, source.state);
    if (source.kind === "document") convertToNativeScript(script, source.document, source.conversion);
    const journal = saved ? openNativePendingEdits(script.reader, saved === true ? undefined : saved) : null;
    const undo = openNativeUndo(script);
    const { guardSharedCallback } = script;
    const publishUpdate = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => guardSharedCallback(() => {
      if (!transaction.local) journal?.peer();
      updated();
    });
    doc.on("update", publishUpdate);
    return { script, undo, publishUpdate, journal };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

export function openNativeSession(source: NativeSessionSource, { actor, sanitize, noticeJournal }: NativeSessionOptions) {
  const listeners = new Set<ChangeListener>();
  const body = { sanitize };
  let active = false, scheduled = false, publishing = false, changed = false;
  let closing: CloseReason | null = null;
  let typing: { readonly target: NativeTextTarget; readonly endsInSpace: boolean } | null = null;
  const { script, undo, publishUpdate, journal } = openSessionScript(source, updated, noticeJournal), doc = script.doc;

  function schedule(): void {
    if (scheduled) return;
    // why: only after the stack unwinds can a busy flag distinguish interrupted cleanup from an active transaction
    queueMicrotask(publish);
    scheduled = true;
  }

  function updated(): void {
    changed = true;
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

  function bind<Args extends unknown[], Result extends { readonly kind: string; readonly created?: string }>(
    command: (script: NativeScript, ...args: Args) => Result, separate = true, journalMode: "none" | "edit" | "split" = "edit"
  ) {
    return (...args: Args): Result => {
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
        const result = command(script, ...args);
        if (journalMode !== "none") {
          journal?.sync(result.created ? { created: result.created, split: journalMode === "split" } : {});
        }
        return result;
      });
    };
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
    anchorText: bind(anchorNativeText, false, "none"),
    typeText: bind((script, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp) =>
      typeNativeText(script, range, text, marks, stamp, target => {
        const previous = typing?.target.beat === target.beat && typing.target.cell === target.cell ? typing : null;
        if (!previous || !continuesSharedTypingWord(previous.endsInSpace, text)) undo.stopCapturing();
        typing = { target, endsInSpace: text ? /\s$/.test(text) : previous?.endsInSpace ?? false };
      }), false),
    replaceText: bind((script, ...args: [NativeTextRange, Parameters<typeof replaceNativeText>[2], NativeEditStamp?]) =>
      replaceNativeText(script, ...args)),
    deleteText: bind(deleteNativeText),
    formatText: bind(formatNativeText),
    splitRow: bind(splitNativeRow, true, "split"),
    putBack: bind(putBackNativeBeat),
    joinRow: bind(joinNativeRow),
    unjoinRow: bind(unjoinNativeRow),
    removeRows: bind(removeNativeRows),
    createHeading: bind(createNativeHeading),
    renameHeading: bind(renameNativeHeading),
    removeHeading: bind(removeNativeHeading),
    restoreHeading: bind(restoreNativeHeading),
    moveBlocks: bind(moveNativeBlocks),
    setField: bind(setNativeField),
    clearField: bind(clearNativeField),
    createComment: bind((script, comment: NativeNewComment) => createNativeComment(script, comment, body)),
    createReply: bind((script, comment: string, reply: NativeNewReply) => createNativeReply(script, comment, reply, body)),
    setCommentBody: bind((script, target: NativeCommentTarget, html: string) => setNativeCommentBody(script, target, actor, html, body)),
    resolveComment: bind(resolveNativeComment),
    reopenComment: bind(reopenNativeComment),
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
    document: () => script.reader.document(),
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
