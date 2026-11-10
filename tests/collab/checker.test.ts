import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { checkModel, IdentityBook } from "./checker.ts";
import type { CollabCharacter, CollabMarks, CollabModel, ScriptOracle } from "./checker.ts";
import { commentsOverlapOracle, deletionOracle, joinNarrationOracle, lengthOracle, restorationOracle } from "./oracles/oracles.ts";
import { markOracles } from "./oracles/marks/oracles.ts";

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

const raw: Readonly<Record<string, { client: number; clock: number }>> = {
  s1: { client: 10, clock: 0 }, s2: { client: 10, clock: 1 }, s3: { client: 10, clock: 2 }, s4: { client: 10, clock: 3 },
  s5: { client: 10, clock: 4 }, s6: { client: 10, clock: 5 }, s7: { client: 10, clock: 6 }, s8: { client: 10, clock: 7 },
  s9: { client: 10, clock: 8 }, s10: { client: 10, clock: 9 }, s11: { client: 10, clock: 10 },
  a1: { client: 1, clock: 0 }, b1: { client: 2, clock: 0 },
  x1: { client: 1, clock: 40 }, x2: { client: 1, clock: 41 }
};

function book(): IdentityBook {
  const identities = new IdentityBook();
  for (const [notation, identity] of Object.entries(raw)) identities.bind(notation, identity);
  return identities;
}

function character(notation: string, value: string, beat: string, marks: CollabMarks = {}): CollabCharacter {
  return { identity: notation === "[glue]" ? null : { ...present(raw[notation]) }, notation, value, marks, beat };
}

interface DeliberateDefect {
  name: string;
  replica: string;
  history: string;
  oracle: ScriptOracle;
  correct: CollabModel;
  defective: CollabModel;
  failure: RegExp;
}

