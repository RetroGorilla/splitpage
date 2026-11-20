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
import { moveNativeBlocks } from "./move-commands.ts";
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
}

export type NativeSessionChange = "changed" | "undo-reset" | "closed";

type ChangeListener = (change: NativeSessionChange) => void;

function openCopy(source: NativeSessionSource, updated: () => void) {
  const doc = new Y.Doc(), script = openNativeScript(doc);
  try {
    if (source.kind === "state") Y.applyUpdate(doc, source.state);
    if (source.kind === "document") convertToNativeScript(script, source.document, source.conversion);
    const undo = openNativeUndo(script);
    // why: reentry during argument copying must keep each command's own refusal shape
    const busyScript: NativeScript = { ...script, busy: () => true };
    doc.on("update", updated);
    return { script, busyScript, undo };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

export function openNativeSession(source: NativeSessionSource, { actor, sanitize }: NativeSessionOptions) {
  const listeners = new Set<ChangeListener>();
  const pendingPeerUpdates: Uint8Array[] = [];
  const peerOrigin = {};
  const body = { sanitize };
  let active = false, closeRequested = false, closed = false, settleScheduled = false;
  let events: NativeSessionChange[] = [];
  let typing: { readonly target: NativeTextTarget; readonly endsInSpace: boolean } | null = null;
  let current = openCopy(source, updated);

  function notify(change: NativeSessionChange): void {
    if (!events.length) queueMicrotask(publish);
    if (events.at(-1) !== change) events.push(change);
  }

  function updated(): void {
    notify("changed");
  }

  function publish(): void {
    const ready = events;
    events = [];
    for (const change of ready) for (const listener of listeners) {
      // why: one failed subscriber must not interrupt delivery to the others
      try { listener(change); } catch { continue; }
    }
    if (closed) listeners.clear();
  }

  function retire(copy: typeof current): void {
    copy.script.doc.off("update", updated);
    copy.undo.destroy();
    copy.script.close();
    copy.script.doc.destroy();
  }

  function recover(): void {
    const old = current;
    current = openCopy({ kind: "state", state: Y.encodeStateAsUpdate(old.script.doc) }, updated);
    typing = null;
    retire(old);
    notify("undo-reset");
  }

  function settle(): void {
    active = true;
    try {
      if (current.script.busy()) recover();
      for (let update = pendingPeerUpdates.shift(); update; update = pendingPeerUpdates.shift()) {
        Y.applyUpdate(current.script.doc, update, peerOrigin);
      }
    } finally {
      active = false;
      if (closeRequested) {
        closed = true;
        retire(current);
        notify("closed");
      } else if (current.script.busy() || pendingPeerUpdates.length) scheduleSettle();
    }
  }

  function scheduleSettle(): void {
    if (settleScheduled) return;
    settleScheduled = true;
    // why: a raw Yjs transaction can still be on the stack, so a busy flag alone cannot justify reopening yet
    queueMicrotask(() => {
      settleScheduled = false;
      if (!closed) settle();
    });
  }

  function perform<T>(run: () => T): T {
    active = true;
    try { return run(); } finally {
      active = false;
      settle();
    }
  }

  function bind<Args extends unknown[], Result>(command: (script: NativeScript, ...args: Args) => Result, separate = true) {
    return (...args: Args): Result => {
      if (closed) return command(current.script, ...args);
      if (active || current.script.busy()) {
        if (!active) scheduleSettle();
        return command(current.busyScript, ...args);
      }
      return perform(() => {
        if (separate) {
          typing = null;
          current.undo.stopCapturing();
        }
        return command(current.script, ...args);
      });
    };
  }

  function press(direction: "undo" | "redo"): NativeUndoOutcome {
    if (closed) return current.undo[direction]();
    if (active || current.script.busy()) {
      if (!active) scheduleSettle();
      return { kind: "refused", reason: "busy" };
    }
    return perform(() => {
      typing = null;
      return current.undo[direction]();
    });
  }

  const commands = Object.freeze({
    anchorText: bind(anchorNativeText, false),
    typeText: bind((script, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp) =>
      typeNativeText(script, range, text, marks, stamp, target => {
        const previous = typing?.target.beat === target.beat && typing.target.cell === target.cell ? typing : null;
        if (!previous || !continuesSharedTypingWord(previous.endsInSpace, text)) current.undo.stopCapturing();
        typing = { target, endsInSpace: text ? /\s$/.test(text) : previous?.endsInSpace ?? false };
      }), false),
    replaceText: bind((script, ...args: [NativeTextRange, Parameters<typeof replaceNativeText>[2], NativeEditStamp?]) =>
      replaceNativeText(script, ...args)),
    deleteText: bind(deleteNativeText),
    formatText: bind(formatNativeText),
    splitRow: bind(splitNativeRow),
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
    get ydoc() { return current.script.doc; },
    document: () => current.script.reader.document(),
    encodeState: () => Y.encodeStateAsUpdate(current.script.doc),
    subscribe(listener: ChangeListener): () => void {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    applyPeerUpdate(update: Uint8Array): void {
      if (closed) return;
      if (active || current.script.busy()) {
        pendingPeerUpdates.push(update.slice());
        if (!active) scheduleSettle();
        return;
      }
      perform(() => Y.applyUpdate(current.script.doc, update, peerOrigin));
    },
    close(): void {
      if (closed) return;
      closeRequested = true;
      if (!active) {
        if (current.script.busy()) scheduleSettle(); else settle();
      }
    }
  });
}
