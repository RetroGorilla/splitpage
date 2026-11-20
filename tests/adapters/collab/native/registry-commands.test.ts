import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { changeNativeRegistry } from "../../../../src/adapters/collab/native/registry-commands.ts";
import type { NativeRegistryChange } from "../../../../src/adapters/collab/native/registry-commands.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { encodeNativeValue, mintNativeId, mintNativeTagId, nativeFieldKey } from "../../../../src/adapters/collab/native/values.ts";
import { BROLL_PROPS_MAX } from "../../../../src/core/document/broll.ts";
import { isTagId } from "../../../../src/core/document/tags.ts";
import { mintTagId } from "../../../../src/core/document/tags.ts";
import { convertedScript } from "./helpers.ts";
import { registryReload, registrySession, registrySource } from "./registry-harness.ts";

function unchanged(script: NativeScript, change: NativeRegistryChange, reason?: string): void {
  const state = Y.encodeStateAsUpdate(script.doc);
  assert.deepEqual(changeNativeRegistry(script, change), reason ? { kind: "refused", reason } : { kind: "unchanged" });
  assert.deepEqual(Y.encodeStateAsUpdate(script.doc), state);
}

test("registry commands validate the copied request and every target before writing", () => {
  const script = convertedScript(registrySource());
  try {
    const reject = (change: unknown, reason = "value") => unchanged(script, change as NativeRegistryChange, reason);
    reject(null);
    reject({ kind: "not-a-command", ids: [] });
    reject({ kind: "not-a-command", collection: "tags", ids: ["t_lamp"] });
    reject({ kind: "create", collection: "items", fields: { name: "Cup" } });
    reject({ kind: "create", collection: "people", fields: [] });
    reject({ kind: "create", collection: "people", fields: {} });
    reject({ kind: "create", collection: "tags", fields: { name: "Cup" } });
    reject({ kind: "create", collection: "people", fields: { name: "<b>Crew</b>" } });
    reject({ kind: "create", collection: "people", fields: { name: "x".repeat(61) } });
    reject({ kind: "create", collection: "people", fields: { name: "Crew" }, ownerName: "Owner" });
    reject({ kind: "create", collection: "tags", fields: { cat: "unknown", name: "Cup" } });
    reject({ kind: "create", collection: "shots", fields: { name: "New", origin: "unknown" } });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: [] });
    reject({ kind: "set", collection: "people", ids: ["p1", "p1"], fields: { name: "Crew" } });
    reject({ kind: "set", collection: "people", ids: ["bad\u0000"], fields: {} });
    reject({ kind: "set", collection: "people", ids: ["p1", "p2"], fields: { name: "Crew" } });
    reject({ kind: "set", collection: "people", ids: ["p1"], fields: { name: "sound" } });
    reject({ kind: "set", collection: "people", ids: ["p1"], fields: { status: "needed" } });
    reject({ kind: "set", collection: "people", ids: ["p1"], fields: { notes: "Not a person field" } });
    reject({ kind: "set", collection: "people", ids: ["p1"], fields: {}, ownerName: "New person" });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: { name: "Rope" } });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: { status: "shot" } });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: { notes: "x".repeat(2001) } });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: { owner: "missing" } });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: { owner: "p1" }, ownerName: "New" });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: {}, ownerName: "" });
    reject({ kind: "set", collection: "shots", ids: ["bs1"], fields: { reshoot: 1 } });
    reject({ kind: "set", collection: "shots", ids: ["bs1"], fields: { status: "needed" } });
    reject({ kind: "set", collection: "shots", ids: ["bs1"], fields: { location: " roof " } });
    reject({ kind: "set", collection: "shots", ids: ["bs1"], fields: { audioRef: "<b>Line</b>" } });
    reject({ kind: "set", collection: "shots", ids: ["bs1"], fields: { props: [{ id: "t_lamp", name: "Wrong" }] } });
    reject({ kind: "set", collection: "shots", ids: ["bs1"], fields: { origin: "script" } });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp", "absent"], fields: { notes: "New" }, ownerName: "New person" }, "missing");
    reject({ kind: "remove", collection: "shots", ids: ["bs1", "absent"] }, "missing");
    reject({ kind: "restore", collection: "shots", ids: ["bs1"] }, "missing");
    reject({ kind: "move", collection: "shots", id: "bs1", before: "absent" }, "missing");
    reject({ kind: "move", collection: "shots", id: "absent", before: null }, "missing");
    reject({ kind: "move", collection: "shots", id: "bs1", before: 3 });
    reject({ kind: "addProp", id: "", prop: "Rope" }, "missing");
    reject({ kind: "addProp", id: "bs1", prop: "  Rope" });
    reject({ kind: "removeProp", id: "bs1", prop: "" });
    reject({ kind: "addProp", id: "absent", prop: "Rope" }, "missing");
    reject({ kind: "gear", names: ["New", "new"] });
    reject({ kind: "gear", names: ["<b>Drone</b>"] });
    reject({ kind: "updateTags", tags: "Lamp", fields: {} });
    reject({ kind: "updateTags", tags: [], fields: [] });
    reject({ kind: "updateTags", tags: [], fields: {}, cycle: false });
    reject({ kind: "updateTags", tags: [], fields: { name: "New" } });
    reject({ kind: "updateTags", tags: [], fields: { status: "have" }, cycle: true });
    reject({ kind: "updateTags", tags: [{ cat: "invalid", name: "Lamp" }], fields: {} });
    reject({ kind: "updateTags", tags: [{ cat: "prop", name: "Lamp" }, { cat: "prop", name: "lamp" }], fields: { status: "have" } });
    reject({ kind: "set", collection: "tags", ids: ["t_lamp"], fields: { get notes() { throw new Error("argument"); } } });
    unchanged(script, { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { status: "needed" } });
    unchanged(script, { kind: "set", collection: "tags", ids: [], fields: {}, ownerName: "New person" });
    unchanged(script, { kind: "create", collection: "people", fields: { name: "camera" } });
    unchanged(script, { kind: "create", collection: "tags", fields: { cat: "prop", name: "lamp" } });
    unchanged(script, { kind: "move", collection: "shots", id: "bs1", before: "bs2" });
    unchanged(script, { kind: "move", collection: "shots", id: "bs1", before: "bs1" });
    unchanged(script, { kind: "addProp", id: "bs1", prop: "Lamp" });
    unchanged(script, { kind: "addProp", id: "bs1", prop: " Lamp " });
    unchanged(script, { kind: "removeProp", id: "bs1", prop: "t_rope" });
    unchanged(script, { kind: "gear", names: ["Drone"] });
    unchanged(script, { kind: "updateTags", tags: [], fields: {}, ownerName: "New person" });
  } finally { script.doc.destroy(); }
});

