import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperations } from "../../src/application/session/operation.ts";

function live() {
  const state = { epoch: 3, generation: 7, destinationGeneration: 5, docId: "d" + "1".repeat(32) as string | null, destination: {} as object, revision: 4 as number | null, connection: {} as object };
  const operations = createOperations({
    session: { epoch: function () { return state.epoch; }, generation: function () { return state.generation; } },
    document: { id: function () { return state.docId; } },
    destination: {
      identity: function () { return state.destination; },
      generation: function () { return state.destinationGeneration; },
      revision: function () { return state.revision; }
    },
    connection: { current: function () { return state.connection; } }
  });
  return { state: state, operations: operations };
}

test("captureOperation reads the epoch, document id, destination and its confirmed generation, edit generation, connection instance and server revision at once", () => {
  const { state, operations } = live();
  const ctx = operations.capture();
  assert.deepEqual({ ...ctx }, {
    epoch: 3, docId: state.docId, destination: state.destination, destinationGeneration: 5, generation: 7, connection: state.connection, revision: 4
  });
  assert.ok(Object.isFrozen(ctx));
  state.generation = 8;
  state.revision = 5;
  assert.equal(ctx.generation, 7, "a capture is not a view of what changes later");
  assert.equal(ctx.revision, 4);
});

test("stillOwns holds through edits and revisions, and fails on a new epoch, id, destination or connection instance", () => {
  const changes: [string, (s: ReturnType<typeof live>["state"]) => void][] = [
    ["a new epoch (a replacement or a same-id reopen)", function (s) { s.epoch++; }],
    ["another document id", function (s) { s.docId = "d" + "2".repeat(32); }],
    ["no document", function (s) { s.docId = null; }],
    ["another destination", function (s) { s.destination = {}; }],
    ["another connection instance (a token, role or scope change)", function (s) { s.connection = {}; }]
  ];
  for (const [name, change] of changes) {
    const { state, operations } = live();
    const ctx = operations.capture();
    state.generation += 2;
    state.destinationGeneration += 1;
    state.revision = 9;
    assert.equal(operations.stillOwns(ctx), true, "edits, a new confirmed generation and a new server revision keep ownership");
    change(state);
    assert.equal(operations.stillOwns(ctx), false, name);
  }
});
