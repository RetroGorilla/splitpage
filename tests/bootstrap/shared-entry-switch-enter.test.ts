import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootNativeEntrySwitchFixture, stopNativeEntrySwitchFixture, nativeEntrySwitchFixture, attemptNativeSwitchEntry } from "./native-entry-switch-support.ts";
import { currentDocument, onDocumentReplaced, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { nativeEditorActive, SHARED_SWITCHING } from "../../src/bootstrap/wiring/shared-session.ts";

before(bootNativeEntrySwitchFixture);
after(stopNativeEntrySwitchFixture);

for (const kind of ["open", "startNew"] as const) {
  for (const phase of ["refusal", "settle", "microtask", "docId"] as const) {
    test("C8 enter " + phase + " refuses direct " + kind + " and retains the captured script", async () => {
      const f = nativeEntrySwitchFixture(), observed: unknown[] = []; let once = true;
      const attempt = () => { if (once) { once = false; observed.push(attemptNativeSwitchEntry(kind)); } };
      const ports = { ...f.ports,
        refusal: () => { if (phase === "refusal") attempt(); return null; },
        settle: () => { if (phase === "settle") attempt(); if (phase === "microtask") void Promise.resolve().then(attempt); },
        docId: () => { if (phase === "docId") attempt(); return f.ports.docId(); } };
      try {
        assert.deepEqual((await f.enterNative(ports)).outcome, { ok: true });
        assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
        assert.deepEqual([currentDocument()?.title, currentDocument()?.rows.map(row => [row.id, row.audioText]), sharedSession(), f.errors],
          ["Captured script", [["R1", "Captured words"]], true, []]);
      } finally { f.close(); }
    });
  }

  test("C8 rollback refuses direct " + kind + " through standalone replacement and releases entry admission", async () => {
    const f = nativeEntrySwitchFixture(), observed: unknown[] = []; let sawShared = false;
    const stop = onDocumentReplaced(() => {
      if (sharedSession()) sawShared = true;
      else if (sawShared) { sawShared = false; observed.push(attemptNativeSwitchEntry(kind)); }
    });
    try {
      assert.deepEqual((await f.enterNative({ ...f.ports, detach: () => { throw new Error("detach refused"); } })).outcome, { ok: false, reason: "enter-failed" });
      assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
      assert.deepEqual([nativeEditorActive(), sharedSession(), currentDocument()?.title], [false, false, "Captured script"]);
      stop(); assert.deepEqual(attemptNativeSwitchEntry(kind), { accepted: "Replacement script" });
    } finally { stop(); f.close(); }
  });
}
