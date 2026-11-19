import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { ALL_RULES } from "../../src/native/variant.ts";
import { base, load, outline, seed } from "./kit.ts";
import type { Spec } from "./kit.ts";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { letterItems, perform, play } from "./play.ts";
import type { Cmd, Step } from "./play.ts";

const act = (by: number, cmd: Cmd): Step => ({ by, cmd });
const SYNC: Step[] = [{ from: 0, to: 1 }, { from: 1, to: 0 }];
const MODES = ["forward", "reverse", "state"] as const;
const PREPARED: Step[] = [act(0, { op: "delete", rows: ["A"] }), act(1, { op: "type", id: "A", field: "audio", at: 1, text: "Ψ" }), ...SYNC];
const splitB = (by: number, created: string): Step => act(by, { op: "split", id: "B", at: 0, created });
const move = (by: number, first: string, target: string): Step => act(by, { op: "move", drop: { unit: "row", first, target, after: true } });
const BASE_ROWS = ["A: abc / 1", "B: def / 2", "C: ghi / 3", "D: jkl / 4", "#H mno", "E: pqr / 5", "#I stu", "F: vwx / 6"];

test("E11 review: two splits at the same moment of a row the rules read show its narration once", () => {
  for (const mode of MODES) {
    const result = play({ spec: base(), steps: [...PREPARED, splitB(0, "N"), splitB(1, "M")], writers: 2, mode, seed: 1 });
    assert.deepEqual([result.never, result.local], [[], []], mode);
    assert.equal(result.lines.join("").split("Ψ").length - 1, 1, mode);
    // why: offset 0 lies in text rule (a) shows; the nearest place a boundary fits is the start of B's own text
    assert.deepEqual(result.lines.slice(0, 3).toSorted(), ["B: Ψ / 2", "M: def / ", "N:  / "], mode);
    assert.deepEqual(result.kinds, { "a split inside rule-read text was placed at the beat's own text": 2 }, mode);
  }
});

test("E11 review control: the first version's copying split duplicates the narration in that race, and the check sees it", () => {
  const copies = [load(seed(base()), 1), load(seed(base()), 2)];
  const exchange = (): void => {
    for (const [from, to] of [[0, 1], [1, 0]] as const) {
      const source = copies[from], target = copies[to];
      if (source && target) Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, Y.encodeStateVector(target.doc)), "remote");
    }
  };
  try {
    for (const copy of copies) Object.assign(copy, { copyFreeSplit: false });
    const [zero, one] = copies as [ChosenReplica, ChosenReplica];
    perform(zero, { op: "delete", rows: ["A"] });
    perform(one, { op: "type", id: "A", field: "audio", at: 1, text: "Ψ" });
    exchange();
    const items = letterItems(zero);
    perform(zero, { op: "split", id: "B", at: 0, created: "N" });
    assert.notDeepEqual(letterItems(zero), items, "the copying split deletes and writes the letter again");
    perform(one, { op: "split", id: "B", at: 0, created: "M" });
    exchange();
    assert.equal(outline(zero).join("").split("Ψ").length - 1, 2);
  } finally { for (const copy of copies) copy.destroy(); }
});

test("E11 review: a tag put on rule-read letters someone else has split off at the same moment is kept", () => {
  const tag = act(1, { op: "format", id: "B", field: "audio", from: 0, to: 1, key: "t:prop", on: true });
  for (const mode of MODES) {
    const result = play({ spec: base(), steps: [...PREPARED, splitB(0, "N"), tag], writers: 2, mode, seed: 1 });
    assert.deepEqual([result.never, result.local, result.tags], [[], [], { requested: 1, kept: 1, lost: [] }], mode);
    assert.deepEqual(result.lines.slice(0, 2), ["B: [Ψ|t:prop] / 2", "N: def / "], mode);
  }
});

