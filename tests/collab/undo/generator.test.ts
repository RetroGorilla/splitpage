import test from "node:test";
import assert from "node:assert/strict";
import { generateUndoHistory, runUndoHistory, UNDO_COMMANDS, UNDO_DELIVERIES, UNDO_RECORD_COMMANDS, UNDO_RECORD_KEYS, UNDO_REVERSALS } from "./generator.ts";
import { SHARED_UNDO_RECORDS } from "../../../src/adapters/collab/undo-executor.ts";
import type { UndoHistory, UndoRun, UndoViolation } from "./generator.ts";
import { keptUndoSeeds, undoLimitFor } from "./limits.ts";
import { ADAPTER_WORLD, MODEL_WORLD } from "./scenario.ts";
import type { UndoWorldKind } from "./scenario.ts";

const SEEDS = 300;

function undeclared(run: UndoRun): UndoViolation[] {
  return run.violations.filter(violation => !undoLimitFor(violation));
}

function sweep(writers: 2 | 3, kind: UndoWorldKind = MODEL_WORLD): { counts: Record<string, number>; steps: Record<string, number>; limited: Record<string, number[]>; copies: number } {
  const counts: Record<string, number> = {}, steps: Record<string, number> = {}, limited: Record<string, number[]> = {};
  let copies = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const history = generateUndoHistory(seed, writers, 40, kind === ADAPTER_WORLD), run = runUndoHistory(history, kind);
    assert.deepEqual(undeclared(run), [], `writers ${writers} seed ${seed}: ${JSON.stringify(history)}`);
    assert.equal(run.copies.length, history.writers + 1, `writers ${writers} seed ${seed}`);
    for (const copy of run.copies) assert.deepEqual(copy, run.copies[0], `writers ${writers} seed ${seed}`);
    copies += run.copies.length;
    for (const step of history.steps) steps[step.op] = (steps[step.op] ?? 0) + 1;
    for (const [name, value] of Object.entries(run.counts)) counts[name] = (counts[name] ?? 0) + value;
    for (const id of new Set(run.violations.map(violation => undoLimitFor(violation)?.id ?? "undeclared"))) (limited[id] ??= []).push(seed);
  }
  return { counts, steps, limited, copies };
}

test("seeded histories, two writers: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(2);
  assert.equal(result.copies, 900);
  assert.deepEqual(result.counts, {
    command: 5328, "command changed nothing": 1351, deliver: 1358, "deliver-dup": 371, "deliver-rev": 322, "effective redo": 762, "effective undo": 1983,
    "empty redo": 572, "empty undo": 343, "identical change cancelled": 32, "nothing to deliver": 223, "undo then redo": 635, "used up redo": 13, "used up undo": 9
  });
  assert.deepEqual(result.steps, {
    bold: 879, delete: 862, deliver: 1504, "deliver-dup": 401, "deliver-rev": 369, insert: 868, redo: 712, replace: 428, scalar: 426, status: 964, tag: 483,
    type: 850, unbold: 463, undo: 1576, "undo-redo": 759, untag: 456
  });
  assert.deepEqual(result.limited, { "double-restore": [23, 57, 88, 99, 101, 161, 215, 267, 271] });
});

test("seeded histories, three writers with a late joiner: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(3);
  assert.equal(result.copies, 1200);
  assert.deepEqual(result.counts, {
    command: 4951, "command changed nothing": 1098, deliver: 1345, "deliver-dup": 357, "deliver-rev": 321, "effective redo": 638, "effective undo": 1680,
    "empty redo": 617, "empty undo": 518, "identical change cancelled": 43, join: 154, "nothing to deliver": 203, "skipped before joining": 807, "undo then redo": 551,
    "used up redo": 11, "used up undo": 5
  });
  assert.deepEqual(result.steps, {
    bold: 952, delete: 832, deliver: 1478, "deliver-dup": 392, "deliver-rev": 356, insert: 900, join: 154, redo: 772, replace: 456, scalar: 455, status: 889, tag: 436,
    type: 838, unbold: 409, undo: 1609, "undo-redo": 782, untag: 444
  });
  assert.deepEqual(result.limited, { "double-restore": [22, 28, 37, 49, 80, 102, 130, 140, 171, 173, 186, 191, 249, 257] });
});

