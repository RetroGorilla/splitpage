import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { fromDocument, toDocument } from "../../src/proj/document.ts";
import { inventoryFields, runRoundTrips } from "../../src/proj/experiment.ts";
import { assertProjectionMapping, projectionFieldMapping } from "../../src/proj/mapping.ts";
import { appReferences } from "../../src/proj/reference.ts";
import { mapValue } from "../../src/schema.ts";

test("PROJ inventory: every current field row has a location in both candidates", () => {
  const inventory = inventoryFields();
  assert.equal(inventory.length, 96, "The brief says 93; the current inventory contains 96");
  assertProjectionMapping(inventory, projectionFieldMapping);
});

for (const candidate of ["A", "B"] as const) {
  for (const field of projectionFieldMapping) test(`PROJ omitted mapping ${candidate}: ${field.field}`, () => {
    const broken = projectionFieldMapping.map(entry => entry === field ? { ...entry, [candidate]: "" } : entry);
    assert.throws(() => assertProjectionMapping(inventoryFields(), broken), /Unmapped field/);
  });

  test(`PROJ omitted lengthSeconds is caught by the independent document ${candidate}`, () => {
    const input = { schema: 2, title: "Length", rows: [{ id: "R1", audioText: "x", visualText: "", lengthSeconds: 12 }] };
    const replica = fromDocument(input, candidate);
    try {
      mapValue(replica.doc.getMap("beats").get("R1")).delete("lengthSeconds");
      assert.throws(() => assert.deepEqual(toDocument(replica.doc, candidate), input));
    } finally { replica.destroy(); }
  });

  test(`PROJ plain fields, unknown keys, atomic bodies and encoded transfer ${candidate}`, () => {
    const raw = {
      schema: 2, title: "Complete", docId: "d" + "1".repeat(32), unknownField: { kept: [1, null, { unicode: "東京" }] },
      rows: [{ id: "R1", audioText: "<strong>x</strong>", visualText: "", lengthSeconds: 12, paragraphStart: true, mystery: { kept: 2 } }],
      comments: [{ id: "C1", rowId: "R1", field: "visualText", anchorId: null, body: "<em>media</em>", mystery: 3,
        replies: [{ id: "P1", author: "A", body: "reply", createdAt: null, mystery: [4] }] }],
      people: [{ id: "p1", name: "A", mystery: false }],
      productionTags: [{ id: "t1", cat: "prop", name: "Mug", mystery: { a: 5 } }],
      brollShots: [{ id: "s1", name: "No key", origin: "list", mystery: 6 }]
    };
    const reference = appReferences([raw])[0];
    assert.ok(reference);
    const replica = fromDocument(reference.document, candidate);
    const other = new Y.Doc();
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
      assert.deepEqual(toDocument(other, candidate), reference.document);
    } finally { replica.destroy(); other.destroy(); }
  });

  test(`PROJ media comment retains literal null anchor and load location ${candidate}`, () => {
    const source = JSON.parse(readFileSync(new URL("supplement.splitpage", import.meta.url), "utf8")) as Record<string, unknown>;
    const replica = fromDocument(source, candidate);
    const other = new Y.Doc();
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
      const comment = (toDocument(other, candidate).comments as Record<string, unknown>[])[0];
      assert.ok(comment);
      assert.equal(comment.anchorId, null);
      assert.equal(comment.rowId, "gap-row");
      assert.equal(comment.field, "visualText");
      assert.equal(comment.body, '<img class="comment-img" data-blob="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">');
    } finally { replica.destroy(); other.destroy(); }
  });
}

test("PROJ canonical fixture experiment retains a complete exact-difference record", () => {
  const results = runRoundTrips();
  const recorded = JSON.parse(readFileSync(new URL("../../src/proj/results.json", import.meta.url), "utf8")) as unknown[];
  assert.equal(results.length, recorded.length);
  results.forEach((result, index) => assert.deepEqual(result, recorded[index], result.fixture));
  assert.ok(results.length > 100);
  assert.equal(results.filter(result => result.candidate === "A").length, results.filter(result => result.candidate === "B").length);
  for (const result of results) {
    assert.equal(result.byteIdentical, result.originalDifference === null, result.fixture);
    assert.equal(result.sameAsAppSave, result.appSaveDifference === null, result.fixture);
    assert.ok(result.encodedBytes > 0);
    const unicode = new Map([
      ["merge-text-unicode-and-atoms.json/inputs/base", ["a&nbsp;b c\u200bd", "a&nbsp;b cd"]],
      ["merge-text-unicode-and-atoms.json/inputs/mine", ["a&nbsp;b c\u200bd e", "a&nbsp;b cd e"]],
      ["merge-text-unicode-and-atoms.json/inputs/theirs", ["A&nbsp;b c\u200bd", "A&nbsp;b cd"]]
    ]).get(result.fixture);
    if (unicode) {
      assert.deepEqual(result.projectionDifferences, [{ path: "$.rows.3.visualText", before: unicode[0], after: unicode[1] }]);
      assert.deepEqual(result.savedDifferences, result.projectionDifferences);
    } else if (result.fixture === "migrate-golden.json/scenarios/media in cells/output") {
      const before = '<span class="cmt-anchor" data-cmt="mintedc1">anchor without id</span> and <span class="broll-key" data-broll-id="mintedbs1" contenteditable="false">B-roll:</span> city <span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape" contenteditable="false">gaffer tape</span> <span class="audio-cue">SFX: <span class="tag-anchor" data-tag-cat="sound" data-tag-name="Thunder" contenteditable="false">Thunder</span></span>';
      const after = '<span class="cmt-anchor" data-cmt="mintedc1">anchor without id</span> and <span class="broll-key" data-broll-id="mintedbs1" contenteditable="false">B-roll:</span> city <span class="tag-anchor" data-tag-cat="prop" data-tag-name="gaffer tape" contenteditable="false">gaffer tape</span> SFX: <span class="tag-anchor" data-tag-cat="sound" data-tag-name="Thunder" contenteditable="false">Thunder</span>';
      assert.deepEqual(result.projectionDifferences, [{ path: "$.rows.1.audioText", before, after }]);
      assert.deepEqual(result.savedDifferences, result.projectionDifferences);
    } else if (result.fixture === "supplement.splitpage") {
      assert.deepEqual(result.projectionDifferences, [
        { path: "$.rows.0.imageLinks.0.location", before: { kind: "path", path: "C:\\shoot\\take.mp4" } },
        { path: "$.rows.0.imageLinks.1.location", before: { kind: "bundled", name: "notes.pdf" } }
      ]);
      assert.deepEqual(result.savedDifferences, result.projectionDifferences);
    } else {
      assert.deepEqual(result.projectionDifferences, [], `${result.candidate} ${result.fixture}`);
      assert.equal(result.sameAsAppSave, true, `${result.candidate} ${result.fixture}`);
    }
  }
});