const RANK_CASES: { name: string; steps: Step[]; rows: string[] }[] = [
  {
    name: "a row deleted, moved unseen by someone else, and brought back by the deleter's undo",
    steps: [act(0, { op: "delete", rows: ["F"] }), move(1, "F", "A"), SYNC[1] as Step, act(0, { op: "undo" })],
    rows: BASE_ROWS
  },
  {
    name: "the same with the row in the middle of a scene",
    steps: [act(0, { op: "delete", rows: ["C"] }), move(1, "C", "F"), SYNC[1] as Step, act(0, { op: "undo" })],
    rows: BASE_ROWS
  },
  {
    name: "a row moved before it was deleted comes back at its stored place, not where it was moved nor at the unseen drop",
    steps: [move(0, "F", "D"), ...SYNC, act(0, { op: "delete", rows: ["F"] }), move(1, "F", "A"), SYNC[1] as Step, act(0, { op: "undo" })],
    rows: BASE_ROWS
  }
];

test("E11 review rule (e): a beat whose record has no rank is read at its stored place, and nothing is written", () => {
  for (const item of RANK_CASES) for (const mode of MODES) {
    const result = play({ spec: base(), steps: item.steps, writers: 2, mode, seed: 1 });
    assert.deepEqual([result.never, result.local], [[], []], `${item.name} ${mode}`);
    assert.deepEqual(result.lines, item.rows, `${item.name} ${mode}`);
    assert.ok((result.uses.rank ?? 0) > 0, `${item.name}: the rule was used`);
    assert.equal(result.kinds["a row brought back by an undo after an unseen move is read at its stored place"], 1, item.name);
  }
});

test("E11 review rule (e) control: with the rule off, each of those histories throws", () => {
  for (const item of RANK_CASES) {
    const result = play({ spec: base(), steps: item.steps, writers: 2, mode: "forward", seed: 1, rules: { ...ALL_RULES, rank: false } });
    assert.ok(result.never.some(problem => /threw: Missing rank/.test(problem)), item.name);
  }
});

test("E11 review rule (e): reading a beat without its rank writes nothing", () => {
  const steps = RANK_CASES[0]?.steps ?? [];
  const a = load(seed(base()), 1), b = load(seed(base()), 2);
  try {
    for (const step of steps) {
      if ("by" in step) perform(step.by === 0 ? a : b, step.cmd);
      else if ("from" in step) { const [from, to] = step.from === 0 ? [a, b] : [b, a]; Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote"); }
    }
    const before = Y.encodeStateVector(a.doc);
    assert.deepEqual(outline(a), BASE_ROWS);
    assert.equal(a.beats.get("F")?.has("e10Rank"), false);
    assert.deepEqual(Y.encodeStateVector(a.doc), before);
  } finally { a.destroy(); b.destroy(); }
});

function restored(spec: Spec, deleted: string, beat: string, theirs: Cmd): { fields: Record<string, unknown>; rows: string[] } {
  const a = load(seed(spec), 1), d = load(seed(spec), 2);
  try {
    perform(a, { op: "delete", rows: [deleted] });
    perform(d, theirs);
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(d.doc, Y.encodeStateVector(a.doc)), "remote");
    perform(a, { op: "undo" });
    const fields = a.beats.get(beat)?.toJSON() ?? {};
    return { fields: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "e10Rank")), rows: outline(a) };
  } finally { a.destroy(); d.destroy(); }
}

test("E11 review: the other fields Yjs does not redo after an unseen overwrite are read as unset", () => {
  const withStatus = base();
  withStatus.beats.B = { status: "draft", joined: { into: "A", glue: " " } };
  const status = restored(withStatus, "A", "B", { op: "field", id: "B", key: "status", value: "done" });
  assert.deepEqual(status, { fields: { joined: { into: "A", glue: " " } }, rows: ["A(A+B): abc def / 1\n2", ...BASE_ROWS.slice(2)] }, "a missing status reads as no status");
  const joined = base();
  joined.beats.C = { joined: { into: "A", glue: " " } };
  const lost = restored(joined, "C", "C", { op: "join", id: "C" });
  assert.deepEqual(lost, { fields: {}, rows: BASE_ROWS }, "a beat without its join reads as a row of its own");
});