test("seeded histories on the shared document, two writers: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(2, ADAPTER_WORLD);
  assert.equal(result.copies, 900);
  assert.deepEqual(result.counts, {
    command: 5581, "command changed nothing": 2722, deliver: 963, "deliver-dup": 223, "deliver-rev": 250, "effective redo": 506, "effective undo": 1300,
    "empty redo": 476, "empty undo": 274, "identical change cancelled": 23, "nothing to deliver": 124,
    "record command refused: duplicate-record": 48, "record command refused: foreign-author": 23, "record command refused: missing-or-invalid-record": 926,
    "record command refused: missing-status-target": 662,
    "record-create comments": 236, "record-create people": 215, "record-create replies": 228, "record-create shots": 260, "record-create tags": 231,
    "record-delete comments": 63, "record-delete people": 44, "record-delete replies": 54, "record-delete shots": 62, "record-delete tags": 44,
    "record-set comments": 55, "record-set people": 78, "record-set replies": 69, "record-set shots": 73, "record-set tags": 87,
    "record-status shots": 129, "record-status tags": 132, "undo then redo": 443, "used up redo": 5, "used up undo": 19
  });
  assert.deepEqual(result.steps, {
    bold: 557, delete: 588, deliver: 1055, "deliver-dup": 244, "deliver-rev": 261, insert: 639, "record-create": 1218, "record-delete": 628, "record-set": 950,
    "record-status": 923, redo: 544, replace: 306, scalar: 332, status: 624, tag: 323, type: 613, unbold: 281, undo: 1059, "undo-redo": 534, untag: 321
  });
  assert.deepEqual(result.limited, { "typed-beside-restored": [29, 174, 181, 202, 213, 217, 238, 268, 274], "double-restore": [65, 148, 262] });
});

test("seeded histories on the shared document, three writers with a late joiner: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(3, ADAPTER_WORLD);
  assert.equal(result.copies, 1200);
  assert.deepEqual(result.counts, {
    command: 5097, "command changed nothing": 2558, deliver: 936, "deliver-dup": 266, "deliver-rev": 245, "effective redo": 422, "effective undo": 1118,
    "empty redo": 446, "empty undo": 306, "identical change cancelled": 29, join: 136, "nothing to deliver": 145,
    "record command refused: duplicate-record": 46, "record command refused: foreign-author": 38, "record command refused: missing-or-invalid-record": 830,
    "record command refused: missing-status-target": 688,
    "record-create comments": 248, "record-create people": 249, "record-create replies": 219, "record-create shots": 227, "record-create tags": 224,
    "record-delete comments": 48, "record-delete people": 34, "record-delete replies": 41, "record-delete shots": 41, "record-delete tags": 38,
    "record-set comments": 62, "record-set people": 66, "record-set replies": 47, "record-set shots": 56, "record-set tags": 68,
    "record-status shots": 96, "record-status tags": 95, "skipped before joining": 810, "undo then redo": 368, "used up redo": 4, "used up undo": 15
  });
  assert.deepEqual(result.steps, {
    bold: 607, delete: 587, deliver: 1034, "deliver-dup": 290, "deliver-rev": 268, insert: 628, join: 136, "record-create": 1303, "record-delete": 596, "record-set": 887,
    "record-status": 955, redo: 545, replace: 296, scalar: 307, status: 616, tag: 302, type: 613, unbold: 313, undo: 1024, "undo-redo": 526, untag: 303
  });
  assert.deepEqual(result.limited, { "double-restore": [30, 32, 43, 73, 107, 167, 169], "typed-beside-restored": [59, 63, 68, 73, 135, 146, 147, 169, 212, 251, 261, 283] });
});

test("the generator draws every supported command kind, every reversal and every delivery mode", () => {
  assert.deepEqual([...UNDO_COMMANDS, ...UNDO_REVERSALS, ...UNDO_DELIVERIES], [
    "insert", "type", "delete", "replace", "bold", "unbold", "tag", "untag", "status", "scalar", "undo", "redo", "undo-redo", "deliver", "deliver-dup", "deliver-rev"
  ]);
  assert.deepEqual(UNDO_RECORD_COMMANDS, ["record-create", "record-set", "record-delete", "record-status"]);
  assert.deepEqual(UNDO_RECORD_KEYS.map(([collection]) => collection), SHARED_UNDO_RECORDS);
});

