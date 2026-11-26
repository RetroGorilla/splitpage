import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { changeNativeRegistry } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeRegistryChange } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { newNativeShotProps } from "../../../../src/adapters/collab/native/shot-props.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { decodeNativeValue, mintNativeId, mintNativeTagId, nativeFieldKey } from "../../../../src/adapters/collab/native/values.ts";
import type { DocumentShape } from "../../../../src/core/document/validated.ts";
import { arrangePackets, convertedScript, joinedScript } from "./helpers.ts";
import { registryCopies, registrySource, registryUndoCopies } from "./registry-harness.ts";

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

const hiddenEntries = [
    ["people", "hidden-person-left", { name: "Hidden Left" }], ["people", "hidden-person-right", { name: "Hidden Right" }],
    ["tags", "t_hidden1", { cat: "prop", name: "Hidden Left" }], ["tags", "t_hidden2", { cat: "prop", name: "Hidden Right" }],
    ["shots", "hidden-shot-left", { name: "Hidden Left" }], ["shots", "hidden-shot-right", { name: "Hidden Right" }]
] as const;

function prepareIndependent(seed: NativeScript): void {
  write(seed, set("shots", "bs2", { props: [{ id: "t_case", name: "Case" }] }));
  for (const [collection, id, fields] of hiddenEntries) {
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

function expectedRecord(collection: Registry, id: string, fields: Fields): Fields {
  if (collection === "people") return { id, ...fields };
  if (collection === "tags") return { id, owner: "", notes: "", status: "needed", ...fields };
  return { id, desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "list", ...fields };
}

function expectCommand(script: NativeScript, change: NativeRegistryChange, run: typeof changeNativeRegistry = changeNativeRegistry): Map<string, Fields> {
  const base = script.reader.document(), expected = entries(base);
  const key = (collection: Registry, id: string) => fieldsOf[collection] + "/" + id;
  const add = (collection: Registry, id: string, fields: Fields) => expected.set(key(collection, id), expectedRecord(collection, id, fields));
  const patch = (collection: Registry, id: string, fields: Fields) => expected.set(key(collection, id), { ...expected.get(key(collection, id)), ...fields });
  let order: string[] | undefined;
  switch (change.kind) {
    case "create": {
      const id = change.collection === "tags" ? mintNativeTagId(script.doc) : mintNativeId(script.doc, change.collection === "people" ? "p" : "bs");
      add(change.collection, id, change.fields);
      break;
    }
    case "set":
      for (const id of change.ids) {
        patch(change.collection, id, change.fields);
        if (change.collection === "tags" && typeof change.fields.name === "string") for (const shot of base.brollShots) {
          if (shot.props?.some(prop => prop?.id === id)) patch("shots", shot.id, {
            props: shot.props.map(prop => prop?.id === id ? { id, name: change.fields.name } : prop)
          });
        }
      }
      break;
    case "updateTags":
      for (const ref of change.tags) {
        const id = base.productionTags.find(tag => tag?.cat === ref.cat && tag.name === ref.name)?.id;
        if (id) patch("tags", id, change.fields);
        else add("tags", mintNativeTagId(script.doc), { ...ref, ...change.fields });
      }
      break;
    case "cycleTagStatus":
      for (const id of change.ids) patch("tags", id, { status: "sourcing" });
      break;
    case "move": {
      order = base[fieldsOf[change.collection]].flatMap(entry => entry?.id && entry.id !== change.id ? [entry.id] : []);
      order.splice(change.before === null ? order.length : order.indexOf(change.before), 0, change.id);
      break;
    }
    case "remove":
      for (const id of change.ids) {
        expected.delete(key(change.collection, id));
        if (change.collection === "people") for (const [recordKey, record] of expected) {
          if (record.owner === id) expected.set(recordKey, { ...record, owner: "" });
        }
      }
      break;
    case "restore":
      for (const id of change.ids) {
        const entry = hiddenEntries.find(([, hiddenId]) => hiddenId === id);
        assert.ok(entry);
        add(change.collection, id, entry[2]);
      }
      break;
    case "addProp": {
      const id = mintNativeTagId(script.doc), shot = base.brollShots.find(shot => shot.id === change.id);
      add("tags", id, { cat: "prop", name: change.prop });
      patch("shots", change.id, { props: [...shot?.props ?? [], { id, name: change.prop }] });
      break;
    }
    case "removeProp": {
      const shot = base.brollShots.find(shot => shot.id === change.id);
      patch("shots", change.id, { props: shot?.props?.filter(prop => prop?.id !== change.prop) });
      break;
    }
    case "gear":
      for (const tag of base.productionTags) if (tag?.cat === "gear" && tag.id && !change.names.includes(tag.name)) expected.delete(key("tags", tag.id));
      for (const name of change.names) add("tags", mintNativeTagId(script.doc), { cat: "gear", name });
      break;
  }
  const message = `Command effect for ${JSON.stringify(change)}`;
  assert.equal(run(script, change).kind, "written", message);
  assert.deepEqual(entries(script.reader.document()), expected, message);
  if (change.kind === "move") assert.deepEqual(read(script, change.collection).map(entry => entry?.id), order, message);
  return expected;
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
      const expected = combined(base, expectCommand(left, first), expectCommand(right, second));
      settle();
      assert.deepEqual(entries(left.reader.document()), expected, JSON.stringify([first, second]));
    }, prepareIndependent);
  }
  assert.equal(leftEdits.length * rightEdits.length * 2, 800);
});