const defects: readonly DeliberateDefect[] = [
  {
    name: "lost remote character", replica: "T01", history: "T01, D3, M2: whole-beat sync replaces R1 with the DOM result", oracle: deletionOracle,
    correct: { rows: [{ id: "R1", characters: [character("s1", "a", "R1"), character("b1", "X", "R1"), character("s4", "d", "R1")] }], carets: { A: { beat: "R1", offset: 1 } }, recovery: [] },
    defective: { rows: [{ id: "R1", characters: [character("s1", "a", "R1"), character("s4", "d", "R1")] }], carets: { A: { beat: "R1", offset: 1 } }, recovery: [] },
    failure: /^T01\.rows\[0\]\.characters\[1\]\.identity\.client: expected 2, got 10$/
  },
  {
    name: "stale base", replica: "T01", history: "T01, D3, M2: the deletion is mapped by base offsets 1-2 instead of painted identities", oracle: deletionOracle,
    correct: { rows: [{ id: "R1", characters: [character("s1", "a", "R1"), character("b1", "X", "R1"), character("s4", "d", "R1")] }], carets: { A: { beat: "R1", offset: 1 } }, recovery: [] },
    defective: { rows: [{ id: "R1", characters: [character("s1", "a", "R1"), character("s3", "c", "R1"), character("s4", "d", "R1")] }], carets: { A: { beat: "R1", offset: 1 } }, recovery: [] },
    failure: /^T01\.rows\[0\]\.characters\[1\]\.identity\.client: expected 2, got 10$/
  },
  {
    name: "duplicated identity", replica: "T10", history: "T10, D1, late-C: undo of a removal re-inserts the observed text as new characters", oracle: restorationOracle,
    correct: { rows: [
      { id: "R1", characters: [character("s1", "a", "R1"), character("s2", "b", "R1")] },
      { id: "R2", characters: [character("s3", "c", "R2"), character("b1", "X", "R2"), character("s4", "d", "R2")] },
      { id: "R3", characters: [character("s5", "e", "R3"), character("s6", "f", "R3")] }
    ], carets: { A: { beat: "R2", offset: 0 } }, recovery: [] },
    defective: { rows: [
      { id: "R1", characters: [character("s1", "a", "R1"), character("s2", "b", "R1")] },
      { id: "R2", characters: [character("x1", "c", "R2"), character("x2", "d", "R2"), character("s3", "c", "R2"), character("b1", "X", "R2"), character("s4", "d", "R2")] },
      { id: "R3", characters: [character("s5", "e", "R3"), character("s6", "f", "R3")] }
    ], carets: { A: { beat: "R2", offset: 0 } }, recovery: [] },
    failure: /^T10\.rows\[1\]\.characters\[0\]\.identity\.client: expected 10, got 1$/
  },
  {
    name: "duplicated identity (join)", replica: "T06", history: "T06, D1: join inserts copies of R2's narration at the end of R1", oracle: joinNarrationOracle,
    correct: { rows: [{ id: "R1", characters: [
      character("s1", "a", "R1", { b: true }), character("s2", "b", "R1", { b: true }), character("[glue]", " ", "R1"), character("s3", "c", "R1"), character("s4", "d", "R1")
    ] }], carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 3 } }, recovery: [] },
    defective: { rows: [{ id: "R1", characters: [
      character("s1", "a", "R1", { b: true }), character("s2", "b", "R1", { b: true }), character("x1", "c", "R1"), character("x2", "d", "R1"),
      character("[glue]", " ", "R1"), character("s3", "c", "R1"), character("s4", "d", "R1")
    ] }], carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 3 } }, recovery: [] },
    failure: /^T06\.rows\[0\]\.characters\[2\]\.identity: expected null, got \{"client":1,"clock":40\}$/
  },
  {
    name: "omitted field", replica: "PROJ", history: "PROJ: projection drops lengthSeconds", oracle: lengthOracle,
    correct: { rows: [{ id: "R1", characters: [character("s1", "a", "R1"), character("s2", "b", "R1")], lengthSeconds: 12 }], carets: {}, recovery: [] },
    defective: { rows: [{ id: "R1", characters: [character("s1", "a", "R1"), character("s2", "b", "R1")] }], carets: {}, recovery: [] },
    failure: /^PROJ\.rows\[0\]\.lengthSeconds: expected 12, got <missing>$/
  },
  {
    name: "lost mark", replica: "T11", history: "T11 step 1, D1: comments stored in one attribute key", oracle: commentsOverlapOracle,
    correct: { rows: [{ id: "R1", characters: [
      character("s1", "a", "R1"), character("s2", "b", "R1", { "c:C1": true }), character("s3", "c", "R1", { "c:C1": true, "c:C2": true }), character("s4", "d", "R1", { "c:C2": true })
    ] }], carets: {}, recovery: [] },
    defective: { rows: [{ id: "R1", characters: [
      character("s1", "a", "R1"), character("s2", "b", "R1", { "c:C1": true }), character("s3", "c", "R1", { "c:C2": true }), character("s4", "d", "R1", { "c:C2": true })
    ] }], carets: {}, recovery: [] },
    failure: /^T11\.rows\[0\]\.characters\[2\]\.marks\.c:C1: expected true, got <missing>$/
  },
  {
    name: "lost mark (tag)", replica: "T20", history: "T20 nest, D1: tags stored in one attribute key", oracle: present(markOracles["T20 nest"]),
    correct: { rows: [{ id: "R1", characters: [
      character("s1", "t", "R1"), character("s2", "h", "R1"), character("s3", "e", "R1"), character("s4", " ", "R1"),
      character("s5", "r", "R1", { tag: "P" }), character("s6", "e", "R1", { tag: "P" }), character("s7", "d", "R1", { tag: "P" }), character("s8", " ", "R1", { tag: "P" }),
      character("s9", "m", "R1", { tag: "P", innerTags: ["S"] }), character("s10", "u", "R1", { tag: "P", innerTags: ["S"] }), character("s11", "g", "R1", { tag: "P", innerTags: ["S"] })
    ] }], carets: {}, recovery: [] },
    defective: { rows: [{ id: "R1", characters: [
      character("s1", "t", "R1"), character("s2", "h", "R1"), character("s3", "e", "R1"), character("s4", " ", "R1"),
      character("s5", "r", "R1", { tag: "P" }), character("s6", "e", "R1", { tag: "P" }), character("s7", "d", "R1", { tag: "P" }), character("s8", " ", "R1", { tag: "P" }),
      character("s9", "m", "R1", { tag: "P" }), character("s10", "u", "R1", { tag: "P" }), character("s11", "g", "R1", { tag: "P" })
    ] }], carets: {}, recovery: [] },
    failure: /^T20\.rows\[0\]\.characters\[8\]\.marks\.innerTags: expected \["S"\], got <missing>$/
  }
];

for (const defect of defects) {
  test(`the checker rejects the ${defect.name} defect before it endorses the correct state (${defect.history})`, () => {
    assert.throws(() => checkModel(defect.defective, defect.oracle, book(), defect.replica), error => error instanceof Error && defect.failure.test(error.message));
    checkModel(defect.correct, defect.oracle, book(), defect.replica);
  });
}

test("every Stage 2 deliberate defect has a checker test", () => {
  assert.deepEqual(new Set(defects.map(defect => defect.name.replace(/ \(.*\)$/, ""))), new Set(["lost remote character", "duplicated identity", "omitted field", "lost mark", "stale base"]));
});

test("the checker imports neither Yjs nor app code", () => {
  const source = readFileSync(new URL("./checker.ts", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map(match => match[1]), []);
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/);
});