test("registry commands copy caller values once and refuse busy and closing writes", () => {
  const script = convertedScript(registrySource());
  const change = { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { notes: "Planned" } } as const;
  try {
    let calls = 0;
    const argument = { ...change, fields: { get notes() { calls++; return calls === 1 ? "Planned" : "Changed"; } } };
    assert.deepEqual(changeNativeRegistry(script, argument), { kind: "written" });
    assert.equal(calls, 1);
    assert.equal(script.reader.document().productionTags[0]?.notes, "Planned");
    script.doc.transact(() => unchanged(script, { ...change, fields: { notes: "Busy" } }, "busy"));
    script.doc.once("beforeTransaction", () => script.close());
    unchanged(script, { ...change, fields: { notes: "Late" } }, "closed");
    unchanged(script, { ...change, fields: { notes: "Closed" } }, "closed");
  } finally { script.doc.destroy(); }
});

test("registry preparation guards both document handles and skips getters when busy or held", () => {
  const script = convertedScript(registrySource()), second = openNativeScript(script.doc), session = registrySession();
  const change = { kind: "create", collection: "people", fields: { name: "New person" } } as const;
  const edit = { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { notes: "Nested" } } as const;
  try {
    for (const handle of [script, second]) {
      let nestedReads = 0;
      let nested: ReturnType<typeof changeNativeRegistry> | undefined;
      unchanged(script, { ...change, get fields(): typeof change.fields {
        nested = changeNativeRegistry(handle, { ...edit, get fields() { nestedReads++; return edit.fields; } });
        throw new Error("argument");
      } }, "value");
      assert.deepEqual(nested, { kind: "refused", reason: "busy" });
      assert.equal(nestedReads, 0);
    }
    let reads = 0;
    const argument = { ...change, get fields() { reads++; return change.fields; } };
    script.doc.transact(() => unchanged(second, argument, "busy"));
    const state = session.encodeState(), release = session.holdIngress();
    assert.equal(session.acceptsPeerUpdate(), false);
    assert.deepEqual(session.commands.changeRegistry(argument), { kind: "refused", reason: "busy" });
    release();
    assert.equal(session.acceptsPeerUpdate(), true);
    assert.deepEqual(session.encodeState(), state);
    assert.equal(reads, 0);
    assert.equal(session.commands.changeRegistry({ ...change, get fields() {
      assert.equal(session.acceptsPeerUpdate(), false);
      assert.deepEqual(session.commands.changeRegistry(argument), { kind: "refused", reason: "busy" });
      return change.fields;
    } }).kind, "written");
    assert.equal(reads, 0);
  } finally { script.doc.destroy(); session.close(); }
});

