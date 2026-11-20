import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { changeNativeRegistry } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeRegistryChange } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { LEGACY_SHOT_PROPS, NATIVE_SHOT_PROPS } from "../../../../src/adapters/collab/native/shot-props.ts";
import { decodeNativeValue } from "../../../../src/adapters/collab/native/values.ts";
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
