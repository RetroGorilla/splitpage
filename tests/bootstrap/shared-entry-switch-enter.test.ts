import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootEntrySwitchFixture, stopEntrySwitchFixture, entrySwitchFixture, attemptSwitchEntry } from "./shared-entry-switch-support.ts";
import { currentDocument, onDocumentReplaced, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, sharedSessionParts, SHARED_SWITCHING } from "../../src/bootstrap/wiring/shared-session.ts";

before(bootEntrySwitchFixture);
after(stopEntrySwitchFixture);

for (const kind of ["open", "startNew"] as const) {
  for (const phase of ["refusal", "settle", "microtask", "docId"] as const) {
    test("C8 enter " + phase + " refuses direct " + kind + " and retains the captured script", async () => {
      const f = entrySwitchFixture(), observed: unknown[] = []; let once = true;
      const attempt = () => { if (once) { once = false; observed.push(attemptSwitchEntry(kind)); } };
      const ports = { ...f.ports,
        refusal: () => { if (phase === "refusal") attempt(); return null; },
        settle: () => { if (phase === "settle") attempt(); if (phase === "microtask") void Promise.resolve().then(attempt); },
        docId: () => { if (phase === "docId") attempt(); return f.ports.docId(); } };
      try {
        assert.deepEqual(await enterSharedSession(ports), { ok: true });
        assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
        assert.deepEqual([currentDocument()?.title, currentDocument()?.rows.map(row => [row.id, row.audioText]), sharedSession(), f.errors],
          ["Captured script", [["R1", "Captured words"]], true, []]);
      } finally { f.close(); }
    });
  }

  test("C8 rollback refuses direct " + kind + " through standalone replacement and releases entry admission", async () => {
    const f = entrySwitchFixture(), observed: unknown[] = []; let sawShared = false;
    const stop = onDocumentReplaced(() => {
      if (sharedSession()) sawShared = true;
      else if (sawShared) { sawShared = false; observed.push(attemptSwitchEntry(kind)); }
    });
    try {
      assert.deepEqual(await enterSharedSession({ ...f.ports, detach: () => { throw new Error("detach refused"); } }), { ok: false, reason: "enter-failed" });
      assert.deepEqual(observed, [{ refused: SHARED_SWITCHING }]);
      assert.deepEqual([sharedSessionParts(), sharedSession(), currentDocument()?.title], [null, false, "Captured script"]);
      stop(); assert.deepEqual(attemptSwitchEntry(kind), { accepted: "Replacement script" });
    } finally { stop(); f.close(); }
  });
}
