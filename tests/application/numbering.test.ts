import test from "node:test";
import assert from "node:assert/strict";
import { createNumberingReader } from "../../src/application/session/numbering.ts";
import { deriveDocumentNumbering } from "../../src/core/document/numbering.ts";
import { moveBeatCommand } from "../../src/application/commands/rows.ts";
import { moveSceneCommand, removeSceneCommand } from "../../src/application/commands/scenes.ts";
import { harness, runConfined } from "./session-fakes.ts";
import { changeSet } from "../../src/application/session/change-set.ts";

test("numbering: a large script reuses its projection through prose and status edits", () => {
  const reader = createNumberingReader();
  let idsRead = 0;
  const doc = { rows: Array.from({ length: 2000 }, (_, i) => ({ get id() { idsRead++; return "r" + i; }, audioText: "", status: "todo" })),
    sections: [{ id: "s", name: "Main", firstSceneId: "r1000" }] };
  const initial = reader.read(doc);
  idsRead = 0;
  for (let i = 0; i < 20; i++) {
    const row = doc.rows[i];
    assert.ok(row);
    row.audioText += "typing";
    row.status = "shot";
    reader.changed(changeSet({ cells: [{ rowId: "r" + i, field: "audioText" }, { rowId: "r" + i, field: "status" }] }));
    assert.equal(reader.read(doc), initial);
  }
  assert.equal(idsRead, 0);
  doc.rows.reverse();
  reader.changed(changeSet({ rowsMoved: true }));
  const moved = reader.read(doc);
  assert.notEqual(moved, initial);
  assert.equal(moved.beats["r1999"]?.full, "A.1");
  doc.sections[0] = { id: "s", name: "Main", firstSceneId: "r1999" };
  reader.changed(changeSet({ docFields: ["sections"] }));
  assert.equal(reader.read(doc).scenes[0]?.id, "s");
});

test("numbering: inserted and removed beats, whole replacements and a new document invalidate the read", () => {
  const reader = createNumberingReader();
  const doc = { rows: [{ id: "first" }, { id: "last" }] };
  const initial = reader.read(doc);
  doc.rows.unshift({ id: "inserted" });
  reader.changed(changeSet({ rowsInserted: ["inserted"] }));
  assert.notEqual(reader.read(doc), initial);
  assert.equal(reader.read(doc).beats["first"]?.full, "A.2");
  doc.rows.shift();
  reader.changed(changeSet({ rowsRemoved: ["inserted"] }));
  assert.equal(reader.read(doc).beats["first"]?.full, "A.1");
  doc.rows.reverse();
  reader.changed(changeSet({ whole: true }));
  assert.equal(reader.read(doc).beats["last"]?.full, "A.1");
  assert.equal(reader.read({ rows: [{ id: "another" }] }).beats["another"]?.full, "A.1");
  assert.deepEqual(reader.read(null).scenes, []);
});

function opened() {
  const h = harness();
  h.session.adopt({ rows: ["a", "b", "c", "d", "e"].map(id => ({ id })),
    sections: [{ id: "first", name: "First", firstSceneId: "b" }, { id: "last", name: "Last", firstSceneId: "d" }] });
  return h;
}

test("numbering: moving the first beat advances its header without carrying the old membership", () => {
  const h = opened();
  runConfined(h.session, moveBeatCommand("b", "e", true));
  h.session.read(doc => {
    assert.ok(doc);
    const n = deriveDocumentNumbering(doc);
    assert.equal(n.beats["c"]?.full, "B.1");
    assert.equal(n.beats["b"]?.full, "C.3");
    assert.equal(n.beats["b"]?.scene.id, "last");
    assert.deepEqual(doc.rows.map(r => r.id), ["a", "c", "d", "e", "b"]);
  });
});

test("numbering: dropping on a header changes the first beat even without changing order", () => {
  const h = opened();
  assert.equal(runConfined(h.session, moveBeatCommand("a", "b", false, "first")).kind, "applied");
  h.session.read(doc => {
    assert.ok(doc);
    const n = deriveDocumentNumbering(doc);
    assert.equal(n.scenes.length, 2);
    assert.equal(n.beats["a"]?.scene.id, "first");
    assert.equal(n.beats["b"]?.full, "A.2");
  });
});

test("numbering: moving scenes and removing headers renumbers all retained beats", () => {
  const h = opened();
  runConfined(h.session, moveSceneCommand("last", "first", false));
  h.session.read(doc => {
    assert.ok(doc);
    assert.deepEqual(doc.rows.map(r => deriveDocumentNumbering(doc).beats[r.id]?.full), ["A.1", "B.1", "B.2", "C.1", "C.2"]);
  });
  runConfined(h.session, removeSceneCommand("first"));
  h.session.read(doc => {
    assert.ok(doc);
    assert.equal(deriveDocumentNumbering(doc).beats["b"]?.full, "B.3");
  });
  runConfined(h.session, removeSceneCommand("last"));
  h.session.read(doc => {
    assert.ok(doc);
    assert.equal(deriveDocumentNumbering(doc).scenes.length, 1);
    assert.equal(deriveDocumentNumbering(doc).beats["c"]?.full, "A.5");
  });
});
