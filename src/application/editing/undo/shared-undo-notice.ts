import type { SharedUndoOutcome } from "./shared-undo.ts";
import type { UndoDirection } from "./undo.ts";

const SKIPPED: Readonly<Record<UndoDirection, string>> = Object.freeze({
  undo: "This step cannot be undone in a shared session yet.",
  redo: "This step cannot be redone in a shared session yet."
});
const USED_UP: Readonly<Record<UndoDirection, string>> = Object.freeze({
  undo: "That step could not be undone because someone else changed it.",
  redo: "That step could not be redone because someone else changed it."
});

// why: rules 71 and 90 on #1414: a skipped step and a step someone else used up each say so once; every other outcome
// is silent, as before.
export function sharedUndoNotice(outcome: SharedUndoOutcome, direction: UndoDirection): string | null {
  if (outcome.ok) return outcome.effective ? null : USED_UP[direction];
  return "skipped" in outcome && outcome.skipped ? SKIPPED[direction] : null;
}
