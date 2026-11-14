import { createUndo } from "../../application/editing/undo/undo.ts";
import type { ReplayRunner, Undo, UndoDirection, UndoHooks, UndoPorts } from "../../application/editing/undo/undo.ts";
import type { SharedUndo, SharedUndoOutcome } from "../../application/editing/undo/shared-undo.ts";
import type { SharedUndoActions } from "../../application/editing/undo/shared-undo-actions.ts";
import type { StampPorts, UndoPort } from "../../application/session/ports.ts";
import { fromHtml } from "../richtext.ts";
import { heldDocument, liveSession } from "./session-owner.ts";

const WITH_MEDIA = Object.freeze({ media: true });

let started: Undo | null = null;

export interface SharedUndoRoute {
  readonly actions: SharedUndoActions;
  readonly breakGroup: SharedUndo["breakGroup"];
}

let sharedRoute: SharedUndoRoute | null = null;

export const SHARED_UNDO_REFUSED = "This step cannot be undone in a shared session yet.";

export function routeSharedUndo(route: SharedUndoRoute): () => void {
  sharedRoute = route;
  return function () {
    if (sharedRoute === route) sharedRoute = null;
  };
}

export function sharedUndoRoute(): SharedUndoRoute | null {
  return sharedRoute;
}

export function stepSharedUndo(route: SharedUndoRoute, direction: UndoDirection, warn: (message: string) => void): SharedUndoOutcome {
  const outcome = direction === "undo" ? route.actions.undo() : route.actions.redo();
  if (!outcome.ok && "reason" in outcome && outcome.reason.startsWith("undo-unsupported:")) warn(SHARED_UNDO_REFUSED);
  return outcome;
}

export function breakUndoGroup(): void {
  if (sharedRoute) sharedRoute.breakGroup();
  else undoOwner().breakCoalescing();
}

function announceCleared(count: number): void {
  if (typeof document === "undefined") return;
  const Ctor = (document.defaultView && document.defaultView.CustomEvent) || (typeof CustomEvent === "function" ? CustomEvent : null);
  if (Ctor) document.dispatchEvent(new Ctor("undo-owner-cleared", { detail: { count: count } }));
}

export function undoPorts(): UndoPorts {
  return Object.freeze({
    held: heldDocument,
    epoch: () => liveSession().epoch(),
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
    record: function (_changes, selection) { undoOwner().noteEdit(selection); },
    absorbDisk: function (doc) { undoOwner().noteRemote(doc); },
    absorbReload: function () { undoOwner().absorbRemote(); }
  };
}
