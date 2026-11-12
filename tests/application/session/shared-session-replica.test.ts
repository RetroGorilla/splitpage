import { test } from "node:test";
import assert from "node:assert/strict";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { createSharedReplica } from "../../../src/adapters/collab/replica.ts";
import { observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { replicas } from "../../adapters/collab/executor-support.ts";
import { nativeText } from "../../adapters/collab/incremental-support.ts";
import { sharedCommand, sharedHarness } from "./shared-session-support.ts";

const ROWS = { whole: false, added: [], removed: [], moved: [], changed: [], fields: [] };
const SOURCE = { title: "Script", rows: [{ id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }, { id: "R3", audioText: "three" }] };

function operation(value: unknown): SharedOperation {
  const read = readOperation(value);
  assert.ok(read);
  return read;
}

const LENGTH = operation({ kind: "scalar", id: "o1", by: "A", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });

test("a disposed replica refuses the session's command: nothing is written and the session is told why", () => {
  const run = replicas(2, SOURCE);
  const replica = createSharedReplica(run.a), h = sharedHarness(replica);
  try {
    const before = collabState(run.a).revision;
    replica.dispose();
    assert.deepEqual(h.session.run(sharedCommand("length", [LENGTH])), { kind: "rejected", reason: "replica-disposed" });
    assert.equal(collabState(run.a).revision, before);
    assert.equal((projectSharedDocument(run.a).rows[0] as { lengthSeconds?: unknown }).lengthSeconds, undefined);
    assert.deepEqual(h.published, []);
    assert.deepEqual(h.reported, []);
  } finally { h.session.dispose(); run.close(); }
});

test("a projector failure is caught by the replica: the writing call returns, the error is reported, the session catches up whole, and the next command lands", () => {
  const run = replicas(2, SOURCE), broken = new Error("projection");
  let armed = false;
  const replica = createSharedReplica(run.a, kind => { if (armed && kind === "compare-row") { armed = false; throw broken; } });
  const h = sharedHarness(replica), told: unknown[] = [];
  h.session.subscribeRows((rows, change) => { told.push([change.kind, rows]); });
  try {
    transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R3").insert(0, "+"));
    armed = true;
    run.queue.flush("dup");
    assert.equal(armed, false);
    assert.deepEqual(h.reported, [broken]);
    assert.equal(h.session.revision(), collabState(run.a).revision);
    assert.deepEqual(h.session.read(doc => doc?.rows.map(row => row.audioText)), ["one", "two", "+three"]);
    assert.deepEqual(replica.project(), projectSharedDocument(run.a));
    assert.deepEqual(h.session.run(sharedCommand("length", [LENGTH])).kind, "applied");
    assert.deepEqual(h.session.read(doc => doc?.rows.map(row => row.lengthSeconds ?? null)), [7, null, null]);
    assert.deepEqual(told, [
      ["remote", { ...ROWS, whole: true }],
      ["edit", { ...ROWS, changed: [{ id: "R1", fields: ["lengthSeconds"] }] }]
    ]);
    assert.deepEqual(h.published.map(change => change.kind), ["remote", "edit"]);
    assert.deepEqual(h.reported, [broken]);
  } finally { h.session.dispose(); replica.dispose(); run.close(); }
});

test("a projector failure inside the session's own command commits the command with that error", () => {
  const run = replicas(2, SOURCE), broken = new Error("projection");
  let armed = false;
  const replica = createSharedReplica(run.a, kind => { if (armed && kind === "compare-row") { armed = false; throw broken; } });
  const h = sharedHarness(replica);
  try {
    armed = true;
    const outcome = h.session.run(sharedCommand("length", [LENGTH]));
    assert.equal(armed, false);
    assert.equal(outcome.kind, "committed");
    assert.deepEqual(outcome.kind === "committed" ? outcome.errors : null, [broken]);
    assert.deepEqual(h.reported, [broken]);
    assert.equal(h.session.revision(), collabState(run.a).revision);
    assert.deepEqual(h.session.read(doc => doc?.rows.map(row => row.lengthSeconds ?? null)), [7, null, null]);
  } finally { h.session.dispose(); replica.dispose(); run.close(); }
});

test("the replica's revision is the one its projector published, paired with that document, until the publication lands", () => {
  const run = replicas(2, SOURCE), seen: unknown[] = [];
  let replica: ReturnType<typeof createSharedReplica> | null = null;
  const stop = observeSharedTransactions(run.a, () => {
    if (replica) seen.push([replica.revision(), (replica.project() as { rows: { audioText: string }[] }).rows[1]?.audioText]);
  });
  replica = createSharedReplica(run.a);
  try {
    const before = replica.revision();
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R2").insert(3, "!"));
    assert.deepEqual(seen, [[before, "two"]]);
    assert.deepEqual([replica.revision(), (replica.project() as { rows: { audioText: string }[] }).rows[1]?.audioText], [before + 1, "two!"]);
  } finally { stop(); replica.dispose(); run.close(); }
});
