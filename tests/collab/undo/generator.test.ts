import test from "node:test";
import assert from "node:assert/strict";
import { generateUndoHistory, runUndoHistory, UNDO_COMMANDS, UNDO_DELIVERIES, UNDO_REVERSALS } from "./generator.ts";
import type { UndoHistory, UndoRun, UndoViolation } from "./generator.ts";
import { keptUndoSeeds, undoLimitFor } from "./limits.ts";

const SEEDS = 300;

function undeclared(run: UndoRun): UndoViolation[] {
  return run.violations.filter(violation => !undoLimitFor(violation));
}

function sweep(writers: 2 | 3): { counts: Record<string, number>; steps: Record<string, number>; limited: number[]; copies: number } {
  const counts: Record<string, number> = {}, steps: Record<string, number> = {}, limited: number[] = [];
  let copies = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const history = generateUndoHistory(seed, writers), run = runUndoHistory(history);
    assert.deepEqual(undeclared(run), [], `writers ${writers} seed ${seed}: ${JSON.stringify(history)}`);
    assert.equal(run.copies.length, history.writers + 1, `writers ${writers} seed ${seed}`);
    for (const copy of run.copies) assert.deepEqual(copy, run.copies[0], `writers ${writers} seed ${seed}`);
    copies += run.copies.length;
    for (const step of history.steps) steps[step.op] = (steps[step.op] ?? 0) + 1;
    for (const [name, value] of Object.entries(run.counts)) counts[name] = (counts[name] ?? 0) + value;
    if (run.violations.length) limited.push(seed);
  }
  return { counts, steps, limited, copies };
}

test("seeded histories, two writers: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(2);
  assert.equal(result.copies, 900);
  assert.deepEqual(result.counts, {
    command: 5328, "command changed nothing": 1351, deliver: 1358, "deliver-dup": 371, "deliver-rev": 322, "effective redo": 762, "effective undo": 1983,
    "empty redo": 572, "empty undo": 343, "identical change cancelled": 36, "nothing to deliver": 223, "undo then redo": 635, "used up redo": 13, "used up undo": 9
  });
  assert.deepEqual(result.steps, {
    bold: 879, delete: 862, deliver: 1504, "deliver-dup": 401, "deliver-rev": 369, insert: 868, redo: 712, replace: 428, scalar: 426, status: 964, tag: 483,
    type: 850, unbold: 463, undo: 1576, "undo-redo": 759, untag: 456
  });
  assert.deepEqual(result.limited, [23, 57, 88, 99, 101, 161, 215, 267, 271]);
});

test("seeded histories, three writers with a late joiner: every copy ends equal and every violation is a declared limit", () => {
  const result = sweep(3);
  assert.equal(result.copies, 1200);
  assert.deepEqual(result.counts, {
    command: 4951, "command changed nothing": 1098, deliver: 1345, "deliver-dup": 357, "deliver-rev": 321, "effective redo": 638, "effective undo": 1680,
    "empty redo": 617, "empty undo": 518, "identical change cancelled": 45, join: 154, "nothing to deliver": 203, "skipped before joining": 807, "undo then redo": 551,
    "used up redo": 11, "used up undo": 5
  });
  assert.deepEqual(result.steps, {
    bold: 952, delete: 832, deliver: 1478, "deliver-dup": 392, "deliver-rev": 356, insert: 900, join: 154, redo: 772, replace: 456, scalar: 455, status: 889, tag: 436,
    type: 838, unbold: 409, undo: 1609, "undo-redo": 782, untag: 444
  });
  assert.deepEqual(result.limited, [22, 28, 37, 49, 80, 102, 130, 140, 171, 173, 186, 191, 249, 257]);
});

test("the generator draws every supported command kind, every reversal and every delivery mode", () => {
  assert.deepEqual([...UNDO_COMMANDS, ...UNDO_REVERSALS, ...UNDO_DELIVERIES], [
    "insert", "type", "delete", "replace", "bold", "unbold", "tag", "untag", "status", "scalar", "undo", "redo", "undo-redo", "deliver", "deliver-dup", "deliver-rev"
  ]);
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