test("registry operations obey full admission and all refuse at the ceiling", () => {
  const seed = registrySession();
  assert.equal(seed.commands.changeRegistry({ kind: "remove", collection: "tags", ids: ["t_case"] }).kind, "written");
  const state = seed.encodeState();
  seed.close();
  const changes: readonly NativeRegistryChange[] = [
    { kind: "create", collection: "people", fields: { name: "New" } },
    { kind: "create", collection: "tags", fields: { cat: "prop", name: "New" } },
    { kind: "create", collection: "shots", fields: { name: "New" } },
    { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { notes: "New" } },
    { kind: "updateTags", tags: [{ cat: "prop", name: "New" }], fields: { status: "have" } },
    { kind: "cycleTagStatus", ids: ["t_lamp"] },
    { kind: "move", collection: "people", id: "p1", before: null },
    { kind: "addProp", id: "bs1", prop: "New" },
    { kind: "gear", names: ["Drone", "New"] },
    { kind: "remove", collection: "tags", ids: ["t_rope"] },
    { kind: "restore", collection: "tags", ids: ["t_case"] },
    { kind: "removeProp", id: "bs1", prop: "t_lamp" }
  ];
  for (const ceiling of [false, true]) for (const change of changes) {
    const session = openNativeSession({ kind: "state", state }, {
      actor: "Writer", sanitize: String, sizeLimit: ceiling ? Math.floor(state.byteLength / 2) : state.byteLength, sizeCeilingRatio: ceiling ? 1.05 : 3
    });
    try {
      assert.equal(session.size, "full");
      const before = session.encodeState(), result = session.commands.changeRegistry(change);
      if (!ceiling && ["remove", "restore", "removeProp"].includes(change.kind)) assert.equal(result.kind, "written", change.kind);
      else {
        assert.deepEqual(result, { kind: "refused", reason: "full" }, change.kind);
        assert.deepEqual(session.encodeState(), before, change.kind);
      }
    } finally { session.close(); }
  }
});

