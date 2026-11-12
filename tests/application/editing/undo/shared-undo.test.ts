import test from "node:test";
import assert from "node:assert/strict";
import { createSharedUndo } from "../../../../src/application/editing/undo/shared-undo.ts";
import type { SharedUndoReversal } from "../../../../src/application/editing/undo/shared-undo.ts";
import type { SharedContentRef, SharedTextAddress } from "../../../../src/core/collab/operations.ts";
import type { SharedStructureCommand, SharedUndoPart, SharedUndoRecord } from "../../../../src/core/collab/undo-record.ts";

function ref(value: string): SharedContentRef { return value as SharedContentRef; }
function cell(beat: string): SharedTextAddress { return { owner: ref(beat), segment: ref("b:" + beat), field: "audioText" }; }
function typed(beat: string, ...ids: string[]): SharedUndoRecord {
  return { label: "typing", selection: null, typing: ids.join(""), parts: [{ kind: "text", target: cell(beat), inserted: ids.map(ref), deleted: [] }] };
}
function erased(beat: string, ...ids: string[]): SharedUndoRecord {
  return { label: "typing", selection: null, typing: "", parts: [{ kind: "text", target: cell(beat), inserted: [], deleted: ids.map(id => ({ identity: ref(id), value: id, marks: [] })) }] };
}
function structure(command: SharedStructureCommand): SharedUndoRecord {
  return { label: command, selection: null, typing: null, parts: [{ kind: "structure", command, operation: ref("op") }] };
}

function harness(supported: readonly string[] = ["text", "scalar"]) {
  const state = { now: 0, reversed: [] as { record: SharedUndoRecord; direction: string }[], next: null as SharedUndoReversal | Error | null, inside: null as (() => void) | null };
  const undo = createSharedUndo({
    now: () => state.now,
    supports: part => supported.includes(part),
    reverse: (record, direction) => {
      state.reversed.push({ record, direction });
      state.inside?.();
      const next = state.next;
      state.next = null;
      if (next instanceof Error) throw next;
      return next ?? { ok: true, effective: true, inverse: { ...record, label: record.label + "'" }, selection: record.selection };
    }
  });
  return { state, undo, run: (record: SharedUndoRecord | null) => undo.perform(() => record) };
}

test("one command is one entry; undo reverses the top entry and redo reverses its inverse", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  state.now = 5000;
  run(typed("R2", "a2"));
  assert.deepEqual(undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
  assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "typing", selection: null });
  assert.deepEqual(state.reversed, [{ record: typed("R2", "a2"), direction: "undo" }]);
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 1, dropped: 0 });
  assert.deepEqual(undo.redo(), { ok: true, effective: true, label: "typing'", selection: null });
  assert.deepEqual(state.reversed[1], { record: { ...typed("R2", "a2"), label: "typing'" }, direction: "redo" });
  assert.deepEqual(undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
});

test("an empty stack answers empty and asks the executor nothing", () => {
  const { undo, state } = harness();
  assert.deepEqual(undo.undo(), { ok: false, empty: true });
  assert.deepEqual(undo.redo(), { ok: false, empty: true });
  assert.deepEqual(state.reversed, []);
});

test("kept: typing in one cell within one second is one entry, undone as one record", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  state.now = 999;
  run(typed("R1", "a2"));
  state.now = 1998;
  run(typed("R1", "a3"));
  assert.equal(undo.sizes().undo, 1);
  undo.undo();
  assert.deepEqual(state.reversed[0]?.record, { label: "typing", selection: null, typing: "a1a2a3", parts: [
    { kind: "text", target: cell("R1"), inserted: [ref("a1")], deleted: [] },
    { kind: "text", target: cell("R1"), inserted: [ref("a2")], deleted: [] },
    { kind: "text", target: cell("R1"), inserted: [ref("a3")], deleted: [] }
  ] });
});

test("kept: a second later, another cell, an explicit break or a command that is not typing starts a new entry", () => {
  const late = harness();
  late.run(typed("R1", "a1"));
  late.state.now = 1000;
  late.run(typed("R1", "a2"));
  assert.equal(late.undo.sizes().undo, 2);

  const elsewhere = harness();
  elsewhere.run(typed("R1", "a1"));
  elsewhere.run(typed("R2", "a2"));
  elsewhere.run(typed("R1", "a3"));
  assert.equal(elsewhere.undo.sizes().undo, 3);

  const broken = harness();
  broken.run(typed("R1", "a1"));
  broken.undo.breakGroup();
  broken.run(typed("R1", "a2"));
  assert.equal(broken.undo.sizes().undo, 2);

  const field: SharedUndoPart = { kind: "scalar", target: { scope: "beat", record: ref("R1") }, field: "lengthSeconds", prior: { clear: true }, written: { value: 4 } };
  const other = harness();
  other.run({ label: "field", selection: null, typing: null, parts: [field] });
  other.run({ label: "field", selection: null, typing: null, parts: [field] });
  other.run(typed("R1", "a1"));
  assert.equal(other.undo.sizes().undo, 3);
});

