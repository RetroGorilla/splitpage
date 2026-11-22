import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootNativeEntrySwitchFixture, stopNativeEntrySwitchFixture, nativeEntrySwitchFixture, attemptNativeSwitchEntry } from "./native-entry-switch-support.ts";
import { currentDocument, onDocumentReplaced, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { leaveRunningSharedSession, nativeEditorActive, SHARED_SWITCHING } from "../../src/bootstrap/wiring/shared-session.ts";
import { sharedUndoRoute } from "../../src/bootstrap/wiring/undo.ts";

before(bootNativeEntrySwitchFixture);
after(stopNativeEntrySwitchFixture);

for (const phase of ["replacement", "settle", "restart"] as const) {
  test("C8 leave " + phase + " refuses startNew, cleans up and admits the following entry", async () => {
    const f = nativeEntrySwitchFixture(), observed: unknown[] = []; let once = true;
    const attempt = () => { if (once) { once = false; observed.push(attemptNativeSwitchEntry("startNew")); } };
    const stop = onDocumentReplaced(() => { if (phase === "replacement" && !sharedSession()) attempt(); });
    try {
      const { outcome, opened } = await f.enterNative(f.ports, backend => ({ ...backend,
        settle: explicit => { if (phase === "settle") attempt(); return backend.settle(explicit); },
        unbind: () => { if (phase === "restart") attempt(); backend.unbind(); }
      }));
      assert.deepEqual(outcome, { ok: true });
      assert.ok(opened);
      const result = leaveRunningSharedSession();
      assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
      assert.deepEqual([result, nativeEditorActive(), sharedUndoRoute(), sharedSession(), currentDocument()?.title, f.errors],
        [{ ok: true }, false, null, false, "Captured script", []]);
      await Promise.resolve();
      assert.equal(opened.native.ydoc.isDestroyed, true);
      stop(); assert.deepEqual(attemptNativeSwitchEntry("startNew"), { accepted: "Replacement script" });
    } finally { stop(); f.close(); }
  });
}

test("C8 a leave-first startNew resumes after the switch and refuses a nested replacement entry", async () => {
  const f = nativeEntrySwitchFixture(), observed: unknown[] = [];
  const { outcome, opened } = await f.enterNative();
  assert.deepEqual(outcome, { ok: true });
  assert.ok(opened); let once = true;
  const stop = onDocumentReplaced(() => {
    if (!sharedSession() && once) { once = false; observed.push(attemptNativeSwitchEntry("startNew")); }
  });
  try {
    assert.deepEqual(attemptNativeSwitchEntry("startNew"), { accepted: "Replacement script" });
    assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
    assert.deepEqual([nativeEditorActive(), sharedUndoRoute(), currentDocument()?.title, f.errors],
      [false, null, "Replacement script", []]);
    await Promise.resolve();
    assert.equal(opened.native.ydoc.isDestroyed, true);
  } finally { stop(); f.close(); }
});
