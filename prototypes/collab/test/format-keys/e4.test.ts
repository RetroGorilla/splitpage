import assert from "node:assert/strict";
import test from "node:test";
import { typingTape } from "../../src/native/tape.ts";
import type { NativeReplica } from "../../src/native/variant.ts";
import { NormalisingReplica, countKeys } from "../../src/format-keys/keys.ts";
import { RATES, afterCollapseUndo, drivePattern, life, typeTape, worstCase } from "../../src/format-keys/life.ts";
import { generateRace, runRace } from "../../src/format-keys/race.ts";
import type { RaceStep } from "../../src/format-keys/race.ts";
import { CheckFailure, World, deltaOf } from "../../src/format-keys/world.ts";

test("two realistic days by two writers match the model on every copy and the stored copy", () => {
  const run = life("act", RATES.realistic as (typeof RATES)["realistic"], 2, 2);
  assert.equal(run.firstMismatch, null);
  assert.ok((run.days.at(-1)?.formattingTotal ?? 0) >= 40);
});

test("the model check fails when one copy loses one character's formatting", () => {
  const world = new World({ rows: [{ id: "one", audioText: "abcdefgh", visualText: "" }] }, "act", 2);
  world.run(0, { op: "format", beat: "one", field: "audioText", from: 2, to: 5, name: "b", on: true });
  world.pullAll();
  assert.deepEqual(world.check(), []);
  const replica = world.writers[1] as NativeReplica, text = replica.cell("one", "audioText").text;
  const keys = Object.keys(deltaOf(replica, "one", "audioText")[1]?.attributes ?? {});
  replica.doc.transact(() => { text.format(3, 1, Object.fromEntries(keys.map(key => [key, null]))); }, "remote");
  const found = world.check();
  assert.equal(found.length, 1);
  assert.equal(found[0]?.copy, "writer 2");
  assert.equal(found[0]?.index, 3);
  world.destroy();
});

type Patch = (replica: NativeReplica) => void;
// why: each fault is made inside the variant's own commands, in memory, so the check sees only what a command left
const noFormat: Patch = replica => {
  const format = replica.format.bind(replica);
  replica.format = (beat, field, from, to, marks) => { if (!Object.values(marks).some(value => value === true)) format(beat, field, from, to, marks); };
};
const noUnformat: Patch = replica => {
  const format = replica.format.bind(replica);
  replica.format = (beat, field, from, to, marks) => { if (Object.values(marks).some(value => value === true)) format(beat, field, from, to, marks); };
};
const noTyping: Patch = replica => {
  const splice = replica.splice.bind(replica);
  replica.splice = (beat, field, from, to, insert) => { if (!insert.length) splice(beat, field, from, to, insert); };
};

test("a day's generated check fails when formatting, unformatting or typing does nothing", () => {
  for (const patch of [noFormat, noUnformat, noTyping]) {
    const run = life("act", RATES.realistic as (typeof RATES)["realistic"], 2, 1, 7, [], patch);
    assert.notEqual(run.firstMismatch, null);
  }
  assert.equal(life("act", RATES.realistic as (typeof RATES)["realistic"], 2, 1).firstMismatch, null);
});

test("each worst-case pattern's check fails when its command does nothing", () => {
  for (const [patch, pattern] of [[noFormat, "prefix"], [noUnformat, "toggle"], [noTyping, "type-inside"], [noTyping, "paste"]] as const) {
    const world = new World({ rows: [{ id: "one", audioText: "o".repeat(400), visualText: "" }] }, "act", 1);
    world.writers.forEach(patch);
    let failed: boolean;
    try { drivePattern(world, pattern, 10); failed = world.check().length > 0; } catch (error) { failed = error instanceof CheckFailure; }
    assert.ok(failed, pattern);
    world.destroy();
  }
});

test("the race check fails when formatting, unformatting or typing does nothing on every copy", () => {
  const cases: [Patch, RaceStep[]][] = [
    [noFormat, [{ op: "add", by: 0, kind: "i", first: "a", last: "b" }]],
    [noUnformat, [{ op: "remove", by: 1, kind: "b", first: "b", last: "c" }]],
    [noTyping, [{ op: "insert", by: 0, after: "a", char: "X", mode: "plain" }]]
  ];
  for (const [patch, steps] of cases) {
    assert.equal(runRace(steps, 2, "updates").same, true);
    const run = runRace(steps, 2, "updates", undefined, patch);
    assert.equal(run.same, false);
    assert.equal(run.ineffective, 1);
  }
});

test("the typing tape by two writers leaves what the model says on every copy", () => {
  const world = new World(typingTape(1).document, "act", 2);
  typeTape(world);
  assert.deepEqual(world.check(), []);
  assert.ok(world.snapshot().formattedCharacters > 500);
  world.destroy();
});

