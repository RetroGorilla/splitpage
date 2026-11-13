import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedRecoveryEntry } from "../../../src/core/collab/recovery.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { agree, operation, replicas } from "../../adapters/collab/executor-support.ts";
import { nativeText } from "../../adapters/collab/incremental-support.ts";
import { sharedHarness } from "./shared-session-support.ts";

const SOURCE = { title: "Script", rows: [{ id: "R0", audioText: "x" }, { id: "R1", audioText: "abcd" }, { id: "R2", audioText: "ef" }] };
const remove = (beat: string, id: string, length: number) => operation({ kind: "remove", id, by: "Alice", removalKind: "beat", targets: [beat],
  observed: [flowBaseReference(beat, "audioText", 0, length)], boundaries: [beat], components: [], gallery: [], at: 1 });
const listed = (entries: readonly SharedRecoveryEntry[]) => entries.map(entry => entry.kind === "removed-beat" ? [entry.kind, entry.row.id, entry.row.audioText] : [entry.kind]);

function send(handle: SharedDocumentHandle, ...ops: ReturnType<typeof operation>[]): void {
  assert.deepEqual(executeSharedOperations(handle, ops, { base: readSharedRevision(handle) }), { ok: true });
}
function throughSession(handle: SharedDocumentHandle) {
  const replica = createSharedReplica(handle), h = sharedHarness(replica);
  try {
    const entries = h.session.recovery();
    assert.deepEqual(entries, projectSharedDocumentWithRecovery(handle).recovery);
    return { revision: h.session.revision() === readSharedRevision(handle), recovery: listed(entries) };
  } finally { h.session.dispose(); replica.dispose(); }
}

for (const order of ["D1", "rev", "dup"] as const) test(`read port: every copy's session and a late joiner's read the same recovery list, paired with the held revision: ${order}`, () => {
  const run = replicas(3, SOURCE), handles = [run.a, run.b, run.c];
  for (const handle of handles) registerSharedRemovalHandlers(handle);
  const live = handles.map(handle => { const replica = createSharedReplica(handle); return { replica, h: sharedHarness(replica) }; });
  try {
    agree("nothing in recovery", order, handles, throughSession, { revision: true, recovery: [] });
    send(run.a, remove("R1", "gone", 4)); send(run.b, remove("R2", "gone2", 2)); run.queue.flush(order);
    agree("two removed beats", order, handles, throughSession, { revision: true, recovery: [["removed-beat", "R1", "abcd"], ["removed-beat", "R2", "ef"]] });
    for (const [index, { h }] of live.entries()) {
      const handle = handles[index]; assert.ok(handle);
      assert.equal(h.session.revision(), readSharedRevision(handle));
      assert.deepEqual(h.session.recovery(), projectSharedDocumentWithRecovery(handle).recovery);
      assert.ok(Object.isFrozen(h.session.recovery()));
    }
  } finally { for (const { h, replica } of live) { h.session.dispose(); replica.dispose(); } run.close(); }
});

test("read port: a failed publication keeps the held document and its list together, the next one replaces both, and a disposed session holds none", () => {
  const run = replicas(2, SOURCE), broken = new Error("projection");
  for (const handle of [run.a, run.b]) registerSharedRemovalHandlers(handle);
  let armed = false;
  const replica = createSharedReplica(run.a, kind => { if (armed && kind === "compare-row") throw broken; }), h = sharedHarness(replica);
  const held = () => ({ rows: h.session.readAt((doc, revision) => [revision, doc?.rows.map(row => row.id)]), recovery: listed(h.session.recovery()) });
  try {
    send(run.a, remove("R1", "gone", 4));
    const first = held();
    assert.deepEqual(first, { rows: [readSharedRevision(run.a), ["R0", "R2"]], recovery: [["removed-beat", "R1", "abcd"]] });
    armed = true;
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R0").insert(1, "!")); send(run.b, remove("R2", "gone2", 2)); run.queue.flush("D1");
    assert.deepEqual([held(), h.reported.length > 0], [first, true]);
    armed = false;
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R0").insert(2, "?")); run.queue.flush("D1");
    assert.deepEqual(held(), { rows: [readSharedRevision(run.a), ["R0"]], recovery: [["removed-beat", "R1", "abcd"], ["removed-beat", "R2", "ef"]] });
    assert.deepEqual(h.session.recovery(), projectSharedDocumentWithRecovery(run.a).recovery);
    h.session.dispose();
    assert.deepEqual([h.session.read(doc => doc), h.session.recovery()], [null, []]);
  } finally { h.session.dispose(); replica.dispose(); run.close(); }
});
