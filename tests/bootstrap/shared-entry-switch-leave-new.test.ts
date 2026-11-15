import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootEntrySwitchFixture, stopEntrySwitchFixture, entrySwitchFixture, attemptSwitchEntry } from "./shared-entry-switch-support.ts";
import { currentDocument, onDocumentReplaced, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, sharedSessionParts, SHARED_SWITCHING } from "../../src/bootstrap/wiring/shared-session.ts";
import { sharedUndoRoute } from "../../src/bootstrap/wiring/undo.ts";
import { collabState } from "../../src/adapters/collab/state.ts";

before(bootEntrySwitchFixture);
after(stopEntrySwitchFixture);

for (const phase of ["replacement", "settle", "restart"] as const) {
  test("C8 leave " + phase + " refuses startNew, cleans up and admits the following entry", async () => {
    const f = entrySwitchFixture(), observed: unknown[] = []; let once = true;
    const attempt = () => { if (once) { once = false; observed.push(attemptSwitchEntry("startNew")); } };
    const stop = onDocumentReplaced(() => { if (phase === "replacement" && !sharedSession()) attempt(); });
    const ports = { ...f.ports, bindings: { ...f.ports.bindings,
      settle: () => { if (phase === "settle") attempt(); return null; }, leave: () => { if (phase === "restart") attempt(); } } };
    try {
      assert.deepEqual(await enterSharedSession(ports), { ok: true });
      const parts = sharedSessionParts(); assert.ok(parts);
      const result = leaveRunningSharedSession();
      assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
      assert.deepEqual([result, sharedSessionParts(), sharedUndoRoute(), sharedSession(), collabState(parts.handle).destroyed, currentDocument()?.title, f.errors],
        [{ ok: true }, null, null, false, true, "Captured script", []]);
      stop(); assert.deepEqual(attemptSwitchEntry("startNew"), { accepted: "Replacement script" });
    } finally { stop(); f.close(); }
  });
}

test("C8 a leave-first startNew resumes after the switch and refuses a nested replacement entry", async () => {
  const f = entrySwitchFixture(), observed: unknown[] = [];
  assert.deepEqual(await f.enter(), { ok: true });
  const parts = sharedSessionParts(); assert.ok(parts); let once = true;
  const stop = onDocumentReplaced(() => {
    if (!sharedSession() && once) { once = false; observed.push(attemptSwitchEntry("startNew")); }
  });
  try {
    assert.deepEqual(attemptSwitchEntry("startNew"), { accepted: "Replacement script" });
    assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
    assert.deepEqual([sharedSessionParts(), sharedUndoRoute(), collabState(parts.handle).destroyed, currentDocument()?.title, f.errors],
      [null, null, true, "Replacement script", []]);
  } finally { stop(); f.close(); }
});
