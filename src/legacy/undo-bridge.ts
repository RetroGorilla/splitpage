import { createUndo } from "../application/editing/undo/undo.ts";
import type { ReplayRunner, Undo, UndoHooks, UndoPorts, UndoResult } from "../application/editing/undo/undo.ts";
import type { CellMark, UndoEntry, UndoState } from "../application/editing/undo/history.ts";
import type { StampPorts } from "../application/session/ports.ts";
import type { Step } from "../core/text/steps.ts";
import { fromHtml } from "./richtext.ts";
import { heldDocument } from "./session-bridge.ts";

const WITH_MEDIA = Object.freeze({ media: true });

let started: Undo | null = null;

function announceCleared(count: number): void {
  if (typeof document === "undefined") return;
  const Ctor = (document.defaultView && document.defaultView.CustomEvent) || (typeof CustomEvent === "function" ? CustomEvent : null);
  if (Ctor) document.dispatchEvent(new Ctor("undo-owner-cleared", { detail: { count: count } }));
}

export function legacyUndoPorts(): UndoPorts {
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

export function adoptDocument(doc: UndoState | null | undefined): void { undoOwner().adopt(doc); }

export function trackDocument(): void { undoOwner().track(); }

export function flushEdits(): void { undoOwner().flush(); }

export function noteEdit(): void { undoOwner().noteEdit(); }

export function noteRemoteChange(next: UndoState | null | undefined): void { undoOwner().noteRemote(next); }

export function absorbRemoteChange(): void { undoOwner().absorbRemote(); }

export function resetUndo(): void { undoOwner().reset(); }

export function undo(): UndoResult { return undoOwner().undo(); }

export function redo(): UndoResult { return undoOwner().redo(); }

export function settleAfterApply(): void { undoOwner().settleAfterApply(); }

export function foldIntoEdit(entry: UndoEntry | null | undefined, touches: (step: Step) => boolean, change: (draft: UndoState) => boolean): boolean {
  return undoOwner().foldIntoEdit(entry, touches, change);
}

export function breakUndoCoalescing(): void { undoOwner().breakCoalescing(); }

export function undoSizes(): { undo: number; redo: number } { return undoOwner().sizes(); }

export function lastUndoEntry(): UndoEntry | null { return undoOwner().last(); }

export function nextRedoEntry(): UndoEntry | null { return undoOwner().nextRedo(); }

export function undoLifetime(): number { return undoOwner().lifetime(); }

export function undoMark(): number { return undoOwner().mark(); }

export function undoSerial(): number { return undoOwner().serial(); }

export function compositionUndoMark(rowId: string, key: string): CellMark { return undoOwner().compositionMark(rowId, key); }

export function dropEmptyStepsSince(mark: CellMark, cancelled?: boolean): boolean { return undoOwner().dropEmptySince(mark, cancelled); }
