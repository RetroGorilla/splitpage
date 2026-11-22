import test from "node:test";
import assert from "node:assert/strict";
import { stepSharedUndo } from "../../../../src/bootstrap/wiring/undo.ts";
import { sharedUndoNotice } from "../../../../src/application/editing/undo/shared-undo-notice.ts";

test("rules 71 and 90: a skipped step and a used-up step each have their short message, in the direction asked; everything else is silent", () => {
  const skipped = { ok: false, reason: "undo-unsupported:split", skipped: true } as const, usedUp = { ok: true, effective: false, label: "typing", selection: null, reason: "used-up" } as const;
  assert.deepEqual([sharedUndoNotice(skipped, "undo"), sharedUndoNotice(skipped, "redo")],
    ["This step cannot be undone in a shared session yet.", "This step cannot be redone in a shared session yet."]);
  assert.deepEqual([sharedUndoNotice(usedUp, "undo"), sharedUndoNotice(usedUp, "redo")],
    ["That step could not be undone because someone else changed it.", "That step could not be redone because someone else changed it."]);
  for (const outcome of [{ ok: true, effective: true, label: "typing", selection: null } as const, { ok: false, empty: true } as const,
    { ok: false, reason: "held" } as const, { ok: false, reason: "missing-target" } as const, { ok: false, reason: "undo-unsupported:split" } as const])
    assert.equal(sharedUndoNotice(outcome, "undo"), null, JSON.stringify(outcome));
});

test("the shared undo route warns for a used-up step in either direction", () => {
  const used = { ok: true, effective: false, reason: "used-up", label: "typing", selection: null } as const;
  const route = { actions: { undo: () => used, redo: () => used }, breakGroup: () => {}, replayed: () => null };
  const messages: string[] = [];
  for (const direction of ["undo", "redo"] as const) assert.equal(stepSharedUndo(route, direction, text => messages.push(text)), used);
  assert.deepEqual(messages, [
    "That step could not be undone because someone else changed it.",
    "That step could not be redone because someone else changed it."
  ]);
});
