import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { changeNativeRegistry } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeRegistryChange } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { DocumentShape } from "../../../../src/core/document/validated.ts";
import { registryCopies } from "./registry-harness.ts";

type Registry = Extract<NativeRegistryChange, { kind: "create" }>["collection"];
type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = { people: "people", tags: "productionTags", shots: "brollShots" } as const;

function write(script: NativeScript, change: NativeRegistryChange): void {
  assert.equal(changeNativeRegistry(script, change).kind, "written", JSON.stringify(change));
}

function read(script: NativeScript, collection: Registry): (Fields | null | undefined)[] {
  return script.reader.document()[fieldsOf[collection]];
}

function record(script: NativeScript, collection: Registry, id: string): Fields | null {
  return read(script, collection).find(entry => entry?.id === id) ?? null;
}

function set(collection: Registry, id: string, fields: Fields): NativeRegistryChange {
  return { kind: "set", collection, ids: [id], fields };
}

function edits(side: "left" | "right"): NativeRegistryChange[] {
  const left = side === "left", p = left ? "p1" : "p2", t = left ? "t_lamp" : "t_rope", s = left ? "bs1" : "bs2";
  return [
    { kind: "create", collection: "people", fields: { name: "Person " + side } },
    { kind: "create", collection: "tags", fields: { cat: "sound", name: "Tag " + side } },
    { kind: "create", collection: "shots", fields: { name: "Shot " + side } },
    set("people", p, { name: "Changed " + side }),
    set("tags", t, { name: "Changed " + side, notes: "Tag note " + side }),
    { kind: "updateTags", tags: [{ cat: "prop", name: left ? "Lamp" : "Rope" }, { cat: "location", name: "Place " + side }], fields: { status: "have" } },
    set("shots", s, { notes: "Shot note " + side, reshoot: true }),
    { kind: "cycleTagStatus", ids: [t] },
    { kind: "move", collection: "people", id: p, before: null },
    { kind: "move", collection: "tags", id: t, before: null },
    { kind: "move", collection: "shots", id: s, before: null },
    { kind: "remove", collection: "people", ids: [p] },
    { kind: "remove", collection: "tags", ids: [t] },
    { kind: "remove", collection: "shots", ids: [s] },
    { kind: "restore", collection: "people", ids: ["hidden-person-" + side] },
    { kind: "restore", collection: "tags", ids: [left ? "t_hidden1" : "t_hidden2"] },
    { kind: "restore", collection: "shots", ids: ["hidden-shot-" + side] },
    { kind: "addProp", id: s, prop: "New prop " + side },
    { kind: "removeProp", id: s, prop: left ? "t_lamp" : "t_case" },
    { kind: "gear", names: ["Gear " + side] }
  ];
}

function prepareIndependent(seed: NativeScript): void {
  write(seed, set("shots", "bs2", { props: [{ id: "t_case", name: "Case" }] }));
  for (const [collection, id, fields] of [
    ["people", "hidden-person-left", { name: "Hidden Left" }], ["people", "hidden-person-right", { name: "Hidden Right" }],
    ["tags", "t_hidden1", { cat: "prop", name: "Hidden Left" }], ["tags", "t_hidden2", { cat: "prop", name: "Hidden Right" }],
    ["shots", "hidden-shot-left", { name: "Hidden Left" }], ["shots", "hidden-shot-right", { name: "Hidden Right" }]
  ] as const) {
    const added = changeNativeRegistry(seed, { kind: "create", collection, fields });
    assert.ok("created" in added);
    const root = seed.roots[collection], made = root.get(added.created);
    assert.ok(made);
    const copy = made.clone();
    seed.doc.transact(() => { root.delete(added.created); root.set(id, copy); copy.set("removed", true); });
  }
}

function entries(document: DocumentShape): Map<string, Fields> {
  return new Map(Object.values(fieldsOf).flatMap(field => document[field].flatMap(entry => entry
    ? [[field + "/" + entry.id, entry] as const] : [])));
}

