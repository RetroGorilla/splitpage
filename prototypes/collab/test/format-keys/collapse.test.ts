import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { collapse } from "../../src/format-keys/keys.ts";
import { readCell } from "../../src/format-keys/model.ts";
import { World, deltaOf, measureUndo } from "../../src/format-keys/world.ts";
import type { NativeReplica } from "../../src/native/variant.ts";

const beat = "one", field = "audioText";

function setup(t: TestContext): [World, NativeReplica, NativeReplica] {
  const world = new World({ rows: [{ id: beat, audioText: "abcdef", visualText: "" }] }, "act", 2);
  t.after(() => world.destroy());
  const [a, b] = world.writers;
  assert.ok(a && b);
  return [world, a, b];
}

function show(replica: NativeReplica): string {
  return readCell(deltaOf(replica, beat, field)).map(char => char.names.includes("b") ? char.ch.toUpperCase() : char.ch).join("");
}

function keys(replica: NativeReplica, index: number): string[] {
  let at = 0;
  for (const item of deltaOf(replica, beat, field)) {
    at += typeof item.insert === "string" ? item.insert.length : 1;
    if (index < at) return Object.keys(item.attributes ?? {}).sort();
  }
  throw new Error(`No letter at ${index}`);
}

function bold(replica: NativeReplica): string {
  replica.format(beat, field, 1, 4, { b: true });
  replica.changes();
  const [key] = keys(replica, 1);
  assert.ok(key);
  return key;
}

function replace(replica: NativeReplica): void {
  assert.equal(collapse(replica, replica.cell(beat, field).text, "b"), 1);
  replica.changes();
}

function settled(world: World, expected: string): void {
  world.pullAll();
  const late = world.reader();
  try {
    for (const copy of [...world.writers, late]) assert.equal(show(copy), expected);
  } finally { late.destroy(); }
}

test("collapse sends an undo past the old bold and deletes the writer's older typing", t => {
  const [world, a, b] = setup(t);
  b.splice(beat, field, 6, 6, [{ text: "X", marks: {} }]);
  b.changes();
  bold(b);
  settled(world, "aBCDefX");
  replace(a);
  settled(world, "aBCDefX");
  measureUndo(b);
  settled(world, "aBCDef");
});

test("two unseen collapses converge and leave both replacement keys", t => {
  const [world, a, b] = setup(t);
  const retired = bold(a);
  settled(world, "aBCDef");
  replace(a);
  replace(b);
  const replacements = [keys(a, 1), keys(b, 1)];
  assert.deepEqual(replacements.map(list => list.length), [1, 1]);
  const replacementKeys = replacements.flat().sort();
  assert.equal(new Set([...replacementKeys, retired]).size, 3);
  settled(world, "aBCDef");
  for (const copy of [a, b]) for (const at of [1, 2, 3]) assert.deepEqual(keys(copy, at), replacementKeys);
});

test("collapse loses an unseen unbold of the entire old range", t => {
  const [world, a, b] = setup(t);
  bold(a);
  settled(world, "aBCDef");
  replace(a);
  b.format(beat, field, 1, 4, { b: null });
  b.changes();
  assert.equal(show(b), "abcdef");
  settled(world, "aBCDef");
  assert.equal(keys(b, 1).length, 1);
});

test("collapse loses an unseen unbold of one letter and keeps the tail's new key", t => {
  const [world, a, b] = setup(t);
  bold(a);
  settled(world, "aBCDef");
  replace(a);
  const replacement = keys(a, 1);
  b.format(beat, field, 2, 3, { b: null });
  b.changes();
  assert.equal(show(b), "aBcDef");
  const tail = keys(b, 3);
  settled(world, "aBCDef");
  for (const copy of [a, b]) {
    assert.deepEqual(keys(copy, 2), replacement);
    assert.deepEqual(keys(copy, 3), [...replacement, ...tail].sort());
  }
});

test("a direct write on another range brings the collapsed key back", t => {
  const [world, a, b] = setup(t);
  const retired = bold(a);
  settled(world, "aBCDef");
  replace(a);
  settled(world, "aBCDef");
  assert.notEqual(keys(b, 1)[0], retired);
  const { start, text } = b.cell(beat, field);
  b.transact(() => text.format(start + 4, 1, { [retired]: true }));
  b.changes();
  settled(world, "aBCDEf");
  for (const copy of [a, b]) assert.deepEqual(keys(copy, 4), [retired]);
});