test("missing and damaged stored inputs refuse a whole registry command", () => {
  const script = convertedScript(registrySource());
  try {
    const shot = script.roots.shots.get("bs1"), tag = script.roots.tags.get("t_lamp"), person = script.roots.people.get("p1");
    assert.ok(shot && tag && person);
    const mark = nativeFieldKey("name");
    person.set(mark, "broken JSON");
    unchanged(script, { kind: "set", collection: "people", ids: ["p1"], fields: { name: "New" } }, "stored");
    person.set("removed", true);
    unchanged(script, { kind: "restore", collection: "people", ids: ["p1"] }, "stored");
    person.set("removed", false);
    unchanged(script, { kind: "remove", collection: "people", ids: ["p1"] }, "stored");
    person.set("rank", "bad0");
    unchanged(script, { kind: "move", collection: "people", id: "p2", before: "p1" }, "stored");
    unchanged(script, { kind: "create", collection: "people", fields: { name: "New" } }, "stored");
    const props = shot.get("props");
    assert.ok(props instanceof Y.Map);
    const lamp = props.get("t_lamp");
    assert.ok(lamp instanceof Y.Map);
    lamp.set("name", "not JSON");
    unchanged(script, { kind: "addProp", id: "bs1", prop: "Rope" }, "stored");
    tag.set(nativeFieldKey("status"), encodeNativeValue("unknown"));
    unchanged(script, { kind: "cycleTagStatus", ids: ["t_rope", "t_lamp"] }, "stored");
    unchanged(script, { kind: "updateTags", tags: [{ cat: "prop", name: "Rope" }, { cat: "prop", name: "Lamp" }], fields: {}, cycle: true }, "stored");
    tag.set(nativeFieldKey("cat"), encodeNativeValue("unknown"));
    unchanged(script, { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { name: "Table lamp" } }, "stored");
    const second = script.roots.tags.get("t_rope");
    assert.ok(second);
    second.set(nativeFieldKey("notes"), "not JSON");
    unchanged(script, { kind: "set", collection: "tags", ids: ["t_lamp", "t_rope"], fields: { notes: "New" } }, "stored");
    script.roots.people.set("broken", false as unknown as Y.Map<unknown>);
    unchanged(script, { kind: "remove", collection: "people", ids: ["broken"] }, "stored");
    script.roots.tags.set("broken", false as unknown as Y.Map<unknown>);
    unchanged(script, { kind: "gear", names: ["Drone", "New"] }, "stored");
  } finally { script.doc.destroy(); }
});

test("prop commands refuse stored tag IDs the core would replace", () => {
  const script = convertedScript(registrySource());
  try {
    const record = script.roots.tags.get("t_rope");
    assert.ok(record);
    script.roots.tags.set("invalid-tag-id", record.clone());
    script.roots.tags.delete("t_rope");
    unchanged(script, { kind: "addProp", id: "bs1", prop: "Rope" }, "stored");
    unchanged(script, { kind: "updateTags", tags: [{ cat: "prop", name: "Rope" }], fields: { notes: "Set" } }, "stored");
  } finally { script.doc.destroy(); }
});

test("moves exclude tombstones and appends reserve their ranks for restoration", () => {
  const script = convertedScript(registrySource());
  try {
    const remove = { kind: "remove", collection: "people", ids: ["p3"] } as const;
    assert.equal(changeNativeRegistry(script, remove).kind, "written");
    unchanged(script, { kind: "move", collection: "people", id: "p1", before: "p3" }, "missing");
    const created = changeNativeRegistry(script, { kind: "create", collection: "people", fields: { name: "New" } });
    assert.ok("created" in created);
    const rank = (id: string) => String(script.roots.people.get(id)?.get("rank"));
    assert.ok(rank(created.created) > rank("p3"));
    assert.equal(changeNativeRegistry(script, { ...remove, kind: "restore" }).kind, "written");
    assert.deepEqual(script.reader.document().people.map(person => person.id), ["p1", "p2", "p3", created.created]);
  } finally { script.doc.destroy(); }
});

test("field guards read names, resolved targets, and touched encodings before committing", () => {
  const script = convertedScript(registrySource());
  try {
    const tag = script.roots.tags.get("t_lamp"), shot = script.roots.shots.get("bs1");
    assert.ok(tag && shot);
    tag.set(nativeFieldKey("name"), "bad JSON");
    unchanged(script, { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { notes: "New" } }, "stored");
    tag.set(nativeFieldKey("name"), encodeNativeValue("Lamp"));
    const bulk = { kind: "updateTags", tags: [{ cat: "prop", name: "Rope" }, { cat: "prop", name: "Lamp" }], fields: { notes: "Bulk" } } as const;
    tag.set("removed", false);
    unchanged(script, bulk, "stored");
    tag.delete("removed");
    tag.set(nativeFieldKey("notes"), "bad JSON");
    unchanged(script, bulk, "stored");
    shot.delete("props");
    shot.set(nativeFieldKey("props"), encodeNativeValue({ length: 1, prop: "Lamp" }));
    assert.deepEqual(script.reader.document().brollShots[0]?.props, []);
    unchanged(script, { kind: "addProp", id: "bs1", prop: "Rope" }, "stored");
    const clone = shot.clone();
    script.roots.shots.set("", clone);
    clone.set(nativeFieldKey("props"), encodeNativeValue([]));
    unchanged(script, { kind: "addProp", id: "", prop: "Lamp" }, "missing");
  } finally { script.doc.destroy(); }
});