test("the command oracle catches a muted write for every registry command kind", () => {
  const kinds = new Set<string>();
  for (const change of edits("left")) registryCopies(left => {
    kinds.add(change.kind);
    const muted: typeof changeNativeRegistry = (script, command) => {
      if (command.kind === "set" && command.collection === "tags") {
        return changeNativeRegistry(script, { ...command, fields: { name: command.fields.name } });
      }
      if (command.kind === "updateTags") return changeNativeRegistry(script, { ...command, fields: {} });
      if (command.kind === "gear") return changeNativeRegistry(script, { ...command, names: ["Drone", ...command.names] });
      if (command.kind === "addProp") return changeNativeRegistry(script, { kind: "create", collection: "tags", fields: { cat: "prop", name: command.prop } });
      return { kind: "written" };
    };
    assert.throws(() => expectCommand(left, change, muted), /Command effect/);
  }, prepareIndependent);
  assert.equal(kinds.size, 10);
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
      if (leftField === "props" && rightField === "props") {
        assert.deepEqual(record(left, collection, id)?.props, [{ id: "t_case", name: "Case" }, { id: "t_rope", name: "Rope" }]);
      } else {
        assert.deepEqual(record(left, collection, id)?.[leftField], leftField === rightField ? b : a);
        assert.deepEqual(record(left, collection, id)?.[rightField], b);
      }
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

test("same-name people and shot creations keep distinct minted IDs through reload", () => {
  for (const [collection, fields] of [["people", { name: "Same" }], ["shots", { name: "Same" }]] as const) {
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

test("same-name tags read as one record and keep fields from either creation", () => {
  registryCopies((left, right, settle) => {
    const first = changeNativeRegistry(left, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", status: "have" } });
    const second = changeNativeRegistry(right, { kind: "create", collection: "tags", fields: { cat: "prop", name: "KETTLE", notes: "Handheld" } });
    assert.ok("created" in first && "created" in second);
    assert.notEqual(first.created, second.created);
    settle();
    const id = [first.created, second.created].sort()[0];
    const name = id === first.created ? "Kettle" : "KETTLE";
    assert.deepEqual(read(left, "tags").filter(tag => typeof tag?.name === "string" && tag.name.toLowerCase() === "kettle"),
      [{ id, cat: "prop", name, notes: "Handheld", status: "have", owner: "", sharedFold: true }]);
    assert.ok(left.roots.tags.has(first.created) && left.roots.tags.has(second.created));
  });
});

test("same-name tag conflicts stay reachable until a field is edited and return on undo", () => {
  registryUndoCopies((left, right, settle) => {
    const first = changeNativeRegistry(left, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", notes: "Handheld", owner: "p1", status: "have" } });
    const second = changeNativeRegistry(right, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", notes: "From the kitchen", owner: "p2", status: "returned" } });
    assert.ok("created" in first && "created" in second && first.created < second.created);
    settle();
    const undo = openNativeUndo(left);
    try {
      const tag = () => record(left, "tags", first.created);
      const unmerged = [{ field: "notes", value: "From the kitchen" }, { field: "owner", value: "p2" }, { field: "status", value: "returned" }];
      assert.deepEqual(tag(), { id: first.created, cat: "prop", name: "Kettle", notes: "Handheld", owner: "p1", status: "have", sharedFold: true, unmergedEdits: unmerged });
      write(left, set("tags", second.created, { notes: "For the wide shot" }));
      settle();
      assert.equal(tag()?.notes, "For the wide shot");
      assert.deepEqual(tag()?.unmergedEdits, unmerged.slice(1));
      assert.equal(undo.undo().kind, "written");
      settle();
      assert.equal(tag()?.notes, "Handheld");
      assert.deepEqual(tag()?.unmergedEdits, unmerged);
    } finally { undo.destroy(); }
  });
});

test("removing a folded tag removes both observed records and undo restores both fields", () => {
  registryUndoCopies((left, right, settle) => {
    const first = changeNativeRegistry(left, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", notes: "Handheld" } });
    const second = changeNativeRegistry(right, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", status: "have" } });
    assert.ok("created" in first && "created" in second);
    settle();
    const tag = () => read(left, "tags").filter(entry => entry?.name === "Kettle");
    const folded = tag();
    const undo = openNativeUndo(left);
    try {
      write(left, { kind: "remove", collection: "tags", ids: [first.created] });
      settle();
      assert.deepEqual(tag(), []);
      assert.equal(undo.undo().kind, "written");
      settle();
      assert.deepEqual(tag(), folded);
      assert.equal(undo.redo().kind, "written");
      settle();
      assert.deepEqual(tag(), []);
    } finally { undo.destroy(); }
  });
});

test("a same-name tag unseen by the remover survives delivery", () => {
  registryCopies((left, right, settle) => {
    const first = changeNativeRegistry(left, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle" } });
    const second = changeNativeRegistry(right, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", notes: "Still needed" } });
    assert.ok("created" in first && "created" in second);
    write(left, { kind: "remove", collection: "tags", ids: [first.created] });
    settle();
    assert.deepEqual(read(left, "tags").filter(entry => entry?.name === "Kettle"),
      [{ id: second.created, cat: "prop", name: "Kettle", owner: "", notes: "Still needed", status: "needed" }]);
  });
});

test("a late lower ID changes the tag identity and preserves the explicit edit or reset", () => {
  for (const value of ["Resolved", ""]) {
    const seed = convertedScript(registrySource());
    const [late, first, second] = [joinedScript(seed, 4), joinedScript(seed, 9), joinedScript(seed, 12)];
    try {
      const baseline = Y.encodeStateVector(seed.doc);
      const add = (script: NativeScript, notes: string) => changeNativeRegistry(script, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", notes } });
      const a = add(first, "First"), b = add(second, "Second"), c = add(late, "Late");
      assert.ok("created" in a && "created" in b && "created" in c && c.created < a.created);
      Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(second.doc, baseline), "peer");
      write(first, set("tags", a.created, { notes: value }));
      Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(late.doc, baseline), "peer");
      const all = Y.encodeStateAsUpdate(first.doc, baseline);
      for (const copy of [first, second, late]) {
        Y.applyUpdate(copy.doc, all, "peer");
        assert.equal(record(copy, "tags", c.created)?.notes, value);
        assert.deepEqual(record(copy, "tags", c.created)?.unmergedEdits, [{ field: "notes", value: "Late" }]);
      }
    } finally { for (const copy of [seed, late, first, second]) copy.doc.destroy(); }
  }
});

test("undo of the canonical tag keeps its references and stale commands attached after reload", () => {
  registryUndoCopies((left, right, settle) => {
    const create = { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle" } } as const;
    const undo = openNativeUndo(left);
    try {
      const first = changeNativeRegistry(left, create), second = changeNativeRegistry(right, create);
      assert.ok("created" in first && "created" in second && first.created < second.created);
      settle();
      write(right, { kind: "addProp", id: "bs2", prop: "Kettle" });
      settle();
      assert.deepEqual(record(right, "shots", "bs2")?.props, [{ id: first.created, name: "Kettle" }]);
      assert.equal(undo.undo().kind, "written");
      settle();
      const reopened = joinedScript(right, 15);
      try {
        assert.deepEqual(record(reopened, "shots", "bs2")?.props, [{ id: second.created, name: "Kettle" }]);
        write(reopened, set("tags", first.created, { name: "Tea kettle" }));
        assert.deepEqual(record(reopened, "shots", "bs2")?.props, [{ id: second.created, name: "Tea kettle" }]);
        const reloaded = joinedScript(reopened, 16);
        try {
          write(reloaded, set("tags", first.created, { notes: "Handheld" }));
          assert.equal(record(reloaded, "tags", second.created)?.notes, "Handheld");
          assert.deepEqual(record(reloaded, "shots", "bs2")?.props, [{ id: second.created, name: "Tea kettle" }]);
        } finally { reloaded.doc.destroy(); }
      } finally { reopened.doc.destroy(); }
    } finally { undo.destroy(); }
  });
});

test("independent resolutions clear each field's saved alternatives", () => {
  const edits = [{ field: "notes", value: "Spare" }, { field: "status", value: "have" }];
  registryCopies((left, right, settle) => {
    write(left, set("tags", "t_lamp", { notes: "Pack" }));
    write(right, set("tags", "t_lamp", { status: "returned" }));
    settle();
    assert.deepEqual(record(left, "tags", "t_lamp"), { id: "t_lamp", cat: "prop", name: "Lamp", owner: "", notes: "Pack", status: "returned" });
  }, undefined, registrySource({ productionTags: [{ id: "t_lamp", cat: "prop", name: "Lamp", unmergedEdits: edits }] }));
});

test("three independent same-name creations converge through a reload without rewriting the records", () => {
  const seed = convertedScript(registrySource());
  const copies = [4, 9, 12].map(id => joinedScript(seed, id));
  try {
    const initial = Y.encodeStateVector(seed.doc);
    const ids = copies.map((script, index) => {
      const result = changeNativeRegistry(script, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Kettle", notes: ["A", "B", "C"][index] } });
      assert.ok("created" in result);
      return result.created;
    });
    const updates = copies.map(script => Y.encodeStateAsUpdate(script.doc, initial));
    for (const [index, copy] of copies.entries()) {
      for (const update of arrangePackets(updates, "shuffled", index + 1)) Y.applyUpdate(copy.doc, update, "peer");
      const before = Y.encodeStateAsUpdate(copy.doc);
      assert.deepEqual(read(copy, "tags").filter(tag => tag?.name === "Kettle"), [
        { id: ids[0], cat: "prop", name: "Kettle", owner: "", notes: "A", status: "needed", sharedFold: true, unmergedEdits: [{ field: "notes", value: "B" }, { field: "notes", value: "C" }] }
      ]);
      assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before);
    }
    const first = copies[0];
    assert.ok(first);
    const reopened = joinedScript(first, 15);
    try {
      assert.deepEqual(reopened.reader.document(), first.reader.document());
      const before = Y.encodeStateAsUpdate(reopened.doc);
      assert.deepEqual(changeNativeRegistry(reopened, { kind: "create", collection: "tags", fields: { cat: "prop", name: "Rope" } }), { kind: "unchanged" });
      assert.deepEqual(record(reopened, "tags", "t_rope"), { id: "t_rope", cat: "prop", name: "Rope", owner: "", notes: "", status: "needed" });
      assert.deepEqual(Y.encodeStateAsUpdate(reopened.doc), before);
    } finally { reopened.doc.destroy(); }
  } finally {
    for (const copy of copies) copy.doc.destroy();
    seed.doc.destroy();
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

test("prop races converge and preserve additions and removals on different entries", () => {
  const add = (prop: string): NativeRegistryChange => ({ kind: "addProp", id: "bs1", prop });
  const remove = (prop: string): NativeRegistryChange => ({ kind: "removeProp", id: "bs1", prop });
  const seed = (script: NativeScript) => write(script, set("shots", "bs1", { props: [{ id: "t_lamp", name: "Lamp" }, { id: "t_rope", name: "Rope" }] }));
  const cases = [
    [add("Case"), add("New"), ["Lamp", "Rope", "New", "Case"]],
    [add("Case"), add("Case"), ["Lamp", "Rope", "Case"]],
    [remove("t_lamp"), add("Case"), ["Rope", "Case"]],
    [remove("t_lamp"), remove("t_rope"), []],
    [remove("t_lamp"), remove("t_lamp"), ["Rope"]]
  ] as const;
  for (const [one, two, names] of cases) registryCopies((left, right, settle) => {
    write(left, one);
    write(right, two);
    settle();
    assert.deepEqual((left.reader.document().brollShots[0]?.props ?? []).map(prop => prop?.name), names);
  }, seed);
});

test("readding a displayed prop is a no-op across projected tags and same-name tag races", () => {
  const tagged = registrySource({ rows: [{ id: "r1", audioText: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">Lamp</span>' }] });
  const add = { kind: "addProp", id: "bs2", prop: "Lamp" } as const;
  registryCopies((left, right, settle) => {
    write(left, { kind: "remove", collection: "tags", ids: ["t_lamp"] });
    settle();
    const projection = left.reader.document().productionTags.find(tag => tag?.name === "Lamp");
    assert.ok(projection?.id && !left.roots.tags.has(projection.id));
    const before = Y.encodeStateAsUpdate(left.doc);
    assert.deepEqual(changeNativeRegistry(left, set("shots", "bs2", { props: [{ id: projection.id, name: "Lamp" }] })), { kind: "refused", reason: "value" });
    assert.deepEqual(changeNativeRegistry(left, { kind: "create", collection: "shots", fields: { name: "New", props: [{ id: projection.id, name: "Lamp" }] } }), { kind: "refused", reason: "value" });
    assert.deepEqual(Y.encodeStateAsUpdate(left.doc), before);
    assert.deepEqual(record(left, "shots", "bs3")?.props, [{ id: projection.id, name: "Lamp" }, { id: "t_case", name: "Case" }]);
    write(left, { kind: "removeProp", id: "bs3", prop: "t_case" });
    const props = left.roots.shots.get("bs3")?.get("props");
    assert.ok(props instanceof Y.Map);
    assert.equal(decodeNativeValue(props.get('n:"lamp"')?.get("name"))?.value, "Lamp");
    assert.equal(props.has(projection.id), false);
    assert.equal(props.get("t_case")?.get("removed"), true);
    write(left, add);
    write(right, set("shots", "bs2", { notes: "Peer note" }));
    settle();
    const [prop] = left.reader.document().brollShots.find(shot => shot.id === "bs2")?.props ?? [];
    assert.ok(prop?.id && prop.id !== projection.id && left.roots.tags.has(prop.id));
    write(right, { kind: "restore", collection: "tags", ids: ["t_lamp"] });
    settle();
    for (const copy of [left, right]) {
      const before = Y.encodeStateAsUpdate(copy.doc);
      assert.deepEqual(changeNativeRegistry(copy, add), { kind: "unchanged" });
      assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before);
      assert.deepEqual(record(copy, "shots", "bs2")?.props, [prop]);
    }
  }, seed => {
    const shot = seed.roots.shots.get("bs3");
    assert.ok(shot);
    shot.set("props", newNativeShotProps([{ id: "", name: "Lamp" }, { id: "t_case", name: "Case" }]));
  }, tagged);
  registryCopies((left, right, settle) => {
    const change = { kind: "addProp", id: "bs1", prop: "Umbrella" } as const;
    for (const copy of [left, right]) write(copy, change);
    settle();
    const umbrellas = read(left, "tags").filter(tag => tag?.name === "Umbrella");
    assert.equal(umbrellas.length, 1);
    for (const copy of [left, right]) {
      const before = Y.encodeStateAsUpdate(copy.doc);
      assert.deepEqual(changeNativeRegistry(copy, change), { kind: "unchanged" });
      assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), before);
      assert.deepEqual(copy.reader.document().brollShots[0]?.props?.filter(prop => prop?.name === "Umbrella"),
        [{ id: umbrellas[0]?.id, name: "Umbrella" }]);
    }
    assert.ok(typeof umbrellas[0]?.id === "string");
    write(left, { kind: "removeProp", id: "bs1", prop: umbrellas[0].id });
    settle();
    assert.deepEqual(left.reader.document().brollShots[0]?.props, [{ id: "t_lamp", name: "Lamp" }]);
  });
});

test("a restore that saw one removal is hidden by an unseen removal and fields stay recoverable", () => {
  for (const [collection, id] of [["people", "p1"], ["tags", "t_lamp"], ["shots", "bs1"]] as const) registryCopies((left, right, settle) => {
    const remove = { kind: "remove", collection, ids: [id] } as const, restore = { ...remove, kind: "restore" } as const;
    write(left, set(collection, id, { name: "Updated" }));
    write(left, remove);
    write(right, remove);
    write(left, restore);
    assert.equal(record(left, collection, id)?.name, "Updated");
    settle();
    assert.equal(record(left, collection, id), null);
    assert.equal(record(right, collection, id), null);
    write(left, restore);
    settle();
    assert.equal(record(left, collection, id)?.name, "Updated");
  });
});

test("a move race and the winner's undo leave a usable rankless list in each registry", () => {
  for (const [collection, first, second, third, fields, prefix] of [
    ["people", "p1", "p2", "p3", { name: "New person" }, "p"],
    ["tags", "t_lamp", "t_rope", "t_case", { name: "New tag", cat: "gear" }, "t_"],
    ["shots", "bs1", "bs2", "bs3", { name: "New shot" }, "bs"]
  ] as const) registryUndoCopies((left, right, settle) => {
    const undo = openNativeUndo(right), move = { kind: "move", collection, id: first, before: null } as const;
    try {
      const original = read(left, collection).map(entry => entry?.id);
      for (const script of [left, right]) write(script, move);
      settle();
      assert.deepEqual(read(left, collection).map(entry => entry?.id), [...original.slice(1), first]);
      assert.equal(undo.undo().kind, "written");
      settle();
      for (const script of [left, right]) assert.equal(script.roots[collection].get(first)?.has("rank"), false);
      assert.deepEqual(read(left, collection).map(entry => entry?.id), original);
      const id = collection === "tags" ? mintNativeTagId(left.doc) : mintNativeId(left.doc, prefix);
      assert.deepEqual(changeNativeRegistry(left, { kind: "create", collection, fields }), { kind: "written", created: id });
      write(left, { ...move, id: third, before: second });
      settle();
      const reordered = [first, third, second, ...original.slice(3), id];
      assert.deepEqual(read(left, collection).map(entry => entry?.id), reordered);
      assert.equal(left.roots[collection].get(first)?.has("rank"), false);
      write(right, { ...move, before: third });
      settle();
      assert.equal(left.roots[collection].get(first)?.has("rank"), true);
      assert.deepEqual(read(left, collection).map(entry => entry?.id), reordered);
    } finally { undo.destroy(); }
  });
});

test("a move before a rankless anchor keeps the visible order", () => {
  registryUndoCopies((left, right, settle) => {
    const undo = openNativeUndo(right), move = { kind: "move", collection: "people", id: "p1", before: null } as const;
    try {
      for (const script of [left, right]) write(script, move);
      settle();
      assert.equal(undo.undo().kind, "written");
      settle();
      assert.equal(left.roots.people.get("p1")?.has("rank"), false);
      write(left, { ...move, id: "p2", before: "p1" });
      settle();
      assert.deepEqual(read(left, "people").map(entry => entry?.id), ["p2", "p1", "p3"]);
    } finally { undo.destroy(); }
  });
});

test("a name race and undo hide the nameless person like reload and still allow restore and rename", () => {
  registryUndoCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    try {
      write(left, set("people", "p1", { name: "First name" }));
      write(right, set("people", "p1", { name: "Second name" }));
      settle();
      assert.equal(record(left, "people", "p1")?.name, "Second name");
      assert.equal(undo.undo().kind, "written");
      settle();
      assert.equal(left.roots.people.get("p1")?.has(nativeFieldKey("name")), false);
      assert.equal(record(left, "people", "p1"), null);
      assert.equal(record(left, "tags", "t_lamp")?.owner, "");
      const remove = { kind: "remove", collection: "people", ids: ["p1"] } as const;
      write(left, remove);
      write(left, { ...remove, kind: "restore" });
      settle();
      assert.equal(record(left, "people", "p1"), null);
      write(right, set("people", "p1", { name: "Recovered name" }));
      settle();
      assert.equal(record(left, "people", "p1")?.name, "Recovered name");
      assert.equal(record(left, "tags", "t_lamp")?.owner, "p1");
    } finally { undo.destroy(); }
  });
});

test("undo of one concurrent prop addition preserves the other addition and the seed", () => {
  registryUndoCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    try {
      write(left, { kind: "addProp", id: "bs1", prop: "Rope" });
      write(right, { kind: "addProp", id: "bs1", prop: "Case" });
      settle();
      const lamp = { id: "t_lamp", name: "Lamp" }, rope = { id: "t_rope", name: "Rope" }, box = { id: "t_case", name: "Case" };
      assert.deepEqual(record(left, "shots", "bs1")?.props, [lamp, box, rope]);
      assert.equal(undo.undo().kind, "written");
      assert.deepEqual(record(right, "shots", "bs1")?.props, [lamp, rope]);
      settle();
      assert.equal(left.roots.shots.get("bs1")?.has(nativeFieldKey("props")), false);
      assert.deepEqual(record(left, "shots", "bs1")?.props, [lamp, rope]);
      assert.equal(undo.redo().kind, "written");
      assert.deepEqual(record(right, "shots", "bs1")?.props, [lamp, box, rope]);
      settle();
      assert.deepEqual(record(left, "shots", "bs1")?.props, [lamp, box, rope]);
      write(left, { kind: "removeProp", id: "bs1", prop: "t_lamp" });
      const before = Y.encodeStateAsUpdate(left.doc);
      assert.deepEqual(changeNativeRegistry(left, { kind: "removeProp", id: "bs1", prop: "t_lamp" }), { kind: "unchanged" });
      assert.deepEqual(Y.encodeStateAsUpdate(left.doc), before);
      settle();
      assert.deepEqual(record(right, "shots", "bs1")?.props, [box, rope]);
      write(left, { kind: "addProp", id: "bs1", prop: "Lamp" });
      settle();
      assert.deepEqual(record(right, "shots", "bs1")?.props, [box, rope, lamp]);
    } finally { undo.destroy(); }
  });
});

test("a tag status race and undo default to needed for both status cycle commands", () => {
  for (const cycle of [
    { kind: "cycleTagStatus", ids: ["t_lamp"] },
    { kind: "updateTags", tags: [{ cat: "prop", name: "Lamp" }], fields: {}, cycle: true }
  ] as const) registryUndoCopies((left, right, settle) => {
    const undo = openNativeUndo(right);
    try {
      write(left, set("tags", "t_lamp", { status: "sourcing" }));
      write(right, set("tags", "t_lamp", { status: "have" }));
      settle();
      assert.equal(record(left, "tags", "t_lamp")?.status, "have");
      assert.equal(undo.undo().kind, "written");
      settle();
      assert.equal(left.roots.tags.get("t_lamp")?.has(nativeFieldKey("status")), false);
      assert.equal(record(left, "tags", "t_lamp")?.status, "needed");
      write(left, cycle);
      settle();
      assert.equal(record(right, "tags", "t_lamp")?.status, "sourcing");
    } finally { undo.destroy(); }
  });
});
