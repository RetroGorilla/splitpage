import { createUndo } from "../../application/editing/undo/undo.ts";
import type { ReplayRunner, Undo, UndoHooks, UndoPorts } from "../../application/editing/undo/undo.ts";
import type { StampPorts, UndoPort } from "../../application/session/ports.ts";
import { fromHtml } from "../../legacy/richtext.ts";
import { heldDocument } from "./session-owner.ts";

const WITH_MEDIA = Object.freeze({ media: true });

let started: Undo | null = null;

function announceCleared(count: number): void {
  if (typeof document === "undefined") return;
  const Ctor = (document.defaultView && document.defaultView.CustomEvent) || (typeof CustomEvent === "function" ? CustomEvent : null);
  if (Ctor) document.dispatchEvent(new Ctor("undo-owner-cleared", { detail: { count: count } }));
}

export function undoPorts(): UndoPorts {
  return Object.freeze({
    held: heldDocument,
    runs: function (html: unknown) { return fromHtml(html == null ? "" : html, WITH_MEDIA); },
    now: function () { return Date.now(); },
    cleared: announceCleared
  });
}

export function startUndo(ports: UndoPorts): () => void {
  if (started) throw new Error("Undo is already started; stop it first");
  const mine = createUndo(ports);
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function undoStarted(): boolean {
  return started !== null;
}

export function undoOwner(): Undo {
  if (!started) throw new Error("Undo is not started yet");
  return started;
}

export function configureUndo(hooks: UndoHooks): () => void {
  return undoOwner().configure(hooks);
}

export function routeUndoReplays(run: ReplayRunner, stamps: StampPorts | null, amend?: ReplayRunner): () => void {
  return undoOwner().routeReplays(run, stamps, amend);
}

export function undoSessionPort(): UndoPort {
  return {
    adopt: function (doc) { undoOwner().adopt(doc); },
    record: function () { undoOwner().noteEdit(); },
    absorbServer: function (doc) { undoOwner().noteRemote(doc); },
    absorbReload: function () { undoOwner().absorbRemote(); }
  };
}