test("gear keeps used tags and refuses invalid gear removal targets", () => {
  const script = convertedScript(registrySource({ rows: [{ id: "r1", audioText: '<span class="tag-anchor" data-tag-cat="gear" data-tag-name="Drone">Drone</span>' }] }));
  try {
    const command = { kind: "gear", names: ["Tripod"] } as const;
    assert.equal(changeNativeRegistry(script, command).kind, "written");
    assert.deepEqual(script.reader.document().productionTags.filter(tag => tag?.cat === "gear").map(tag => tag?.name), ["Drone", "Tripod"]);
    const tripod = script.reader.document().productionTags.find(tag => tag?.name === "Tripod");
    assert.ok(tripod?.id);
    const entry = script.roots.tags.get(tripod.id);
    assert.ok(entry);
    entry.set("removed", false);
    unchanged(script, { kind: "gear", names: [] }, "stored");
    entry.delete("removed");
    script.roots.tags.set("", entry.clone());
    unchanged(script, { kind: "gear", names: [] }, "stored");
  } finally { script.doc.destroy(); }
});

test("tag IDs survive reload at a lettered clock and taken IDs stay taken until the clock moves", () => {
  const script = convertedScript(registrySource());
  try {
    script.doc.clientID = 4;
    script.doc.getText("clock").insert(0, "0123456789", {});
    for (const offset of [0, Number.MAX_SAFE_INTEGER]) assert.ok(isTagId(mintNativeTagId(script.doc, offset)));
    const created = mintNativeTagId(script.doc), command = { kind: "create", collection: "tags", fields: { cat: "prop", name: "Table" } } as const;
    const claim = new Y.Doc();
    claim.clientID = 9;
    try {
      const hidden = new Y.Map<unknown>();
      claim.getMap("tags").set(created, hidden);
      hidden.set("rank", "V");
      hidden.set("removed", true);
      Y.applyUpdate(script.doc, Y.encodeStateAsUpdate(claim), "peer");
    } finally { claim.destroy(); }
    unchanged(script, command, "taken");
    unchanged(script, command, "taken");
    unchanged(script, { kind: "gear", names: ["New gear"] }, "taken");
    unchanged(script, { kind: "updateTags", tags: [{ cat: "prop", name: "Lamp" }, { cat: "prop", name: "New" }], fields: { notes: "Bulk" } }, "taken");
    const moveClock = { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { notes: "New note" } } as const;
    assert.deepEqual(changeNativeRegistry(script, moveClock), { kind: "written" });
    const next = mintNativeTagId(script.doc);
    assert.notEqual(next, created);
    assert.deepEqual(changeNativeRegistry(script, command), { kind: "written", created: next });
    const document = script.reader.document();
    assert.ok(document.productionTags.some(tag => tag?.id === next));
    assert.deepEqual(document, registryReload(document));
  } finally { script.doc.destroy(); }
});