test("kept: a word begun after a space starts a new entry; the space and a deletion stay in the group", () => {
  const { undo, run, state } = harness();
  const key = (id: string, typing: string): SharedUndoRecord => ({ ...typed("R1", id), typing });
  run(key("a1", "o"));
  run(key("a2", "n"));
  run(key("a3", " "));
  assert.equal(undo.sizes().undo, 1);
  run(erased("R1", "s9"));
  assert.equal(undo.sizes().undo, 1);
  run(key("a4", "t"));
  assert.equal(undo.sizes().undo, 2);
  run(key("a5", "o"));
  assert.equal(undo.sizes().undo, 2);
  undo.undo();
  assert.deepEqual(state.reversed[0]?.record.typing, "to");
  undo.undo();
  assert.deepEqual(state.reversed[1]?.record.typing, "on ");
});

test("kept: an undo or a redo ends the typing group", () => {
  const { undo, run } = harness();
  run(typed("R1", "a1"));
  run(typed("R1", "a2"));
  undo.undo();
  undo.redo();
  run(typed("R1", "a3"));
  assert.equal(undo.sizes().undo, 2);
});

test("kept: a group that deletes all it typed leaves no entry", () => {
  const { undo, run } = harness();
  run(typed("R2", "b1"));
  run(typed("R1", "a1", "a2"));
  run(erased("R1", "a2"));
  assert.equal(undo.sizes().undo, 2);
  run(erased("R1", "a1"));
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  run(typed("R1", "a3"));
  assert.equal(undo.sizes().undo, 2);
});

test("different: a group that deletes earlier text and types the same letter again keeps its entry, which names both characters", () => {
  const { undo, run, state } = harness();
  run(erased("R1", "s1"));
  run(typed("R1", "a1"));
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "typing", selection: null });
  assert.deepEqual(state.reversed.map(asked => asked.record.parts), [[
    { kind: "text", target: cell("R1"), inserted: [], deleted: [{ identity: "s1", value: "s1", marks: [] }] },
    { kind: "text", target: cell("R1"), inserted: ["a1"], deleted: [] }
  ]]);
});

test("kept: 200 entries; the oldest is dropped and only counted", () => {
  const { undo, run, state } = harness();
  for (let index = 0; index < 201; index++) run(typed("R" + index, "a" + index));
  assert.deepEqual(undo.sizes(), { undo: 200, redo: 0, dropped: 1 });
  for (let index = 0; index < 200; index++) assert.equal(undo.undo().ok, true);
  assert.deepEqual(undo.undo(), { ok: false, empty: true });
  assert.deepEqual(state.reversed.at(-1)?.record, typed("R1", "a1"));
  assert.deepEqual(undo.sizes(), { undo: 0, redo: 200, dropped: 1 });
});

test("different: a new command clears redo; nothing is parked", () => {
  const { undo, run } = harness();
  run(typed("R1", "a1"));
  undo.undo();
  assert.equal(undo.sizes().redo, 1);
  run(typed("R1", "a2"));
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  run(erased("R1", "a2"));
  assert.deepEqual(undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
  assert.deepEqual(undo.redo(), { ok: false, empty: true });
});

test("top item: an entry whose change is already gone is used up, adds no redo and reaches no older entry", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  run(typed("R2", "a2"));
  state.next = { ok: true, effective: false, inverse: typed("R2"), selection: null };
  assert.deepEqual(undo.undo(), { ok: true, effective: false, label: "typing", selection: null });
  assert.equal(state.reversed.length, 1);
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "typing", selection: null });
  assert.deepEqual(state.reversed[1]?.record, typed("R1", "a1"));
});

test("a refusal from the executor leaves both stacks as they were", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  run(typed("R2", "a2"));
  undo.undo();
  state.next = { ok: false, reason: "stale-base" };
  assert.deepEqual(undo.undo(), { ok: false, reason: "stale-base" });
  state.next = { ok: false, reason: "stale-base" };
  assert.deepEqual(undo.redo(), { ok: false, reason: "stale-base" });
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 1, dropped: 0 });
  assert.equal(undo.undo().ok, true);
  assert.deepEqual(state.reversed.at(-1)?.record, typed("R1", "a1"));
});

test("an executor that throws leaves the entry on the stack and the error reaches the caller", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  state.next = new Error("unresolvable");
  assert.throws(() => undo.undo(), /unresolvable/);
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "typing", selection: null });
});

const STRUCTURE_COMMANDS: readonly SharedStructureCommand[] = ["segment-create", "split", "split-before", "join", "join-glue", "remove", "restore",
  "segment-move", "heading-create", "heading-finalize", "heading-remove"];

for (const command of STRUCTURE_COMMANDS) test(`not yet: undo of ${command} is refused by name, asks the executor nothing and keeps the stack`, () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  run(structure(command));
  assert.deepEqual(undo.undo(), { ok: false, reason: "undo-unsupported:" + command });
  assert.deepEqual(undo.undo(), { ok: false, reason: "undo-unsupported:" + command });
  assert.deepEqual(state.reversed, []);
  assert.deepEqual(undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
});

