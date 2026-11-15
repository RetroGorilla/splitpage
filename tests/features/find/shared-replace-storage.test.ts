import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { fakeNotices } from "../fakes.ts";
import { deliverAll, findAct, findCopy, findReplicas, findSource, finder } from "./shared-replace-support.ts";

test("one undo and redo of a shared replacement, and 21 of them, add a fixed number of bytes to the shared document", t => {
  const notices = fakeNotices(), document = findSource("a cup of tea");
  (document.comments as unknown[]).length = 0;
  const set = findReplicas(document), a = findCopy(set.a, "Alice", notices);
  try {
    const route = finder(a.session, notices, a.shared);
    try { findAct(route, { find: "cup", put: "mug" }); } finally { route.dispose(); }
    deliverAll(set.queue, "D1");
    const cycle = () => {
      assert.equal((a.owner.undo() as { ok: boolean }).ok, true); deliverAll(set.queue, "D1");
      assert.equal((a.owner.redo() as { ok: boolean }).ok, true); deliverAll(set.queue, "D1");
    };
    const start = encodeSharedState(set.a).length;
    cycle();
    const first = encodeSharedState(set.a).length - start;
    for (let count = 1; count < 21; count++) cycle();
    const total = encodeSharedState(set.a).length - start;
    t.diagnostic(JSON.stringify({ first, total, perCycle: total / 21 }));
    assert.deepEqual({ first, total }, { first: 1676, total: 36016 });
  } finally { a.session.dispose(); set.close(); }
});
