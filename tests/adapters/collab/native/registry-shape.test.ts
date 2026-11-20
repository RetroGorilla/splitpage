import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { addBrollProp, removeBrollProp } from "../../../../src/core/production/records.ts";
import type { ValidatedDocument } from "../../../../src/core/document/validated.ts";
import { transactNativeCommand } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { encodeNativeValue, mintNativeId, nativeFieldKey } from "../../../../src/adapters/collab/native/values.ts";
import { convertedScript, joinedScript } from "./helpers.ts";

function source(): ValidatedDocument {
  return migrateRows({
    schema: 2, docId: "registry-shape", title: "Registry shape", rows: [], comments: [],
    people: [{ id: "p1", name: "Camera" }, { id: "p2", name: "Sound" }],
    productionTags: [
      { id: "t_lamp", cat: "prop", name: "Lamp" },
      { id: "t_rope", cat: "prop", name: "Rope" },
      { id: "t_case", cat: "prop", name: "Case" }
    ],
    brollShots: [{ id: "bs1", name: "Wide", origin: "list", props: [{ id: "t_lamp", name: "Lamp" }] }]
  });
}

function withCopies(document: ValidatedDocument, run: (left: NativeScript, right: NativeScript, settle: () => void) => void): void {
  for (const reverse of [false, true]) {
    const seed = convertedScript(document);
    const left = joinedScript(seed, 4), right = joinedScript(seed, 9), replay = joinedScript(seed, 10);
    const seen = Y.encodeStateVector(seed.doc);
    try {
      run(left, right, () => {
        const first = Y.encodeStateAsUpdate(left.doc, seen), second = Y.encodeStateAsUpdate(right.doc, seen);
        for (const update of reverse ? [second, first] : [first, second]) {
          for (const copy of [left, right, replay]) Y.applyUpdate(copy.doc, update, "remote");
        }
        for (const copy of [right, replay]) {
          assert.deepEqual(copy.reader.document(), left.reader.document());
          assert.deepEqual(Y.encodeStateAsUpdate(copy.doc), Y.encodeStateAsUpdate(left.doc));
        }
      });
    } finally { for (const copy of [seed, left, right, replay]) copy.doc.destroy(); }
  }
}

function writeField(root: Y.Map<Y.Map<unknown>>, id: string, field: string, value: unknown): void {
  const entry = root.get(id);
  assert.ok(entry instanceof Y.Map);
  entry.set(nativeFieldKey(field), encodeNativeValue(value));
}

test("native registry maps keep different entries and different top-level fields", () => {
  withCopies(source(), (left, right, settle) => {
    transactNativeCommand(left, () => {
      writeField(left.roots.people, "p1", "name", "Camera crew");
      writeField(left.roots.tags, "t_lamp", "notes", "Use indoors");
      writeField(left.roots.shots, "bs1", "notes", "Start wide");
    });
    transactNativeCommand(right, () => {
      writeField(right.roots.people, "p2", "name", "Sound crew");
      writeField(right.roots.tags, "t_lamp", "status", "have");
      writeField(right.roots.shots, "bs1", "status", "shot");
    });
    settle();
    const document = left.reader.document();
    assert.deepEqual(document.people.map(person => person.name), ["Camera crew", "Sound crew"]);
    assert.deepEqual(document.productionTags.map(tag => [tag?.name, tag?.notes, tag?.status]), [
      ["Lamp", "Use indoors", "have"], ["Rope", "", "needed"], ["Case", "", "needed"]
    ]);
    assert.deepEqual(document.brollShots.map(shot => [shot.notes, shot.status]), [["Start wide", "shot"]]);
    const reloaded = migrateRows(structuredClone(document));
    assert.deepEqual(reloaded.people, document.people);
    assert.deepEqual(reloaded.productionTags, document.productionTags);
    assert.deepEqual(reloaded.brollShots, document.brollShots);
  });
});

type PropEdit = (document: ValidatedDocument) => boolean;

function propNames(document: Pick<ValidatedDocument, "brollShots">): (string | undefined)[] {
  const props = document.brollShots[0]?.props;
  assert.ok(props);
  return props.map(prop => prop?.name);
}