test("not yet: one unsupported part refuses the whole entry before any part is reversed", () => {
  const { undo, run, state } = harness(["text"]);
  const mixed: SharedUndoRecord = { label: "mixed", selection: null, typing: null, parts: [...typed("R1", "a1").parts,
    { kind: "status", target: { scope: "beat", record: ref("R1") }, event: ref("e1"), value: "ready" }] };
  run(mixed);
  assert.deepEqual(undo.undo(), { ok: false, reason: "undo-unsupported:status" });
  assert.deepEqual(state.reversed, []);
  assert.equal(undo.sizes().undo, 1);
});

test("recording gap: an undo asked for while a command runs is refused and the earlier entry stays", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  let inside: unknown = null;
  undo.perform(() => {
    inside = [undo.undo(), undo.redo()];
    return typed("R2", "a2");
  });
  assert.deepEqual(inside, [{ ok: false, reason: "command-in-progress" }, { ok: false, reason: "command-in-progress" }]);
  assert.deepEqual(state.reversed, []);
  assert.equal(undo.sizes().undo, 2);
});

test("a command that throws records nothing and leaves the owner usable", () => {
  const { undo, run } = harness();
  run(typed("R1", "a1"));
  assert.throws(() => undo.perform(() => { throw new Error("refused write"); }), /refused write/);
  assert.equal(undo.sizes().undo, 1);
  assert.equal(undo.undo().ok, true);
});

test("an undo asked for inside an undo is refused; a command inside an undo throws and records nothing", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  run(typed("R2", "a2"));
  let nested: unknown = null;
  state.inside = () => { state.inside = null; nested = undo.undo(); };
  assert.equal(undo.undo().ok, true);
  assert.deepEqual(nested, { ok: false, reason: "undo-in-progress" });
  assert.equal(state.reversed.length, 1);
  state.inside = () => { state.inside = null; undo.perform(() => typed("R3", "a3")); };
  assert.throws(() => undo.undo(), /cannot start inside/);
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 1, dropped: 0 });
});

test("kept: while held, undo and redo change nothing; the last release lets them through", () => {
  const { undo, run, state } = harness();
  run(typed("R1", "a1"));
  run(typed("R2", "a2"));
  undo.undo();
  const first = undo.hold(), second = undo.hold();
  assert.deepEqual(undo.undo(), { ok: false, reason: "held" });
  assert.deepEqual(undo.redo(), { ok: false, reason: "held" });
  first();
  first();
  assert.deepEqual(undo.undo(), { ok: false, reason: "held" });
  second();
  assert.equal(state.reversed.length, 1);
  assert.equal(undo.redo().ok, true);
});

test("reset empties both stacks and starts a new lifetime", () => {
  const { undo, run } = harness();
  run(typed("R1", "a1"));
  run(typed("R2", "a2"));
  undo.undo();
  const lifetime = undo.lifetime();
  undo.reset();
  assert.deepEqual(undo.sizes(), { undo: 0, redo: 0, dropped: 0 });
  assert.equal(undo.lifetime(), lifetime + 1);
});

test("the serial moves on every recorded command, undo and redo, and on nothing else", () => {
  const { undo, run, state } = harness();
  const seen = [undo.serial()];
  run(typed("R1", "a1"));
  seen.push(undo.serial());
  run(null);
  seen.push(undo.serial());
  state.next = { ok: false, reason: "stale-base" };
  undo.undo();
  seen.push(undo.serial());
  undo.undo();
  seen.push(undo.serial());
  undo.redo();
  seen.push(undo.serial());
  assert.deepEqual(seen, [0, 1, 1, 1, 2, 3]);
});

test("decided: a cut and a paste into the same cell are two entries even in the same millisecond; undoing the paste leaves the cut", () => {
  const { undo, run, state } = harness();
  run({ ...erased("R1", "s2", "s3"), label: "cut", typing: null });
  run({ ...typed("R1", "a1", "a2"), label: "paste", typing: null });
  run(typed("R1", "a3"));
  assert.equal(undo.sizes().undo, 3);
  undo.undo();
  state.reversed.length = 0;
  assert.equal(undo.sizes().undo, 2);
  assert.deepEqual(undo.undo(), { ok: true, effective: true, label: "paste", selection: null });
  assert.deepEqual(state.reversed.map(entry => entry.record.label), ["paste"]);
  assert.deepEqual(undo.sizes(), { undo: 1, redo: 2, dropped: 0 });
});

test("a remote change has no way in: the owner takes local commands, undo and redo and nothing else", () => {
  const { undo } = harness();
  assert.deepEqual(Object.keys(undo).sort(), ["breakGroup", "hold", "lifetime", "perform", "redo", "reset", "serial", "sizes", "undo"]);
  assert.equal(Object.isFrozen(undo), true);
});