test("used removals read back like core reload and a kept registry record restores its fields", () => {
  const document = registrySource({ rows: [{ id: "r1",
    audioText: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">Lamp</span>',
    visualText: '<span class="broll-key" data-broll-id="bs1">B-roll:</span> Wide' }],
  comments: [{ id: "c1", field: "title", body: "Check framing", assignee: "Camera" }] });
  const script = convertedScript(document);
  try {
    const change = (action: NativeRegistryChange) => assert.equal(changeNativeRegistry(script, action).kind, "written");
    const initial = script.reader.document();
    unchanged(script, { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { name: "Desk lamp" } }, "value");
    unchanged(script, { kind: "set", collection: "shots", ids: ["bs1"], fields: { name: "Scene" } }, "value");
    unchanged(script, { kind: "set", collection: "shots", ids: ["bs1"], fields: { desc: "New description" } }, "value");
    change({ kind: "remove", collection: "people", ids: ["p1"] });
    assert.equal(script.reader.document().comments[0]?.assignee, "Camera");
    assert.equal(script.reader.document().productionTags[0]?.owner, "");
    assert.equal(script.reader.document().brollShots[0]?.owner, "");
    assert.deepEqual(script.reader.document(), registryReload({ ...initial, people: initial.people.filter(person => person.id !== "p1") }));
    change({ kind: "remove", collection: "tags", ids: ["t_lamp"] });
    assert.deepEqual(script.reader.document(), registryReload({ ...initial, people: initial.people.filter(person => person.id !== "p1"),
      productionTags: initial.productionTags.filter(tag => tag?.id !== "t_lamp") }));
    change({ kind: "remove", collection: "shots", ids: ["bs1"] });
    const expected = registryReload({ ...initial, people: initial.people.filter(person => person.id !== "p1"),
      productionTags: initial.productionTags.filter(tag => tag?.id !== "t_lamp"), brollShots: initial.brollShots.filter(shot => shot.id !== "bs1") });
    assert.deepEqual(script.reader.document(), expected);
    unchanged(script, { kind: "set", collection: "tags", ids: ["t_lamp"], fields: { notes: "Gone" } }, "missing");
    change({ kind: "restore", collection: "shots", ids: ["bs1"] });
    change({ kind: "restore", collection: "tags", ids: ["t_lamp"] });
    change({ kind: "restore", collection: "people", ids: ["p1"] });
    assert.deepEqual(script.reader.document(), initial);
    change({ kind: "remove", collection: "people", ids: ["p1"] });
    change({ kind: "set", collection: "people", ids: ["p3"], fields: { name: "camera" } });
    unchanged(script, { kind: "restore", collection: "people", ids: ["p1"] }, "value");
  } finally { script.doc.destroy(); }
});

test("removing a legacy name collision heals the visible name without changing its stored form", () => {
  const broken = "\ud800Lamp", original = registrySource({ people: [{ id: "p1", name: "Lamp" }, { id: "p2", name: broken }] });
  const script = convertedScript(original);
  try {
    assert.equal(script.reader.document().people[1]?.name, broken);
    const remove = { kind: "remove", collection: "people", ids: ["p1"] } as const;
    assert.equal(changeNativeRegistry(script, remove).kind, "written");
    const document = script.reader.document();
    assert.deepEqual(document.people, [{ id: "p2", name: "Lamp" }]);
    assert.deepEqual(registryReload(document), document);
    assert.equal(script.roots.people.get("p2")?.get(nativeFieldKey("name")), encodeNativeValue(broken));
    assert.equal(changeNativeRegistry(script, { ...remove, kind: "restore" }).kind, "written");
    assert.deepEqual(script.reader.document().people, original.people);
  } finally { script.doc.destroy(); }
});

test("unkeyed shot removal stays absent until core reload derives a new shot ID", () => {
  const script = convertedScript(registrySource({ rows: [{ id: "r1", visualText: "B-roll: Wide" }] }));
  try {
    assert.equal(script.reader.document().brollShots.find(shot => shot.name === "Wide")?.id, "bs1");
    assert.equal(changeNativeRegistry(script, { kind: "remove", collection: "shots", ids: ["bs1"] }).kind, "written");
    const captured = script.reader.document();
    assert.equal(captured.brollShots.some(shot => shot.name === "Wide"), false);
    const reloaded = registryReload(captured).brollShots.find(shot => shot.name === "Wide");
    assert.ok(reloaded && reloaded.id !== "bs1");
  } finally { script.doc.destroy(); }
});