function combined(base: Map<string, Fields>, left: Map<string, Fields>, right: Map<string, Fields>): Map<string, Fields> {
  const result = new Map(base);
  for (const edited of [left, right]) {
    for (const key of base.keys()) if (!edited.has(key)) result.delete(key);
    for (const [key, after] of edited) {
      const before = base.get(key);
      if (!before) { result.set(key, after); continue; }
      const patch = Object.fromEntries(Object.entries(after).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(before[field])));
      if (result.has(key) && Object.keys(patch).length) result.set(key, { ...result.get(key), ...patch });
    }
  }
  return result;
}

test("every registry operation can meet an independent operation without losing either visible edit", () => {
  const leftEdits = edits("left"), rightEdits = edits("right");
  for (const first of leftEdits) for (const second of rightEdits) {
    registryCopies((left, right, settle) => {
      const base = entries(left.reader.document());
      write(left, first);
      write(right, second);
      const expected = combined(base, entries(left.reader.document()), entries(right.reader.document()));
      settle();
      assert.deepEqual(entries(left.reader.document()), expected, JSON.stringify([first, second]));
    }, prepareIndependent);
  }
  assert.equal(leftEdits.length * rightEdits.length * 2, 800);
});

const fieldPairs: { collection: Registry; id: string; values: readonly (readonly [string, unknown, unknown])[] }[] = [
  { collection: "people", id: "p1", values: [["name", "Camera left", "Camera right"]] },
  { collection: "tags", id: "t_lamp", values: [["name", "Desk lamp", "Table lamp"], ["notes", "Left", "Right"], ["status", "sourcing", "have"], ["owner", "p2", "p3"]] },
  { collection: "shots", id: "bs1", values: [["name", "Wide left", "Wide right"], ["desc", "Motion left", "Motion right"],
    ["notes", "Note left", "Note right"], ["status", "shot", "shot"], ["owner", "p2", "p3"], ["reshoot", true, true],
    ["location", "Hall", "Roof"], ["audioRef", "Intro", "Outro"],
    ["props", [{ id: "t_rope", name: "Rope" }], [{ id: "t_case", name: "Case" }]]] }
];

test("each pair of writable registry fields keeps distinct keys and converges on one winner for a shared key", () => {
  for (const { collection, id, values } of fieldPairs) for (const [index, [leftField, a]] of values.entries()) {
    for (const [rightField, , b] of values.slice(index)) registryCopies((left, right, settle) => {
      write(left, set(collection, id, { [leftField]: a }));
      write(right, set(collection, id, { [rightField]: b }));
      settle();
      assert.equal(record(left, collection, id)?.id, id);
      assert.deepEqual(record(left, collection, id)?.[leftField], leftField === rightField ? b : a);
      assert.deepEqual(record(left, collection, id)?.[rightField], b);
    });
  }
});

test("each field edit racing removal stays in the kept record and returns with restore", () => {
  for (const { collection, id, values } of fieldPairs) for (const [field, value] of values) registryCopies((left, right, settle) => {
    write(left, set(collection, id, { [field]: value }));
    write(right, { kind: "remove", collection, ids: [id] });
    settle();
    assert.equal(record(left, collection, id), null);
    write(right, { kind: "restore", collection, ids: [id] });
    settle();
    assert.deepEqual(record(left, collection, id)?.[field], value);
  });
});

test("ownership set concurrently with person removal reads empty and returns with restoration", () => {
  for (const [collection, id] of [["tags", "t_rope"], ["shots", "bs2"]] as const) registryCopies((left, right, settle) => {
    write(left, set(collection, id, { owner: "p2" }));
    write(right, { kind: "remove", collection: "people", ids: ["p2"] });
    settle();
    assert.equal(record(left, collection, id)?.owner, "");
    write(right, { kind: "restore", collection: "people", ids: ["p2"] });
    settle();
    assert.equal(record(left, collection, id)?.owner, "p2");
  });
});

