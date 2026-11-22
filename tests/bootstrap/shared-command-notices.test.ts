import test from "node:test";
import assert from "node:assert/strict";
import { sharedCommandRefusalNotice, sharedCommandReport } from "../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { fakeReplica, sharedHarness } from "../application/session/shared-session-support.ts";
import { fakeNotices, fakeWriterBufferEffects } from "../features/fakes.ts";

for (const reason of ["visual-selection-unavailable", "buffer-heading-changed"]) {
  test(`rule 73: the shared buffer report maps ${reason} once without a write or standalone undo`, () => {
    const replica = fakeReplica({ rows: [{ id: "R1", audioText: "words" }] });
    const notices = fakeNotices(), fallback = fakeWriterBufferEffects();
    const h = sharedHarness(replica.port, { refused: sharedCommandRefusalNotice(notices.notices) });
    const report = sharedCommandReport(notices.notices, fallback.effects.report);
    try {
      const before = replica.port.project();
      report({ kind: "rejected", reason });
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(replica.port.project(), before);
      assert.deepEqual([h.undo, h.executed, h.published, fallback.reports], [[], [], [], []]);
      report(h.session.refuse(reason));
      assert.equal(notices.shown.length, 2);
      assert.deepEqual(fallback.reports, []);
      const failure = { kind: "failed", error: new Error("Buffer failed") } as const;
      report(failure);
      assert.deepEqual(fallback.reports, [failure]);
      assert.equal(notices.shown.length, 2);
    } finally { h.session.dispose(); }
  });
}
