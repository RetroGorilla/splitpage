import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { createProjectionReplica, fromDocument, toDocument } from "../../src/proj/document.ts";
import { records } from "../../src/proj/value.ts";
import { mapValue, textValue } from "../../src/schema.ts";
import { surfaceToDelta } from "../../src/proj/richtext.ts";
import { assertProjectionBytes, expectedProjectionBytes } from "../../src/proj/exclusions.ts";
import { projectionReferences, serializeProjection } from "../../src/proj/reference.ts";
import type { ProjectionSurfacePart } from "../../src/proj/richtext.ts";

for (const candidate of ["A", "B"] as const) {
  test(`PROJ device-local locations are absent from encoded shared records ${candidate}`, () => {
    const reference = projectionReferences().find(item => item.name === "supplement.splitpage");
    assert.ok(reference);
    const writer = fromDocument(reference.document, candidate);
    const receiver = createProjectionReplica(candidate, 11);
    try {
      Y.applyUpdate(receiver.doc, Y.encodeStateAsUpdate(writer.doc));
      const links = [...receiver.doc.getMap("gallery").values()].flatMap(slot => [...mapValue(mapValue(slot).get("links")).values()]);
      assert.equal(links.length, 2);
      for (const value of links) {
        const link = mapValue(value);
        assert.equal(link.has("location"), false);
        assert.equal((link.get("keys") as string[]).includes("location"), false);
        assert.deepEqual(JSON.parse(String(link.get("extra"))), {});
      }
    } finally { writer.destroy(); receiver.destroy(); }
  });

  test(`PROJ stored U+200B and a presentation caret sentinel in one beat ${candidate}`, () => {
    const surface: ProjectionSurfacePart[] = [
      { storedHtml: "a\u200bb<br>" }, { caretSentinel: "\u200b" },
      { storedHtml: '<span class="who-anchor" data-who="Mira" contenteditable="false">@Mira</span>' },
      { caretSentinel: "\u200b" }, { storedHtml: "\u200bc" }
    ];
    const source = { schema: 2, title: "Mixed", rows: [{ id: "R1", audioText: "", visualText: "" }],
      comments: [], people: [], productionTags: [], brollShots: [] };
    const writer = fromDocument(source, candidate);
    const receiver = createProjectionReplica(candidate, 11);
    try {
      const visual = textValue(mapValue(writer.doc.getMap("visuals").get("visual-R1")).get("text"));
      visual.applyDelta(surfaceToDelta(surface, [], []));
      assert.equal(visual.toString(), "a\u200bb\n\u200bc");
      Y.applyUpdate(receiver.doc, Y.encodeStateAsUpdate(writer.doc));
      const projected = toDocument(receiver.doc, candidate);
      assert.deepEqual(projected, { ...source, rows: [{ id: "R1", audioText: "",
        visualText: 'a\u200bb<br><span class="who-anchor" data-who="Mira" contenteditable="false">@Mira</span>\u200bc' }] });
    } finally { writer.destroy(); receiver.destroy(); }
  });

  for (const defect of ["stored U+200B dropped", "cue dropped"] as const) {
    test(`PROJ checker rejects ${defect} ${candidate}`, () => {
      const fixture = defect === "stored U+200B dropped" ? "merge-text-unicode-and-atoms.json/inputs/base" : "migrate-golden.json/scenarios/media in cells/output";
      const reference = projectionReferences().find(item => item.name === fixture);
      assert.ok(reference?.appSaved.full);
      const appSaved = reference.appSaved.full;
      const writer = fromDocument(reference.document, candidate);
      const receiver = createProjectionReplica(candidate, 11);
      try {
        assertProjectionBytes(fixture, appSaved, serializeProjection(toDocument(writer.doc, candidate)));
        if (defect === "stored U+200B dropped") {
          const row = records(reference.document.rows)[3];
          const visual = textValue(mapValue(writer.doc.getMap("visuals").get(`visual-${String(row?.id)}`)).get("text"));
          const index = visual.toString().indexOf("\u200b");
          assert.ok(index >= 0);
          visual.delete(index, 1);
        } else {
          const texts = candidate === "A" ? [writer.doc.getText("flow")] : [...writer.doc.getMap("segments").values()].map(value => textValue(mapValue(value).get("text")));
          assert.ok(texts.some(text => (text.toDelta() as { attributes?: Record<string, unknown> }[]).some(item => item.attributes?.cue)));
          for (const text of texts) text.format(0, text.length, { cue: null });
        }
        Y.applyUpdate(receiver.doc, Y.encodeStateAsUpdate(writer.doc));
        assert.throws(() => assertProjectionBytes(fixture, appSaved, serializeProjection(toDocument(receiver.doc, candidate))), /PROJ bytes/);
      } finally { writer.destroy(); receiver.destroy(); }
    });
  }

  for (const [name, html] of [
    ["stored U+200B", "a&nbsp;b c\u200bd"],
    ["stored mid-line cue", 'before <span class="audio-cue">SFX: bell</span> after'],
    ["stored U+200B beside marks, atoms and a trailing break", '<strong>a\u200bb</strong><span class="who-anchor" data-who="Mira" contenteditable="false">@Mira</span>\u200b<br>']
  ]) test(`PROJ lossless ${name} survives encoded transfer ${candidate}`, () => {
    const source = { schema: 2, title: "Lossless", rows: [{ id: "R1", audioText: "", visualText: html }],
      comments: [], people: [], productionTags: [], brollShots: [] };
    const writer = fromDocument(source, candidate);
    const receiver = createProjectionReplica(candidate, 11);
    try {
      Y.applyUpdate(receiver.doc, Y.encodeStateAsUpdate(writer.doc));
      assert.equal(records(toDocument(receiver.doc, candidate).rows)[0]?.visualText, html);
      assert.deepEqual(toDocument(receiver.doc, candidate), source);
    } finally { writer.destroy(); receiver.destroy(); }
  });
}

test("PROJ local-location exclusion cannot conceal another difference or accept another value", () => {
  const reference = projectionReferences().find(item => item.name === "supplement.splitpage");
  assert.ok(reference?.appSaved.full);
  const appSaved = reference.appSaved.full;
  const expected = expectedProjectionBytes(reference.name, appSaved);
  assertProjectionBytes(reference.name, appSaved, expected);
  assert.throws(() => assertProjectionBytes(reference.name, appSaved, expected.replace('"size": 42', '"size": 43')), /PROJ bytes/);
  assert.throws(() => assertProjectionBytes(reference.name, appSaved, expected + "\n"), /PROJ bytes/);
  assert.throws(() => assertProjectionBytes("another fixture", appSaved, expected), /PROJ bytes/);
  assert.throws(() => assertProjectionBytes(reference.name, appSaved, appSaved), /PROJ bytes/);
  assert.throws(() => expectedProjectionBytes(reference.name, appSaved.replace('"kind": "bundled"', '"kind": "changed"')), /Declared exclusion changed/);
});