test("same-name creations keep distinct minted IDs through reload", () => {
  for (const [collection, fields] of [["people", { name: "Same" }], ["tags", { name: "Same", cat: "prop" }], ["shots", { name: "Same" }]] as const) {
    registryCopies((left, right, settle) => {
      const ids = [left, right].map(script => {
        const result = changeNativeRegistry(script, { kind: "create", collection, fields });
        assert.ok("created" in result);
        return result.created;
      });
      assert.notEqual(ids[0], ids[1]);
      settle();
      assert.deepEqual(read(left, collection).filter(entry => entry?.name === "Same").map(entry => entry?.id).sort(), ids.toSorted());
    });
  }
});

test("simultaneous status writes, moves, removals and restores follow their own stored keys", () => {
  registryCopies((left, right, settle) => {
    write(left, { kind: "cycleTagStatus", ids: ["t_lamp"] });
    write(right, set("tags", "t_lamp", { status: "returned" }));
    settle();
    assert.equal(record(left, "tags", "t_lamp")?.status, "returned");
  });
  for (const [collection, head, second] of [["people", "p1", "p2"], ["tags", "t_lamp", "t_rope"], ["shots", "bs1", "bs2"]] as const) {
    registryCopies((left, right, settle) => {
      write(left, { kind: "move", collection, id: second, before: head });
      write(right, { kind: "move", collection, id: second, before: null });
      settle();
      assert.equal(read(left, collection).at(-1)?.id, second);
    });
    registryCopies((left, right, settle) => {
      write(left, { kind: "move", collection, id: head, before: null });
      write(right, { kind: "remove", collection, ids: [head] });
      settle();
      assert.equal(record(left, collection, head), null);
      write(left, { kind: "restore", collection, ids: [head] });
      write(right, { kind: "restore", collection, ids: [head] });
      settle();
      assert.equal(read(right, collection).at(-1)?.id, head);
      for (const script of [left, right]) write(script, { kind: "remove", collection, ids: [head] });
      settle();
      assert.equal(record(right, collection, head), null);
    });
  }
});

test("a tied drop reranks the right peers and one no-op leaves every byte alone", () => {
  registryCopies((left, right, settle) => {
    write(left, { kind: "move", collection: "people", id: "p1", before: null });
    write(right, { kind: "move", collection: "people", id: "p2", before: null });
    settle();
    assert.deepEqual(read(left, "people").map(entry => entry?.id), ["p3", "p1", "p2"]);
    const before = Y.encodeStateAsUpdate(right.doc);
    assert.deepEqual(changeNativeRegistry(right, { kind: "move", collection: "people", id: "p2", before: null }), { kind: "unchanged" });
    assert.deepEqual(Y.encodeStateAsUpdate(right.doc), before);
    write(left, { kind: "move", collection: "people", id: "p3", before: "p2" });
    settle();
    assert.deepEqual(read(right, "people").map(entry => entry?.id), ["p1", "p3", "p2"]);
  });
});

test("whole-array prop races converge with the documented add and remove losses", () => {
  const add = (prop: string): NativeRegistryChange => ({ kind: "addProp", id: "bs1", prop });
  const remove = (prop: string): NativeRegistryChange => ({ kind: "removeProp", id: "bs1", prop });
  const seed = (script: NativeScript) => write(script, set("shots", "bs1", { props: [{ id: "t_lamp", name: "Lamp" }, { id: "t_rope", name: "Rope" }] }));
  const cases = [
    [add("Case"), add("New"), ["Lamp", "Rope", "New"]],
    [add("Case"), add("Case"), ["Lamp", "Rope", "Case"]],
    [remove("t_lamp"), add("Case"), ["Lamp", "Rope", "Case"]],
    [remove("t_lamp"), remove("t_rope"), ["Lamp"]],
    [remove("t_lamp"), remove("t_lamp"), ["Rope"]]
  ] as const;
  for (const [one, two, names] of cases) registryCopies((left, right, settle) => {
    write(left, one);
    write(right, two);
    settle();
    assert.deepEqual((left.reader.document().brollShots[0]?.props ?? []).map(prop => prop?.name), names);
  }, seed);
});
