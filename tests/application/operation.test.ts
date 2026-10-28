import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperations } from "../../src/application/session/operation.ts";

function live() {
  const state = { epoch: 3, generation: 7, destinationGeneration: 5, docId: "d" + "1".repeat(32) as string | null, destination: {} as object };
  const operations = createOperations({
    session: { epoch: function () { return state.epoch; }, generation: function () { return state.generation; } },
    document: { id: function () { return state.docId; } },
    destination: {
      identity: function () { return state.destination; },
      generation: function () { return state.destinationGeneration; }
    }
  });
  return { state: state, operations: operations };
}

test("captureOperation reads the epoch, document id, destination and its confirmed generation and edit generation at once", () => {
  const { state, operations } = live();
  const ctx = operations.capture();
  assert.deepEqual({ ...ctx }, {
    epoch: 3, docId: state.docId, destination: state.destination, destinationGeneration: 5, generation: 7
  });
  assert.ok(Object.isFrozen(ctx));
  state.generation = 8;
  state.destinationGeneration = 6;
  assert.equal(ctx.generation, 7, "a capture is not a view of what changes later");
  assert.equal(ctx.destinationGeneration, 5);
});

test("stillOwns holds through edits, and fails on a new epoch, id or destination", () => {
  const changes: [string, (s: ReturnType<typeof live>["state"]) => void][] = [
    ["a new epoch (a replacement or a same-id reopen)", function (s) { s.epoch++; }],
    ["another document id", function (s) { s.docId = "d" + "2".repeat(32); }],
    ["no document", function (s) { s.docId = null; }],
    ["another destination", function (s) { s.destination = {}; }]
  ];
  for (const [name, change] of changes) {
    const { state, operations } = live();
    const ctx = operations.capture();
    state.generation += 2;
    state.destinationGeneration += 1;
    assert.equal(operations.stillOwns(ctx), true, "edits and a new confirmed generation keep ownership");
    change(state);
    assert.equal(operations.stillOwns(ctx), false, name);
  }
});
