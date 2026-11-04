import test from "node:test";
import assert from "node:assert/strict";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";

const rows = ["one", "two", "three", "four"].map(id => ({ id }));

test("numbering: empty videos have no scene, and headerless beats belong to automatic A", () => {
  assert.deepEqual(deriveDocumentNumbering({ rows: [] }).scenes, []);
  const n = deriveDocumentNumbering({ rows });
  assert.deepEqual(n.scenes.map(s => [s.id, s.letter, s.start, s.end]), [[null, "A", 0, 4]]);
  assert.deepEqual(rows.map(r => n.beats[r.id]?.full), ["A.1", "A.2", "A.3", "A.4"]);
});

test("numbering: a first-beat header is A, while a prefix gets its own unnamed A", () => {
  for (const start of [0, 1]) {
    const doc = { rows, sections: [{ id: "opening", name: "Opening", firstSceneId: rows[start]?.id },
      { id: "ending", name: "Ending", firstSceneId: "four" }] };
    const before = JSON.stringify(doc);
    const n = deriveDocumentNumbering(doc);
    assert.deepEqual(n.scenes.map(s => [s.id, s.letter]), start === 0
      ? [["opening", "A"], ["ending", "B"]] : [[null, "A"], ["opening", "B"], ["ending", "C"]]);
    assert.equal(n.beats["two"]?.full, start === 0 ? "A.2" : "B.1");
    assert.equal(n.beats["four"]?.short, "1");
    assert.equal(JSON.stringify(doc), before);
  }
});

test("numbering: scene letters continue through Z, AA, AB and beyond AZ", () => {
  const many = Array.from({ length: 54 }, (_, i) => ({ id: "beat" + i }));
  const n = deriveDocumentNumbering({ rows: many, sections: many.map(r => ({ id: "s" + r.id, name: r.id, firstSceneId: r.id })) });
  assert.deepEqual([25, 26, 27, 51, 52, 53].map(i => n.scenes[i]?.letter), ["Z", "AA", "AB", "AZ", "BA", "BB"]);
  assert.equal(n.beats["beat26"]?.full, "AA.1");
});

test("numbering: shots use tag ordinals in their beat, and absent tags have no number", () => {
  const n = deriveDocumentNumbering({ rows, sections: [{ id: "s", name: "Second", firstSceneId: "two" }] });
  assert.deepEqual(n.shot("three", 1), { full: "B.2.2", short: "2.2" });
  assert.deepEqual(n.shot("two", 0), { full: "B.1.1", short: "1.1" });
  assert.equal(n.shot(null, -1), null);
  assert.equal(n.shot("missing", 0), null);
  assert.equal(n.shot("one", -1), null);
});