test("bulk edits materialize projected tags even when their projected IDs name tombstones", () => {
  const defaultId = mintTagId("prop", "Lamp");
  for (const id of ["t_lamp", defaultId]) {
    const script = convertedScript(registrySource({ rows: [{ id: "r1", audioText: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">Lamp</span>' }],
      productionTags: [{ id, name: "Lamp", cat: "prop" }] }));
    try {
      assert.equal(changeNativeRegistry(script, { kind: "remove", collection: "tags", ids: [id] }).kind, "written");
      assert.equal(script.reader.document().productionTags[0]?.id, defaultId);
      assert.equal(changeNativeRegistry(script, { kind: "updateTags", tags: [{ cat: "prop", name: "Lamp" }], fields: { notes: "New" } }).kind, "written");
      const tag = script.reader.document().productionTags.find(tag => tag?.name === "Lamp");
      assert.ok(tag?.id && tag.id !== defaultId && script.roots.tags.has(tag.id));
      assert.equal(tag.notes, "New");
      assert.equal(script.roots.tags.get(id)?.get("removed"), true);
    } finally { script.doc.destroy(); }
  }
});

test("shot creation allows a separate list entry with the same name as a keyed shot", () => {
  const doc = registrySource({ rows: [{ id: "r1", visualText: '<span class="broll-key" data-broll-id="bs1">B-roll:</span> Wide' }] });
  const script = convertedScript(doc);
  try {
    const name = { kind: "create", collection: "shots", fields: { name: "Wide" } } as const;
    const written = changeNativeRegistry(script, name);
    assert.ok("created" in written);
    const document = script.reader.document();
    assert.deepEqual(document.brollShots.filter(shot => shot.name === "Wide").map(shot => shot.id), ["bs1", written.created]);
    assert.deepEqual(document, registryReload(document));
    script.roots.shots.delete("bs1");
    script.roots.shots.delete(written.created);
    unchanged(script, { ...name, fields: { name: "Wide", desc: "Does not match the line" } }, "value");
  } finally { script.doc.destroy(); }
});

test("prop cap refuses an additional prop and a created prop and tag are one write", () => {
  const full = Array.from({ length: BROLL_PROPS_MAX }, (_, at) => ({ id: "", name: "Prop " + at }));
  const script = convertedScript(registrySource({ brollShots: [{ id: "bs1", name: "Wide", props: full }] }));
  try {
    unchanged(script, { kind: "addProp", id: "bs1", prop: "New prop" }, "value");
    assert.equal(changeNativeRegistry(script, { kind: "removeProp", id: "bs1", prop: "n:prop 0" }).kind, "written");
    assert.equal(changeNativeRegistry(script, { kind: "addProp", id: "bs1", prop: "New prop" }).kind, "written");
    const document = script.reader.document(), tag = document.productionTags.find(item => item?.name === "New prop");
    assert.ok(tag && isTagId(tag.id));
    assert.deepEqual(document.brollShots[0]?.props?.at(-1), { id: tag.id, name: tag.name });
    assert.deepEqual(registryReload(document), document);
  } finally { script.doc.destroy(); }
});

test("a bulk tag edit updates existing tags, creates missing tags and resolves one shared owner", () => {
  const script = convertedScript(registrySource());
  try {
    const tags = [{ cat: "prop", name: "Lamp" }, { cat: "gear", name: "Tripod" }, { cat: "gear", name: "Strap" }];
    assert.deepEqual(changeNativeRegistry(script, { kind: "updateTags", tags, fields: { notes: "Prep" }, cycle: true, ownerName: "Crew" }), { kind: "written" });
    const document = script.reader.document(), owner = document.people.find(person => person.name === "Crew");
    assert.ok(owner);
    const edited = document.productionTags.filter(tag => tag?.notes === "Prep");
    assert.deepEqual(edited.map(tag => [tag?.name, tag?.status, tag?.owner]), tags.map(tag => [tag.name, "sourcing", owner.id]));
    assert.equal(edited[0]?.id, "t_lamp");
    assert.equal(new Set(edited.map(tag => tag?.id)).size, 3);
    assert.deepEqual(document, registryReload(document));
  } finally { script.doc.destroy(); }
});

test("registry operations each use one undo step and peer edits never enter the local stack", () => {
  const actions: readonly NativeRegistryChange[] = [
    { kind: "create", collection: "people", fields: { name: "New" } },
    { kind: "create", collection: "tags", fields: { cat: "prop", name: "New" }, ownerName: "New owner" },
    { kind: "create", collection: "shots", fields: { name: "New" } },
    { kind: "set", collection: "people", ids: ["p1"], fields: { name: "New" } },
    { kind: "set", collection: "tags", ids: ["t_lamp", "t_rope"], fields: { notes: "New" }, ownerName: "New owner" },
    { kind: "set", collection: "shots", ids: ["bs1", "bs2"], fields: { status: "shot" } },
    { kind: "updateTags", tags: [{ cat: "prop", name: "Lamp" }, { cat: "prop", name: "New" }], fields: { status: "have" }, ownerName: "New owner" },
    { kind: "cycleTagStatus", ids: ["t_lamp", "t_rope"] },
    { kind: "move", collection: "shots", id: "bs1", before: null },
    { kind: "remove", collection: "people", ids: ["p1"] },
    { kind: "remove", collection: "tags", ids: ["t_lamp"] },
    { kind: "remove", collection: "shots", ids: ["bs1"] },
    { kind: "restore", collection: "people", ids: ["p1"] },
    { kind: "restore", collection: "tags", ids: ["t_lamp"] },
    { kind: "restore", collection: "shots", ids: ["bs1"] },
    { kind: "addProp", id: "bs1", prop: "New prop" },
    { kind: "removeProp", id: "bs1", prop: "t_lamp" },
    { kind: "gear", names: ["Strap", "Tripod"] }
  ];
  for (const action of actions) {
    const local = registrySession();
    try {
      if (action.kind === "restore") {
        const root = local.ydoc.getMap<Y.Map<unknown>>(action.collection);
        local.ydoc.transact(() => root.get(action.ids[0] as string)?.set("removed", true), "peer");
      }
      const initial = local.document();
      assert.equal(local.commands.changeRegistry(action).kind, "written", JSON.stringify(action));
      const changed = local.document();
      assert.notDeepEqual(changed, initial);
      assert.equal(local.commands.undo().kind, "written");
      assert.deepEqual(local.document(), initial);
      assert.deepEqual(local.commands.undo(), { kind: "unchanged" });
      assert.equal(local.commands.redo().kind, "written");
      assert.deepEqual(local.document(), changed);
    } finally { local.close(); }
  }
  const local = registrySession(), peerDoc = new Y.Doc();
  try {
    const change = { kind: "create", collection: "people", fields: { name: "Local" } } as const;
    Y.applyUpdate(peerDoc, local.encodeState(), "peer");
    const root = peerDoc.getMap<Y.Map<unknown>>("people");
    peerDoc.transact(() => { root.get("p2")?.set(nativeFieldKey("name"), encodeNativeValue("Remote")); });
    Y.applyUpdate(local.ydoc, Y.encodeStateAsUpdate(peerDoc), "peer");
    assert.deepEqual(local.commands.undo(), { kind: "unchanged" });
    assert.equal(local.commands.changeRegistry(change).kind, "written");
    assert.equal(local.commands.undo().kind, "written");
    assert.equal(local.document().people.find(person => person.id === "p2")?.name, "Remote");
    assert.deepEqual(local.commands.undo(), { kind: "unchanged" });
  } finally { local.close(); peerDoc.destroy(); }
});

test("consecutive registry commands open separate undo steps", () => {
  const session = registrySession();
  try {
    const initial = session.document();
    assert.equal(session.commands.changeRegistry({ kind: "create", collection: "people", fields: { name: "Crew" } }).kind, "written");
    const afterPerson = session.document();
    assert.equal(session.commands.changeRegistry({ kind: "gear", names: ["Tripod", "Strap"] }).kind, "written");
    assert.equal(session.commands.undo().kind, "written");
    assert.deepEqual(session.document(), afterPerson);
    assert.equal(session.commands.undo().kind, "written");
    assert.deepEqual(session.document(), initial);
  } finally { session.close(); }
});

test("people and shot creation use the existing client-and-clock mint", () => {
  const source = registrySource(), script = convertedScript(source);
  try {
    assert.deepEqual(script.reader.document(), source);
    for (const [collection, prefix] of [["people", "p"], ["shots", "bs"]] as const) {
      const created = mintNativeId(script.doc, prefix);
      assert.deepEqual(changeNativeRegistry(script, { kind: "create", collection, fields: { name: "New" } }), { kind: "written", created });
    }
    assert.deepEqual(script.reader.document(), registryReload(script.reader.document()));
  } finally { script.doc.destroy(); }
});