test("a record history is replayed from its literal steps: the undo of a creation the other writer renamed is used up", () => {
  const people = [0.5, 0.9, 0.1] as const, deliver = { op: "deliver", writer: 0, r: [0, 0, 0] } as const;
  const history: UndoHistory = { writers: 2, steps: [
    { op: "record-create", writer: 0, r: people }, deliver, { op: "record-set", writer: 1, r: people }, deliver, { op: "undo", writer: 0, r: people }
  ] };
  const run = runUndoHistory(history, ADAPTER_WORLD);
  assert.deepEqual(run.violations, []);
  assert.deepEqual(run.counts, { command: 2, deliver: 2, "record-create people": 1, "record-set people": 1, "used up undo": 1 });
  assert.deepEqual(run.copies.map(copy => copy.records), Array.from({ length: 3 }, () => ({ "people|P1": '[["id","P1"],["name","vBa"]]' })));
});

for (const kept of keptUndoSeeds) test(`kept seed ${kept.seed}, ${kept.writers} writers, reaches ${kept.reaches} and nothing else`, () => {
  const run = runUndoHistory(generateUndoHistory(kept.seed, kept.writers));
  assert.ok(run.violations.length > 0);
  assert.deepEqual([...new Set(run.violations.map(violation => undoLimitFor(violation)?.id))], [kept.reaches]);
});

test("a history is replayed from its literal steps: the minimal double restore", () => {
  const history: UndoHistory = { writers: 2, steps: [
    { op: "delete", writer: 1, r: [0.5, 0.115, 0.489] },
    { op: "delete", writer: 0, r: [0.577, 0.299, 0.732] },
    { op: "undo", writer: 0, r: [0.533, 0.162, 0.122] },
    { op: "undo", writer: 1, r: [0.274, 0.962, 0.931] }
  ] };
  assert.deepEqual(runUndoHistory(history).violations, [{ check: "restored twice", detail: "R2 10:8 x2", step: 4 }]);
  history.steps.splice(3, 0, { op: "deliver", writer: 0, r: [0.999, 0, 0] }, { op: "deliver", writer: 0, r: [0.999, 0, 0] }, { op: "deliver", writer: 0, r: [0.999, 0, 0] });
  const delivered = runUndoHistory(history);
  assert.deepEqual(delivered.violations, []);
  assert.equal(delivered.counts["effective undo"], 2);
  assert.deepEqual(delivered.copies[0]?.rows[1]?.characters.map(character => [character.root, character.value]), [["10:7", "g"], ["10:8", "h"], ["10:9", "i"], ["10:10", "j"]]);
});

test("the generator reaches an identical tag undone before the other's arrives, and flags a copy that keeps the tag", () => {
  const tag = [0.1, 0.2, 0.9] as const;
  const history: UndoHistory = { writers: 2, steps: [
    { op: "tag", writer: 0, r: tag }, { op: "tag", writer: 1, r: tag }, { op: "undo", writer: 0, r: [0, 0, 0] }
  ] };
  const run = runUndoHistory(history);
  assert.deepEqual(run.violations, []);
  assert.deepEqual(run.counts, { command: 2, "effective undo": 1, "identical change cancelled": 1 });
  assert.deepEqual(run.copies[0]?.rows[0]?.characters.map(character => [character.value, character.marks]),
    [["a", []], ["b", []], ["c", []], ["d", []], ["e", []], ["f", []]]);
  const kept = runUndoHistory({ writers: 2, steps: [...history.steps.slice(0, 2), { op: "deliver", writer: 0, r: [0, 0, 0] }, { op: "deliver", writer: 0, r: [0, 0, 0] }] });
  assert.deepEqual(kept.copies[0]?.rows[0]?.characters.map(character => [character.value, character.marks]),
    [["a", []], ["b", ["tag:P"]], ["c", ["tag:P"]], ["d", ["tag:P"]], ["e", []], ["f", []]]);
});

test("a violation no limit declares fails the sweep's check", () => {
  const run = runUndoHistory({ writers: 2, steps: [] });
  assert.deepEqual(undeclared(run), []);
  run.violations.push({ check: "copies differ", detail: "copy 1", step: 0 }, { check: "restored twice", detail: "R1 10:1 x2", step: 0 });
  assert.deepEqual(undeclared(run), [{ check: "copies differ", detail: "copy 1", step: 0 }]);
});