test("growing prefixes stack one key per action; the rule keeps one; one key per kind keeps one", () => {
  const act = worstCase("prefix", "act", 20), rule = worstCase("prefix", "act+norm", 20), name = worstCase("prefix", "name", 20);
  assert.equal(act.keysMax, 20);
  assert.equal(rule.keysMax, 1);
  assert.equal(name.keysMax, 1);
  for (const row of [act, rule, name]) assert.equal(row.mismatches, 0);
  assert.ok(act.bytes > rule.bytes && rule.bytes > name.bytes);
  assert.ok((act.rebuilt?.bytes ?? Infinity) < act.bytes);
  assert.equal(act.collapsed?.keysMax, 1);
});

test("the rule turns off a seen key whose whole run lies inside the new range", () => {
  const replica = new NormalisingReplica(1);
  replica.hydrate({ rows: [{ id: "one", audioText: "abcdefgh", visualText: "" }] });
  replica.format("one", "audioText", 2, 4, { b: true });
  replica.format("one", "audioText", 1, 6, { b: true });
  replica.format("one", "audioText", 0, 3, { b: true });
  assert.equal(replica.turnedOff, 1);
  assert.equal(countKeys(deltaOf(replica, "one", "audioText")).mostOfOneKind, 2);
  replica.destroy();
});

test("a collapse leaves another person's earlier bold beyond the reach of their undo", () => {
  assert.equal(afterCollapseUndo(false), "abcdefgHIj");
  assert.equal(afterCollapseUndo(true), "abCDEfgHIj (the undo changed nothing)");
});

const undoRace: RaceStep[] = [
  { op: "add", by: 0, kind: "b", first: "b", last: "e" },
  { op: "undo", by: 0 },
  { op: "remove", by: 1, kind: "b", first: "a", last: "d" }
];
const edgeRace: RaceStep[] = [
  { op: "add", by: 0, kind: "i", first: "d", last: "d" },
  { op: "add", by: 1, kind: "b", first: "a", last: "d" },
  { op: "insert", by: 1, after: "d", char: "D", mode: "plain" }
];

test("the rule changes what shows: bold comes back on text someone unformatted", () => {
  for (const delivery of ["updates", "shuffled", "state"] as const) {
    const run = runRace(undoRace, 2, delivery);
    assert.equal(run.same, false);
    assert.equal(run.without, "abcdef[gh|i]");
    assert.equal(run.with, "a[bcd|b]ef[gh|i]");
  }
});

test("the rule changes what shows: a letter typed at an edge someone else formatted", () => {
  const run = runRace(edgeRace, 2, "updates");
  assert.equal(run.same, false);
  assert.equal(run.without, "[abc|b][d|b,i][D|i]ef[gh|i]");
  assert.equal(run.with, "[abc|b][d|b,i]Def[gh|i]");
});

test("the rule can lose the original italic when concurrent deletion and formatting are both undone", () => {
  const run = runRace([
    { op: "delete", by: 1, first: "g", last: "h" },
    { op: "add", by: 0, kind: "i", first: "f", last: "h" },
    { op: "undo", by: 1 },
    { op: "undo", by: 0 }
  ], 2, "updates");
  assert.equal(run.same, false);
  assert.equal(run.without, "a[bcd|b]ef[gh|i]");
  assert.equal(run.with, "a[bcd|b]efgh");
});

test("the final agreement check runs even after an earlier difference", () => {
  const run = runRace([...edgeRace, { op: "deliver", from: 1, to: 0 }, { op: "undo", by: 0 }], 2, "updates", replica => {
    const { text, end } = replica.cell("R1", "audioText");
    replica.doc.transact(() => text.insert(end, "Z", {}), "remote");
    replica.changes();
  });
  assert.equal(run.at, 3);
  assert.equal(run.convergedWithout, true);
  assert.equal(run.convergedWith, false);
});

test("the comparison fails when one copy with the rule loses one character's formatting", () => {
  let seed = 1, steps = generateRace(seed, 2, 12);
  while (!runRace(steps, 2, "updates").same) steps = generateRace(++seed, 2, 12);
  const tampered = runRace(steps, 2, "updates", replica => {
    const text = replica.cell("R1", "audioText").text, delta = text.toDelta() as { insert: string; attributes?: Record<string, unknown> }[];
    const target = delta.findIndex(item => Object.keys(item.attributes ?? {}).length > 0);
    const at = delta.slice(0, target).reduce((sum, item) => sum + item.insert.length, 0);
    replica.doc.transact(() => { text.format(at, 1, Object.fromEntries(Object.keys(delta[target]?.attributes ?? {}).map(key => [key, null]))); }, "remote");
  });
  assert.equal(tampered.same, false);
  assert.equal(tampered.copy, "copy 1");
});
