import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { changeNativeRegistry } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeRegistryChange } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { NATIVE_SHOT_PROPS, newNativeShotProp } from "../../../../src/adapters/collab/native/shot-props.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { decodeNativeValue, encodeNativeValue, mintNativeTagId, nativeFieldKey } from "../../../../src/adapters/collab/native/values.ts";
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

function propsOf(script: NativeScript, id = "shot"): Y.Map<Y.Map<unknown>> {
  const record = script.roots.shots.get(id), map = record?.get(NATIVE_SHOT_PROPS);
  assert.ok(map instanceof Y.Map);
  assert.equal(record?.has(nativeFieldKey("props")), false);
  return map as Y.Map<Y.Map<unknown>>;
}

function read(script: NativeScript, id = "shot") {
  return script.reader.document().brollShots.find(shot => shot.id === id)?.props;
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

test("copies converge across generated prop edits and survive core reload", () => {
  let runs = 0, overflows = 0;
  for (const count of [3, BROLL_PROPS_MAX - 1]) {
    const initial = initialProps(count), fixture = source(initial);
    for (const [at, first] of edits.entries()) for (const second of edits.slice(at)) {
      const later = second.kind === "edit" ? { ...second, name: second.name + " on the right" } : second;
      const history = JSON.stringify({ count, first, later });
      try {
        registryCopies((left, right, settle) => {
          for (const copy of [left, right]) assert.deepEqual(copy.reader.document(), fixture);
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
        }, undefined, fixture);
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

test("keeping a projected prop in a whole-list set preserves a concurrent removal of its stored key", () => {
  const lantern = { id: "", name: "Lantern" }, rope = { id: "t_rope", name: "Rope" };
  let projectedId: string;
  registryCopies((left, right, settle) => {
    const projected = { ...lantern, id: projectedId };
    assert.deepEqual(read(left), [projected]);
    assert.deepEqual(read(right), [projected]);
    write(left, { kind: "removeProp", id: "shot", prop: projected.id });
    write(right, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: [projected, rope] } });
    assert.deepEqual(read(right), [projected, rope]);
    assert.equal(propsOf(right).has(projected.id), false);
    settle();
    assert.deepEqual(read(left), [rope]);
    assert.deepEqual(read(right), [rope]);
    assert.equal(propsOf(right).get('n:"lantern"')?.get("removed"), true);
  }, seed => {
    const result = changeNativeRegistry(seed, { kind: "create", collection: "tags", fields: { name: lantern.name, cat: "prop" } });
    assert.equal(result.kind, "written");
    assert.ok("created" in result);
    projectedId = result.created;
  }, source([lantern]));
});

test("targeted prop commands leave a shot without a prop map untouched", () => {
  const initial = initialProps(3);
  registryCopies((left, right, settle) => {
    for (const [copy, name] of [[left, "Rope"], [right, "Case"]] as const) {
      const before = Y.encodeStateAsUpdate(copy.doc);
      assert.deepEqual(read(copy), []);
      for (const command of [
        { kind: "addProp", id: "shot", prop: name },
        { kind: "removeProp", id: "shot", prop: "t_seed1" },
        { kind: "moveProp", id: "shot", prop: "t_seed1", before: null }
      ] as const) assert.deepEqual(changeNativeRegistry(copy, command), { kind: "refused", reason: "stored" });
      assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before);
    }
    settle();
    assert.deepEqual(read(right), []);
  }, seed => {
    const shot = seed.roots.shots.get("shot");
    assert.ok(shot);
    shot.delete(NATIVE_SHOT_PROPS);
  }, source(initial));
});

test("converted and created shots share an empty map before concurrent first adds", () => {
  const empty = source([]), rope = { id: "t_rope", name: "Rope" }, box = { id: "t_case", name: "Case" };
  for (const origin of ["list", "script"] as const) {
    let created: string;
    registryCopies((left, right, settle) => {
      for (const id of ["shot", created]) {
        assert.equal(propsOf(left, id).size, 0);
        assert.equal(propsOf(right, id).size, 0);
        write(left, { kind: "addProp", id, prop: rope.name });
        write(right, { kind: "addProp", id, prop: box.name });
      }
      settle();
      for (const id of ["shot", created]) {
        assert.deepEqual(read(left, id), [box, rope]);
        assert.deepEqual(read(right, id), [box, rope]);
      }
    }, seed => {
      assert.equal(propsOf(seed).size, 0);
      let transactions = 0;
      const observe = () => {
        transactions++;
        for (const id of seed.roots.shots.keys()) assert.ok(propsOf(seed, id));
      };
      seed.roots.shots.observeDeep(observe);
      try {
        const result = changeNativeRegistry(seed, { kind: "create", collection: "shots", fields: { name: "Close", origin } });
        assert.ok("created" in result);
        created = result.created;
        assert.equal(propsOf(seed, created).size, 0);
        assert.equal(transactions, 1);
      } finally { seed.roots.shots.unobserveDeep(observe); }
    }, empty);
  }
});

test("a whole-list set repairs a reported array prop value without adopting its contents", () => {
  const initial = initialProps(3), replacement = [{ id: "t_rope", name: "Rope" }];
  for (const field of [nativeFieldKey("props"), NATIVE_SHOT_PROPS]) registryCopies((left, right, settle) => {
    for (const copy of [left, right]) {
      assert.deepEqual(read(copy), []);
      assert.deepEqual(copy.reader.problems(), [{ kind: "bad-value", where: "shots/shot/props" }]);
    }
    write(left, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: replacement } });
    settle();
    for (const copy of [left, right]) {
      assert.deepEqual(read(copy), replacement);
      assert.deepEqual(copy.reader.problems(), []);
      assert.deepEqual([...propsOf(copy).keys()], ["t_rope"]);
    }
  }, seed => {
    const shot = seed.roots.shots.get("shot");
    assert.ok(shot);
    shot.delete(NATIVE_SHOT_PROPS);
    shot.set(field, field === NATIVE_SHOT_PROPS ? initial : encodeNativeValue(initial));
  }, source(initial));
});

test("damaged prop entries are reported individually and can be replaced or removed on a peer", () => {
  const initial = initialProps(3), broken = initial[1];
  assert.ok(broken);
  const kept = initial.filter(prop => prop !== broken);
  for (const corruption of ["rank", "name", "key", "record"]) for (const repair of ["set", "removeProp"]) {
    registryCopies((left, right, settle) => {
      const stored = left.roots.shots.get("shot")?.get(NATIVE_SHOT_PROPS);
      assert.ok(stored instanceof Y.Map);
      const entries = stored as Y.Map<unknown>, item = entries.get(broken.id);
      assert.ok(item instanceof Y.Map);
      let key = broken.id;
      if (corruption === "rank") item.set("rank", 12);
      else if (corruption === "name") item.set("name", encodeNativeValue(12));
      else if (corruption === "key") {
        entries.delete(key);
        key = 'n:"wrong"';
        entries.set(key, newNativeShotProp(broken, null));
      } else entries.set(key, 12);
      settle();
      assert.deepEqual(read(right), kept);
      const problem = { kind: "bad-value", where: "shots/shot/props/" + key };
      assert.deepEqual(right.reader.problems(), [problem]);
      if (repair === "set") write(right, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: initial } });
      else write(right, { kind: "removeProp", id: "shot", prop: key });
      settle();
      assert.deepEqual(read(left), repair === "set" ? initial : kept);
      assert.deepEqual(left.reader.problems(), []);
    }, undefined, source(initial));
  }
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

test("the losing move's undo and redo leave the winning rank in place", () => {
  const initial = initialProps(4), moving = "t_seed2";
  registryCopies((left, right, settle) => {
    const undo = openNativeUndo(left);
    const ids = (copy: NativeScript) => read(copy)?.map(prop => prop?.id);
    const winning = ["t_seed1", "t_seed3", "t_seed4", moving];
    try {
      write(left, { kind: "moveProp", id: "shot", prop: moving, before: "t_seed4" });
      write(right, { kind: "moveProp", id: "shot", prop: moving, before: null });
      assert.deepEqual(ids(left), ["t_seed1", "t_seed3", moving, "t_seed4"]);
      settle();
      assert.deepEqual(ids(left), winning);
      const rank = propsOf(right).get(moving)?.get("rank"), before = Y.encodeStateAsUpdate(left.doc);
      assert.equal(typeof rank, "string");
      for (const press of [undo.undo, undo.redo]) {
        assert.deepEqual(press(), { kind: "unchanged" });
        assert.deepEqual(Y.encodeStateAsUpdate(left.doc), before);
        settle();
        assert.equal(propsOf(right).get(moving)?.get("rank"), rank);
        assert.deepEqual(ids(right), winning);
      }
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
      write(right, { kind: "set", collection: "shots", ids: ["shot"], fields: { props: [] } });
      settle();
      assert.deepEqual(read(left), []);
      assert.ok([...propsOf(left).values()].every(record => record.get("removed") === true));
      assert.equal(undo.undo().kind, "written");
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
