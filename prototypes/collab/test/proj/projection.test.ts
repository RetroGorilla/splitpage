import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { createProjectionReplica, fromDocument, toDocument } from "../../src/proj/document.ts";
import { inventoryFields, runRoundTrips } from "../../src/proj/experiment.ts";
import { assertProjectionMapping, projectionFieldMapping } from "../../src/proj/mapping.ts";
import { mapValue, textValue } from "../../src/schema.ts";
import { projectionReferences } from "../../src/proj/reference.ts";
import { projectionExclusion } from "../../src/proj/exclusions.ts";

test("PROJ inventory: every current field row has a location in both candidates", () => {
  const inventory = inventoryFields();
  assert.equal(inventory.length, 96, "The brief says 93; the current inventory contains 96");
  assertProjectionMapping(inventory, projectionFieldMapping);
});

for (const candidate of ["A", "B"] as const) {
  test(`PROJ imported tag and link occurrences have distinct identities across fields ${candidate}`, () => {
    const html = '<a href="https://example.com" target="_blank" rel="noopener"><span class="tag-anchor" data-tag-cat="prop" data-tag-name="Cup" contenteditable="false">Cup</span></a>';
    const source = { schema: 2, rows: [{ id: "R1", audioText: html, visualText: html }, { id: "R2", audioText: html, visualText: "" }],
      productionTags: [{ id: "t_cup", cat: "prop", name: "Cup" }] };
    const imported = fromDocument(source, candidate);
    const received = createProjectionReplica(candidate, 11);
    try {
      Y.applyUpdate(received.doc, Y.encodeStateAsUpdate(imported.doc));
      const texts = candidate === "A" ? [received.doc.getText("flow")] : [...received.doc.getMap("segments").values()].map(value => textValue(mapValue(value).get("text")));
      texts.push(...[...received.doc.getMap("visuals").values()].map(value => textValue(mapValue(value).get("text"))));
      const keys = texts.flatMap(text => (text.toDelta() as { attributes?: Record<string, unknown> }[]).flatMap(delta => Object.keys(delta.attributes ?? {})));
      assert.equal(new Set(keys.filter(key => key.startsWith("t:"))).size, 3);
      assert.equal(new Set(keys.filter(key => key.startsWith("l:"))).size, 3);
    } finally { imported.destroy(); received.destroy(); }
  });

  test(`PROJ receiver declares typed roots before remote state ${candidate}`, () => {
    const receiver = createProjectionReplica(candidate, 11);
    try {
      assert.ok(receiver.doc.share.get("meta") instanceof Y.Map);
      assert.ok(receiver.doc.share.get("headings") instanceof Y.Map);
      if (candidate === "A") assert.ok(receiver.doc.share.get("flow") instanceof Y.Text);
      else {
        assert.ok(receiver.doc.share.get("segments") instanceof Y.Map);
        assert.ok(receiver.doc.share.get("order") instanceof Y.Array);
      }
    } finally { receiver.destroy(); }
  });

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
    const replica = fromDocument(raw, candidate);
    const other = createProjectionReplica(candidate, 11).doc;
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
      assert.deepEqual(toDocument(other, candidate), raw);
    } finally { replica.destroy(); other.destroy(); }
  });

  test(`PROJ media comment retains literal null anchor and load location ${candidate}`, () => {
    const source = JSON.parse(readFileSync(new URL("supplement.splitpage", import.meta.url), "utf8")) as Record<string, unknown>;
    const replica = fromDocument(source, candidate);
    const other = createProjectionReplica(candidate, 11).doc;
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

  test(`PROJ transport equality protects titleVersion, paragraphStart and shot props ${candidate}`, () => {
    const source = {
      schema: 2, title: "Fields", titleVersion: "v12", rows: [{ id: "R1", audioText: "a", visualText: "", paragraphStart: true }],
      brollShots: [{ id: "S1", props: [{ id: "t_cup", name: "Cup" }] }]
    };
    const replica = fromDocument(source, candidate);
    const other = createProjectionReplica(candidate, 11).doc;
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
      const projected = toDocument(other, candidate);
      assert.equal(projected.titleVersion, "v12");
      assert.equal((projected.rows as Record<string, unknown>[])[0]?.paragraphStart, true);
      assert.deepEqual((projected.brollShots as Record<string, unknown>[])[0]?.props, [{ id: "t_cup", name: "Cup" }]);
    } finally { replica.destroy(); other.destroy(); }
  });

  test(`PROJ highlight annotation is transported unchanged ${candidate}`, () => {
    const reference = projectionReferences().find(reference => reference.name === "supplement.splitpage");
    assert.ok(reference);
    const replica = fromDocument(reference.document, candidate);
    const other = createProjectionReplica(candidate, 11).doc;
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
      const row = (toDocument(other, candidate).rows as Record<string, unknown>[])[0];
      assert.deepEqual((row?.imageAnnotation as Record<string, unknown>).marks, [
        { kind: "highlight", color: "#ffb703", width: 0.02, points: [0.1, 0.2, 0.3, 0.4] }
      ]);
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
    if (result.fixture === "supplement.splitpage") {
      assert.deepEqual(result.declaredExclusions, projectionExclusion.fields);
      assert.deepEqual(result.projectionDifferences, [
        { path: "$.rows.0.imageLinks.0.location", before: { kind: "path", path: "C:\\shoot\\take.mp4" } },
        { path: "$.rows.0.imageLinks.1.location", before: { kind: "bundled", name: "notes.pdf" } }
      ]);
      assert.deepEqual(result.savedDifferences, result.projectionDifferences);
    } else {
      assert.deepEqual(result.declaredExclusions ?? [], []);
      assert.deepEqual(result.projectionDifferences, [], `${result.candidate} ${result.fixture}`);
      assert.equal(result.sameAsAppSave, true, `${result.candidate} ${result.fixture}`);
    }
  }
  for (const candidate of ["A", "B"]) {
    const runs = results.filter(result => result.candidate === candidate);
    assert.equal(runs.length, 291);
    assert.equal(runs.filter(result => result.byteIdentical).length, 7);
    assert.equal(runs.filter(result => result.sameAsAppSave).length, 290);
    assert.equal(runs.filter(result => result.declaredExclusions?.length).length, 1);
  }
});
