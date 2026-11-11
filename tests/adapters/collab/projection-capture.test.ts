import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { buildSplitpageFile } from "../../../src/adapters/formats/project-file.ts";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import { editStamp } from "../../../src/application/commands/save-stamps.ts";
import type { ProjectFileServices } from "../../../src/application/formats/project-file-services.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { withProjectedFixture } from "./projection-support.ts";
import { withFullProjectedFixture } from "./projection-roundtrip-support.ts";

const services: ProjectFileServices = {
  migrateRows, migrateDocument: raw => migrateRows(raw), sanitizeHtml: html => html,
  tagFieldOccurrences: html => ({ hits: 0, html }), inertBody: () => ({ ownerDocument: { getElementById: () => null } }),
  askMarkdownRows: async () => "keep"
};
function save(source: ValidatedDocument): Record<string, unknown> {
  return JSON.parse(buildSplitpageFile(buildExportDocument(source, "2026-01-01T00:00:00Z", { production: [], commentNumbers: {}, broll: [] }), services)) as Record<string, unknown>;
}
for (const [name, value] of [["null", null], ["number", 123], ["string", "2026-01-02T03:04:05Z"], ["boolean", true], ["array", [1, null]], ["object", { legacy: 2 }]] as const) {
  test(`projection retains ${name} lastEditedAt exactly as the app saves it`, () => {
    const source = migrateRows({ rows: [{ id: "R1" }], lastEditedAt: value });
    const expected = save(source);
    assert.deepEqual(expected.lastEditedAt, value);
    const check = (projected: Readonly<Record<string, unknown>>) => {
      assert.equal(Object.hasOwn(projected, "lastEditedAt"), true);
      assert.deepEqual(projected.lastEditedAt, expected.lastEditedAt);
      assert.deepEqual(save(migrateRows({ ...source, lastEditedAt: projected.lastEditedAt })).lastEditedAt, expected.lastEditedAt);
    };
    withProjectedFixture(source, check); withFullProjectedFixture(source, check);
  });
  test(`projection retains normalized ${name} row updatedAt and its editor as the app saves them`, () => {
    const source = migrateRows({ rows: [{ id: "R1", updatedAt: value, updatedBy: "Row editor" }] });
    const expected = (save(source).rows as Record<string, unknown>[])[0]; assert.ok(expected);
    assert.deepEqual(expected.updatedAt, value ?? "");
    const check = (projected: Readonly<Record<string, unknown>>) => {
      const row = (projected.rows as Record<string, unknown>[])[0]; assert.ok(row);
      assert.equal(Object.hasOwn(row, "updatedAt"), true);
      assert.deepEqual(row.updatedAt, expected.updatedAt); assert.equal(row.updatedBy, expected.updatedBy);
    };
    withProjectedFixture(source, check); withFullProjectedFixture(source, check);
  });
}
test("projection attribution fields follow the app's explicit stamp assignment order", () => {
  const source = migrateRows({ rows: [{ id: "R1" }] });
  const plan = editStamp({ rev: 7, lastEditedBy: "Editor", lastEditedAt: "2026-01-02T03:04:05Z" }).plan(source);
  assert.ok(plan); plan.apply(source);
  const attribution = (value: object) => Object.keys(value).filter(key => ["rev", "lastEditedBy", "lastEditedAt"].includes(key));
  assert.deepEqual(attribution(save(source)), ["rev", "lastEditedBy", "lastEditedAt"]);
  withProjectedFixture(source, projected => assert.deepEqual(attribution(projected), ["rev", "lastEditedBy", "lastEditedAt"]));
  withFullProjectedFixture(source, projected => assert.deepEqual(attribution(projected), ["rev", "lastEditedBy", "lastEditedAt"]));
});
test("projection scalar and capture checks retain the app's normalized boundary values and absences", () => {
  for (const raw of [
    { rev: -1.5, lastEditedBy: " Editor ", personColors: { Editor: "#80bdfb" }, titleOrigin: "file", titleVersion: "V12", wordsPerMinute: "222.6", targetSeconds: 1.6, paragraphsDecided: true, rows: [{ id: "R1", lengthSeconds: 1.6, paragraphStart: true }] },
    { rev: null, lastEditedBy: 12, personColors: null, titleOrigin: null, titleVersion: 12, wordsPerMinute: null, targetSeconds: 0, paragraphsDecided: false, rows: [{ id: "R1", lengthSeconds: null, paragraphStart: false }] }
  ]) {
    const source = migrateRows(raw), expected = save(source);
    withProjectedFixture(source, projected => {
      for (const key of ["rev", "lastEditedBy", "lastEditedAt", "personColors", "titleOrigin", "titleVersion", "wordsPerMinute", "targetSeconds", "paragraphsDecided", "schema", "docId"]) {
        assert.equal(Object.hasOwn(projected, key), Object.hasOwn(expected, key), key);
        assert.deepEqual(projected[key], expected[key], key);
      }
      const row = (projected.rows as Record<string, unknown>[])[0], saved = (expected.rows as Record<string, unknown>[])[0]; assert.ok(row && saved);
      for (const key of ["lengthSeconds", "paragraphStart", "updatedAt", "updatedBy"]) {
        assert.equal(Object.hasOwn(row, key), Object.hasOwn(saved, key), key); assert.deepEqual(row[key], saved[key], key);
      }
    });
  }
});
