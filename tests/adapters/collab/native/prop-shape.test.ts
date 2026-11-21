import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { changeNativeRegistry } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeRegistryChange } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { LEGACY_SHOT_PROPS, NATIVE_SHOT_PROPS } from "../../../../src/adapters/collab/native/shot-props.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { decodeNativeValue, mintNativeTagId } from "../../../../src/adapters/collab/native/values.ts";
import { BROLL_PROPS_MAX } from "../../../../src/core/document/broll.ts";
import type { BrollProp } from "../../../../src/core/document/broll.ts";
import { registryCopies, registryReload, registrySource } from "./registry-harness.ts";

type TrialEdit = { readonly kind: "add" | "edit"; readonly id: string; readonly name: string }
  | { readonly kind: "remove" | "move"; readonly id: string };

const edits: readonly TrialEdit[] = [
  { kind: "add", id: "t_rope", name: "Rope" }, { kind: "add", id: "t_case", name: "Case" },
  { kind: "remove", id: "t_seed1" }, { kind: "remove", id: "t_seed2" },
  { kind: "edit", id: "t_seed1", name: "First changed" }, { kind: "edit", id: "t_seed2", name: "Second changed" },
  { kind: "move", id: "t_seed1" }, { kind: "move", id: "t_seed2" }
];

function initialProps(count: number): BrollProp[] {
  return Array.from({ length: count }, (_, at) => ({ id: "t_seed" + (at + 1), name: "Prop " + (at + 1) }));
}

function source(props: readonly BrollProp[]) {
  return registrySource({ brollShots: [{ id: "shot", name: "Wide", origin: "list", props }] });
}

function propsOf(script: NativeScript): Y.Map<Y.Map<unknown>> {
  const record = script.roots.shots.get("shot"), map = record?.get(NATIVE_SHOT_PROPS);
  assert.ok(map instanceof Y.Map);
  assert.equal(record?.has(LEGACY_SHOT_PROPS), false);
  return map as Y.Map<Y.Map<unknown>>;
}

function read(script: NativeScript) {
  return script.reader.document().brollShots[0]?.props;
}

function write(script: NativeScript, operation: NativeRegistryChange): void {
  assert.equal(changeNativeRegistry(script, operation).kind, "written", JSON.stringify(operation));
}

function command(initial: readonly BrollProp[], edit: TrialEdit): NativeRegistryChange {
  if (edit.kind === "add") return { kind: "addProp", id: "shot", prop: edit.name };
  if (edit.kind === "remove") return { kind: "removeProp", id: "shot", prop: edit.id };
  if (edit.kind === "move") return { kind: "moveProp", id: "shot", prop: edit.id, before: null };
  assert.ok("name" in edit);
  return { kind: "set", collection: "shots", ids: ["shot"],
    fields: { props: initial.map(prop => prop.id === edit.id ? { id: edit.id, name: edit.name } : prop) } };
}

function expected(initial: readonly BrollProp[], pending: readonly TrialEdit[]): BrollProp[] {
  const props = new Map(initial.map(prop => [prop.id, prop.name])), tail = new Set<string>();
  for (const edit of pending) {
    if ("name" in edit) props.set(edit.id, edit.name);
    if (edit.kind === "add" || edit.kind === "move") tail.add(edit.id);
  }
  for (const edit of pending) if (edit.kind === "remove") props.delete(edit.id);
  return [...[...props.keys()].filter(id => !tail.has(id)), ...[...tail].sort()]
    .flatMap(id => props.has(id) ? [{ id, name: props.get(id) as string }] : []);
}

function issue(script: NativeScript, initial: readonly BrollProp[], edit: TrialEdit,
  apply: typeof changeNativeRegistry = changeNativeRegistry): void {
  const operation = command(initial, edit), label = JSON.stringify(operation);
  assert.equal(apply(script, operation).kind, "written", label);
  const snapshot = script.reader.document();
  assert.deepEqual(registryReload(snapshot), snapshot, "Core reload after " + label);
  assert.deepEqual(read(script), expected(initial, [edit]), "Local command effect for " + label);
}

