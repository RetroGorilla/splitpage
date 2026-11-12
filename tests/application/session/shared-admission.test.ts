import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeReplica, sharedCommand, sharedHarness } from "./shared-session-support.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";

function fixture() {
  const replica = fakeReplica({ title: "Admission", rows: [{ id: "R1", audioText: "ab" }] });
  const harness = sharedHarness(replica.port);
  const operation = readOperation({ kind: "scalar", id: "length", by: "Alice", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 });
  assert.ok(operation);
  return { ...harness, command: sharedCommand("length", [operation]) };
}

test("local admission refusal and failure happen before planning; unregister lets the same command through", () => {
  const h = fixture(), error = new Error("admission failure");
  let plans = 0;
  const command = { ...h.command, plan: (...args: Parameters<typeof h.command.plan>) => { plans++; return h.command.plan(...args); } };
  try {
    const stop = h.session.beforeCommand(() => false);
    assert.deepEqual(h.session.run(command), { kind: "rejected", reason: "buffer-pending" });
    assert.deepEqual([plans, h.executed.length, h.undo.length], [0, 0, 0]);
    stop(); stop();
    const stopFailure = h.session.beforeCommand(() => { throw error; });
    assert.deepEqual(h.session.run(command), { kind: "failed", error });
    assert.deepEqual([plans, h.executed.length, h.undo.length], [0, 0, 0]);
    stopFailure();
    assert.deepEqual(h.session.run(command), { kind: "noop" });
    assert.deepEqual([plans, h.executed.length], [1, 1]);
  } finally { h.session.dispose(); }
});

test("admission can flush a command before the next plan without recursively calling itself", () => {
  const h = fixture(), order: string[] = [];
  try {
    h.session.beforeCommand(() => {
      order.push("admit");
      const outcome = h.session.run({ ...h.command, plan: (...args) => { order.push("typing"); return h.command.plan(...args); } });
      assert.equal(outcome.kind, "noop");
      return true;
    });
    assert.equal(h.session.run({ ...h.command, plan: (...args) => { order.push("next"); return h.command.plan(...args); } }).kind, "noop");
    assert.deepEqual(order, ["admit", "typing", "next"]);
  } finally { h.session.dispose(); }
});

test("disposing during admission refuses the waiting command and clears admissions", () => {
  const h = fixture();
  let calls = 0;
  h.session.beforeCommand(() => { calls++; h.session.dispose(); return true; });
  assert.deepEqual(h.session.run(h.command), { kind: "rejected", reason: "disposed" });
  h.session.beforeCommand(() => { assert.fail("A disposed session must not register an admission"); });
  assert.deepEqual(h.session.run(h.command), { kind: "rejected", reason: "disposed" });
  assert.deepEqual([calls, h.executed.length], [1, 0]);
});
