import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { noticeCopy, noticeDeliver, noticeRange } from "./notice-harness.ts";

export function measureNoticeGrowth(state: Uint8Array, acrossBeats: boolean) {
  const copy = noticeCopy(state, 2, true), peer = noticeCopy(state, 3);
  const count = acrossBeats ? 900 : 10_000, touched = acrossBeats ? 900 : 1;
  const limit = acrossBeats ? 850_000 : 16_000;
  try {
    for (let index = 0; index < count; index++) {
      const id = acrossBeats ? "B" + index : "B451";
      assert.equal(copy.commands.typeText(noticeRange(copy, id, "narration", 60 + (acrossBeats ? 0 : index)), "x", {}).kind, "written");
    }
    assert.equal(peer.commands.setField({ kind: "beat", id: "B0", field: "notes" }, "peer only").kind, "written");
    noticeDeliver(peer, copy);
    const start = performance.now(), result = copy.offlineNotice("returning"), comparisonMs = performance.now() - start;
    assert.deepEqual(result, []);
    const data = copy.pendingEdits?.data();
    assert.ok(data);
    assert.equal(data.through, count);
    assert.equal(data.entries.length, touched);
    const journalBytes = Buffer.byteLength(JSON.stringify(data)), documentBytes = copy.encodeState().byteLength;
    assert.ok(journalBytes < limit, `${journalBytes} bytes at ${count} edits, limit ${limit}`);
    return { count, touched, journalBytes, documentBytes, comparisonMs, limit };
  } finally {
    copy.close();
    peer.close();
  }
}