test("the keyed prop shape preserves every generated edit and caps the projection before core reload", () => {
  let runs = 0, overflows = 0;
  for (const count of [3, BROLL_PROPS_MAX - 1]) {
    const initial = initialProps(count);
    for (const [at, first] of edits.entries()) for (const second of edits.slice(at)) {
      const later = second.kind === "edit" ? { ...second, name: second.name + " on the right" } : second;
      const history = JSON.stringify({ count, first, later });
      try {
        registryCopies((left, right, settle) => {
          assert.deepEqual(read(left), initial);
          assert.deepEqual([...propsOf(left).keys()], initial.map(prop => prop.id));
          issue(left, initial, first);
          issue(right, initial, later);
          settle();
          const merged = expected(initial, [first, later]), stored = propsOf(left);
          assert.deepEqual(read(left), merged.slice(0, BROLL_PROPS_MAX));
          const active = [...stored].filter(([, record]) => record.get("removed") !== true);
          assert.deepEqual(active.map(([id, record]) => ({ id, name: decodeNativeValue(record.get("name"))?.value }))
            .sort((one, two) => one.id < two.id ? -1 : one.id > two.id ? 1 : 0),
          merged.toSorted((one, two) => one.id < two.id ? -1 : one.id > two.id ? 1 : 0));
          for (const edit of [first, later]) {
            const record = stored.get(edit.id);
            assert.ok(record);
            if (edit.kind === "remove") assert.equal(record.get("removed"), true);
            if (edit.kind === "move") {
              const stable = initial.filter(prop => ![first, later].some(operation => operation.id === prop.id && operation.kind === "move"));
              assert.ok(stable.every(prop => String(stored.get(prop.id)?.get("rank")) < String(record.get("rank"))));
            }
          }
          if (merged.length > BROLL_PROPS_MAX) {
            assert.deepEqual(merged.slice(-2).map(prop => prop.id), ["t_case", "t_rope"]);
            overflows++;
          }
          runs++;
        }, undefined, source(initial));
      } catch (error) {
        throw new Error("Prop history failed: " + history, { cause: error });
      }
    }
  }
  assert.equal(runs, 144);
  assert.equal(overflows, 2);
});

test("the generated prop oracle rejects a command reporting success without changing its entry", () => {
  const initial = initialProps(3);
  for (const edit of edits) registryCopies(left => {
    assert.throws(() => issue(left, initial, edit, () => ({ kind: "written" })), /Local command effect/);
  }, undefined, source(initial));
});

test("conversion and whole-list set keep valid props with different IDs and a shared normalized name", () => {
  const ropes = [{ id: "t_rope1", name: "Rope" }, { id: "t_rope2", name: "rope" }];
  registryCopies((left, right, settle) => {
    assert.deepEqual(read(left), ropes);
    assert.deepEqual(read(right), ropes);
    write(left, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: ropes.toReversed() } });
    settle();
    assert.deepEqual(read(right), ropes.toReversed());
  }, undefined, source(ropes));
});

test("same-name additions keep and show both IDs through undo, redo and whole-list clear", () => {
  const initial = initialProps(3);
  registryCopies((left, right, settle) => {
    const one = { id: mintNativeTagId(left.doc), name: "Umbrella" }, two = { id: mintNativeTagId(right.doc), name: "umbrella" };
    const [winner, other] = one.id < two.id ? [one, two] : [two, one];
    const actor = winner === one ? left : right;
    const undo = openNativeUndo(actor);
    try {
      for (const [copy, prop] of [[left, one], [right, two]] as const) {
        write(copy, { kind: "addProp", id: "shot", prop: prop.name });
        assert.deepEqual(read(copy), [...initial, prop]);
      }
      settle();
      assert.ok(propsOf(left).has(one.id) && propsOf(left).has(two.id));
      assert.deepEqual(read(left), [...initial, winner, other]);
      assert.equal(undo.undo().kind, "written");
      assert.deepEqual(read(actor), [...initial, other]);
      settle();
      assert.deepEqual(read(left), [...initial, other]);
      assert.equal(undo.redo().kind, "written");
      assert.deepEqual(read(actor), [...initial, winner, other]);
      settle();
      assert.deepEqual(read(left), [...initial, winner, other]);
      write(left, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: [] } });
      settle();
      assert.deepEqual(read(right), []);
      assert.ok([...propsOf(right).values()].every(record => record.get("removed") === true));
    } finally { undo.destroy(); }
  }, undefined, source(initial), true);
});

test("the winner can undo and redo two concurrent additions using the same existing tag ID", () => {
  const initial = initialProps(3), rope = { id: "t_rope", name: "Rope" };
  registryCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    try {
      for (const copy of [left, right]) write(copy, { kind: "addProp", id: "shot", prop: rope.name });
      settle();
      assert.deepEqual(read(left), [...initial, rope]);
      assert.equal(undo.undo().kind, "written");
      assert.deepEqual(read(right), initial);
      settle();
      assert.deepEqual(read(left), initial);
      assert.equal(undo.redo().kind, "written");
      assert.deepEqual(read(right), [...initial, rope]);
      settle();
      assert.deepEqual(read(left), [...initial, rope]);
    } finally { undo.destroy(); }
  }, undefined, source(initial), true);
});