function editProps(script: NativeScript, edit: PropEdit): (string | undefined)[] {
  const document = migrateRows(structuredClone(script.reader.document()));
  assert.equal(script.roots.shots.get("bs1")?.get(nativeFieldKey("props")), encodeNativeValue(document.brollShots[0]?.props));
  assert.equal(edit(document), true);
  const props = document.brollShots[0]?.props;
  assert.ok(props);
  transactNativeCommand(script, () => writeField(script.roots.shots, "bs1", "props", props));
  const names = propNames(document);
  assert.deepEqual(propNames(script.reader.document()), names);
  return names;
}

test("one encoded props array loses an independent addition on the same shot", () => {
  const addRope: PropEdit = document => addBrollProp(document, "bs1", "Rope");
  const addCase: PropEdit = document => addBrollProp(document, "bs1", "Case");
  const combined = source();
  assert.equal(addRope(combined), true);
  assert.equal(addCase(combined), true);
  assert.deepEqual(propNames(combined), ["Lamp", "Rope", "Case"]);
  withCopies(source(), (left, right, settle) => {
    assert.deepEqual(editProps(left, addRope), ["Lamp", "Rope"]);
    const winner = editProps(right, addCase);
    assert.deepEqual(winner, ["Lamp", "Case"]);
    settle();
    assert.deepEqual(propNames(left.reader.document()), winner);
  });
});

test("one encoded props array can overwrite the concurrent removal of a different prop", () => {
  const removeLamp: PropEdit = document => removeBrollProp(document, "bs1", "t_lamp");
  const addCase: PropEdit = document => addBrollProp(document, "bs1", "Case");
  const combined = source();
  assert.equal(removeLamp(combined), true);
  assert.equal(addCase(combined), true);
  assert.deepEqual(propNames(combined), ["Case"]);
  withCopies(source(), (left, right, settle) => {
    assert.deepEqual(editProps(left, removeLamp), []);
    const winner = editProps(right, addCase);
    assert.deepEqual(winner, ["Lamp", "Case"]);
    settle();
    assert.deepEqual(propNames(left.reader.document()), winner);
  });
});

test("core reload replaces a native tag id whose base-36 clock contains a letter", () => {
  const doc = new Y.Doc();
  doc.clientID = 4;
  try {
    doc.getText("clock").insert(0, "0123456789", {});
    const id = mintNativeId(doc, "t_");
    assert.equal(id, "t_4-a");
    const reloaded = migrateRows({ ...source(), productionTags: [{ id, cat: "prop", name: "Lamp" }] });
    assert.equal(reloaded.productionTags[0]?.name, "Lamp");
    assert.notEqual(reloaded.productionTags[0]?.id, id);
  } finally { doc.destroy(); }
});

test("core reload keeps a comment assignee and rebuilds registry entries from surviving markup", () => {
  const initial = source();
  initial.rows.push({ id: "r1",
    audioText: '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Lamp">Lamp</span>',
    visualText: '<span class="broll-key" data-broll-id="bs1">B-roll:</span> Wide' });
  const document = migrateRows({ ...initial, comments: [{ id: "c1", field: "title", body: "Check framing", assignee: "Camera" }],
    brollShots: [{ id: "bs1", name: "Wide", origin: "script", status: "shot", owner: "p1" }],
    productionTags: [{ id: "t_lamp", cat: "prop", name: "Lamp", status: "have" },
      { id: "t_rope", cat: "prop", name: "Rope", owner: "p1" }] });
  const script = convertedScript(document);
  try {
    assert.equal(script.reader.document().productionTags.find(tag => tag?.id === "t_lamp")?.status, "have");
    assert.equal(script.reader.document().brollShots.find(shot => shot.id === "bs1")?.status, "shot");
    transactNativeCommand(script, () => {
      script.roots.people.delete("p1");
      script.roots.tags.delete("t_lamp");
      script.roots.shots.delete("bs1");
    });
    const read = script.reader.document();
    assert.equal(read.productionTags.some(tag => tag?.id === "t_lamp"), false);
    assert.deepEqual(read.brollShots, []);
    const reloaded = migrateRows(structuredClone(read));
    assert.equal(reloaded.people.some(person => person.id === "p1"), false);
    assert.equal(reloaded.comments[0]?.assignee, "Camera");
    assert.equal(reloaded.productionTags.find(tag => tag?.id === "t_rope")?.owner, "");
    assert.equal(reloaded.productionTags.find(tag => tag?.name === "Lamp")?.status, "needed");
    assert.equal(reloaded.brollShots.find(shot => shot.id === "bs1")?.status, "unshot");
  } finally { script.doc.destroy(); }
});
