import assert from "node:assert/strict";
import { test } from "node:test";
import { checkModel, IdentityBook } from "../src/model.ts";
import type { CollabModel, ScriptOracle } from "../src/model.ts";

function present<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

test("the independent checker checks raw identities, marks, beat membership, carets, recovery and extra fields", () => {
  const identities = new IdentityBook();
  identities.bind("s1", { client: 10, clock: 7 });
  identities.bind("a1", { client: 1, clock: 0 });
  const oracle: ScriptOracle = {
    rows: [{ id: "R2", characters: [["s1", "a", { b: true }]], lengthSeconds: 12 }],
    carets: { A: { beat: "R2", offset: 1 } },
    recovery: [{ row: { id: "R1", characters: [["a1", "x", {}]] }, by: "Bob", edited: ["a1"] }]
  };
  const correct: CollabModel = {
    rows: [{ id: "R2", characters: [{ identity: { client: 10, clock: 7 }, notation: "s1", value: "a", marks: { b: true }, beat: "R2" }], lengthSeconds: 12 }],
    carets: { A: { beat: "R2", offset: 1 } },
    recovery: [{ row: { id: "R1", characters: [{ identity: { client: 1, clock: 0 }, notation: "a1", value: "x", marks: {}, beat: "R1" }] }, by: "Bob", edited: ["a1"] }]
  };
  checkModel(correct, oracle, identities, "independent");
  for (const [mutate, path] of [
    [(model: CollabModel) => { present(present(model.rows[0]).characters[0]).identity = { client: 1, clock: 0 }; }, "characters[0].identity.client"],
    [(model: CollabModel) => { present(present(model.rows[0]).characters[0]).marks = {}; }, "characters[0].marks.b"],
    [(model: CollabModel) => { present(present(model.rows[0]).characters[0]).beat = "R1"; }, "characters[0].beat"],
    [(model: CollabModel) => { present(model.carets.A).offset = 0; }, "carets.A.offset"],
    [(model: CollabModel) => { model.recovery = []; }, "recovery[0]"],
    [(model: CollabModel) => { present(model.recovery[0]).edited = []; }, "recovery[0].edited[0]"],
    [(model: CollabModel) => { model.carets.B = { beat: "R2", offset: 0 }; }, "carets.B"],
    [(model: CollabModel) => { present(model.rows[0]).lengthSeconds = 13; }, "rows[0].lengthSeconds"]
  ] as const) {
    const mutated = structuredClone(correct);
    mutate(mutated);
    assert.throws(() => checkModel(mutated, oracle, identities, "independent"), error => error instanceof Error && error.message.includes(path));
  }
});

test("a fixture notation cannot be rebound to a copy's raw identity", () => {
  const identities = new IdentityBook();
  identities.bind("s1", { client: 10, clock: 1 });
  assert.throws(() => identities.bind("s1", { client: 1, clock: 0 }), /Identity already bound/);
  assert.throws(() => identities.bind("x1", { client: 10, clock: 1 }), /Identity already bound/);
});
