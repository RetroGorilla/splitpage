import assert from "node:assert/strict";
import test from "node:test";
import { runHistory } from "../../src/native-undo/generator.ts";
import type { HistoryOptions, Pace } from "../../src/native-undo/generator.ts";
import { CheckFailure } from "../../src/native-undo/harness.ts";
import type { CreationRule } from "../../src/native-undo/layer.ts";

const MODES: HistoryOptions["modes"] = ["forward", "reverse", "twice"];

function run(pace: Pace, creations: CreationRule, count: number): { presses: number; uncertain: number; losses: number; unseen: number; actions: Record<string, number> } {
  const total = { presses: 0, uncertain: 0, losses: 0, unseen: 0, actions: {} as Record<string, number> };
  for (let seed = 0; seed < count; seed++) {
    const result = runHistory({ seed, steps: 40, pace, modes: MODES, creations });
    total.presses += result.stats.presses; total.uncertain += result.stats.uncertainPresses;
    total.losses += result.losses.length; total.unseen += result.losses.filter(loss => loss.unseen).length;
    for (const [action, times] of Object.entries(result.actions)) total.actions[action] = (total.actions[action] ?? 0) + times;
  }
  return total;
}

test("plain keys, continuous seed 254: undo emits its update and a formatting cleanup update", () => {
  const options = { seed: 254, steps: 40, pace: "continuous", modes: MODES, scheme: "name" } as const;
  assert.throws(() => runHistory(options), (error: Error) => error instanceof CheckFailure && /C undo: 2 Yjs update events/.test(error.message));
  const updates: number[] = [], origins: unknown[] = [], extraOrigins: unknown[][] = [];
  const result = runHistory({
    ...options,
    prepare: world => {
      for (const copy of world.copies) copy.replica.doc.on("update", (_update, origin) => {
        if (copy.current) origins.push(origin === copy.layer.manager ? "UndoManager" : origin);
      });
    },
    onExtraPressUpdates: count => { updates.push(count); extraOrigins.push(origins.slice(-count)); }
  });
  assert.deepEqual(updates, [2]);
  assert.deepEqual(extraOrigins, [["UndoManager", null]]);
  assert.deepEqual(result.losses, []);
  assert.equal(result.stats.checks, 3);
});

for (const pace of ["batched", "continuous"] as const) {
  test(`keep-always, ${pace} delivery: 200 generated histories hold every check and lose nothing`, () => {
    const total = run(pace, "keep-always", 200);
    assert.equal(total.losses, 0);
    for (const action of ["type", "erase", "replace", "format", "status", "field", "remove", "join", "split", "record", "edit", "compound", "undo", "redo"]) {
      assert.ok((total.actions[action] ?? 0) > 20, `${action} ran ${String(total.actions[action])} times`);
    }
    assert.ok(total.uncertain < total.presses / 10, `${total.uncertain} of ${total.presses} presses read their outcome from the library`);
  });

  test(`keep-holding, ${pace} delivery: the same histories lose only what the undoer had not received`, () => {
    const total = run(pace, "keep-holding", 200);
    assert.ok(total.losses > 0);
    assert.equal(total.unseen, total.losses);
  });
}