test("undo of removal exposes the concurrent edit of the same prop", () => {
  const initial = initialProps(3), edited = { id: "t_seed2", name: "New name" };
  const withEdit = initial.map(prop => prop.id === edited.id ? edited : prop);
  const removed = initial.filter(prop => prop.id !== edited.id);
  registryCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    try {
      write(left, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: withEdit } });
      write(right, { kind: "removeProp", id: "shot", prop: edited.id });
      settle();
      assert.deepEqual(read(left), removed);
      assert.equal(decodeNativeValue(propsOf(left).get(edited.id)?.get("name"))?.value, edited.name);
      assert.equal(propsOf(left).get(edited.id)?.get("removed"), true);
      assert.equal(undo.undo().kind, "written");
      assert.deepEqual(read(right), withEdit);
      settle();
      assert.deepEqual(read(left), withEdit);
      assert.equal(undo.redo().kind, "written");
      assert.deepEqual(read(right), removed);
      settle();
      assert.deepEqual(read(left), removed);
    } finally { undo.destroy(); }
  }, undefined, source(initial), true);
});

test("undo of a winning same-entry name edit leaves other props visible", () => {
  const initial = initialProps(3);
  registryCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    const edited = (name: string) => initial.map(prop => prop.id === "t_seed2" ? { ...prop, name } : prop);
    const setName = (copy: NativeScript, name: string) => {
      write(copy, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: edited(name) } });
    };
    try {
      setName(left, "First name");
      setName(right, "Second name");
      settle();
      assert.deepEqual(read(left), edited("Second name"));
      assert.equal(undo.undo().kind, "written");
      settle();
      assert.deepEqual(read(left), initial.filter(prop => prop.id !== "t_seed2"));
      assert.equal(undo.redo().kind, "written");
      settle();
      assert.deepEqual(read(left), edited("Second name"));
    } finally { undo.destroy(); }
  }, undefined, source(initial), true);
});

test("concurrent reorders preserve different ranks and the winner's undo follows stock ordering on one rank", () => {
  const initial = initialProps(4);
  for (const same of [false, true]) registryCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    const ids = (copy: NativeScript) => read(copy)?.map(prop => prop?.id);
    try {
      write(left, { kind: "moveProp", id: "shot", prop: same ? "t_seed2" : "t_seed1", before: same ? "t_seed4" : null });
      write(right, { kind: "moveProp", id: "shot", prop: "t_seed2", before: null });
      const merged = same ? ["t_seed1", "t_seed3", "t_seed4", "t_seed2"] : ["t_seed3", "t_seed4", "t_seed1", "t_seed2"];
      const undone = same ? ["t_seed2", "t_seed1", "t_seed3", "t_seed4"] : ["t_seed2", "t_seed3", "t_seed4", "t_seed1"];
      settle();
      assert.deepEqual(ids(left), merged);
      assert.equal(undo.undo().kind, "written");
      assert.deepEqual(ids(right), undone);
      settle();
      assert.equal(propsOf(left).get("t_seed2")?.has("rank"), !same);
      assert.deepEqual(ids(left), undone);
      assert.equal(undo.redo().kind, "written");
      assert.deepEqual(ids(right), merged);
      settle();
      assert.deepEqual(ids(left), merged);
    } finally { undo.destroy(); }
  }, undefined, source(initial), true);
});

test("concurrent adds at the cap keep the hidden entry through undo, redo and removal", () => {
  const initial = initialProps(BROLL_PROPS_MAX - 1);
  const rope = { id: "t_rope", name: "Rope" }, box = { id: "t_case", name: "Case" };
  registryCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    const refuseExtra = () => {
      const before = Y.encodeStateAsUpdate(left.doc);
      assert.deepEqual(changeNativeRegistry(left, { kind: "addProp", id: "shot", prop: "Extra" }), { kind: "refused", reason: "value" });
      assert.deepEqual(Y.encodeStateAsUpdate(left.doc), before);
    };
    try {
      write(left, { kind: "addProp", id: "shot", prop: rope.name });
      write(right, { kind: "addProp", id: "shot", prop: box.name });
      settle();
      assert.deepEqual(read(left), [...initial, box]);
      assert.equal(propsOf(left).size, BROLL_PROPS_MAX + 1);
      assert.ok(propsOf(left).get(rope.id));
      refuseExtra();
      assert.equal(undo.undo().kind, "written");
      assert.deepEqual(read(right), [...initial, rope]);
      settle();
      assert.deepEqual(read(left), [...initial, rope]);
      refuseExtra();
      assert.equal(undo.redo().kind, "written");
      assert.deepEqual(read(right), [...initial, box]);
      settle();
      assert.deepEqual(read(left), [...initial, box]);
      write(left, { kind: "removeProp", id: "shot", prop: "t_seed1" });
      settle();
      assert.deepEqual(read(left), [...initial.slice(1), box, rope]);
      assert.equal(propsOf(left).size, BROLL_PROPS_MAX + 1);
      assert.equal(propsOf(left).get("t_seed1")?.get("removed"), true);
      refuseExtra();
    } finally { undo.destroy(); }
  }, undefined, source(initial), true);
});
