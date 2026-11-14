import test from "node:test";
import assert from "node:assert/strict";
import { sharedCommandRefusalNotice, sharedCommandReport } from "../../src/bootstrap/wiring/ports/shared-command-notices.ts";
import { sharedBufferPorts } from "../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { encodeSharedState } from "../../src/adapters/collab/document.ts";
import { replicas } from "../adapters/collab/executor-support.ts";
import { adapterReplica, sharedHarness } from "../application/session/shared-session-support.ts";
import { fakeNotices, fakeWriterBufferEffects } from "../features/fakes.ts";
import { bufferReaders, bufferStamps } from "../collab/buffer-readers.ts";

for (const reason of ["visual-selection-unavailable", "buffer-heading-changed"]) {
  test(`rule 73: the shared buffer report maps ${reason} once without a write or standalone undo`, () => {
    const set = replicas(), notices = fakeNotices(), fallback = fakeWriterBufferEffects();
    const h = sharedHarness(adapterReplica(set.a), { refused: sharedCommandRefusalNotice(notices.notices) });
    try {
      const shared = sharedBufferPorts(set.a, h.session, { ...fallback.effects,
        report: sharedCommandReport(notices.notices, fallback.effects.report), readers: bufferReaders, stamps: bufferStamps("Editor"),
        author: () => { assert.fail("A refusal report must not allocate an operation"); } });
      const before = encodeSharedState(set.a);
      shared.bufferedText.report({ kind: "rejected", reason });
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(encodeSharedState(set.a), before);
      assert.deepEqual([h.undo, h.executed, h.published, fallback.reports], [[], [], [], []]);
      shared.bufferedText.report(h.session.refuse(reason));
      assert.equal(notices.shown.length, 2);
      assert.deepEqual(fallback.reports, []);
      const failure = { kind: "failed", error: new Error("Buffer failed") } as const;
      shared.bufferedText.report(failure);
      assert.deepEqual(fallback.reports, [failure]);
      assert.equal(notices.shown.length, 2);
    } finally { h.session.dispose(); set.close(); }
  });
}
