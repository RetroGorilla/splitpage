import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { projectionReferences, rekeyLoadedDocument, assertProjectionValues, withFullProjectedFixture } from "./projection-roundtrip-support.ts";
import type { DocumentShape } from "../../../src/core/document/validated.ts";
import { buildExportDocument } from "../../../src/core/document/export-document.ts";
import { dom } from "../../../src/test/_dom.mjs";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import { buildSplitpageFile } from "../../../src/adapters/formats/project-file.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";

after(() => { dom.window.close(); });
function save(document: DocumentShape): string {
  const valid = migrateRows(structuredClone(document));
  const unused = (): never => { throw new Error("Unexpected project-file service"); };
  return buildSplitpageFile(buildExportDocument(valid, "2026-11-11T00:00:00Z", { production: [], commentNumbers: {}, broll: [] }), {
    migrateRows, migrateDocument: unused, sanitizeHtml: unused, tagFieldOccurrences: unused, inertBody: unused, askMarkdownRows: unused
  });
}

const knownDifferences = [
  ["merge-text-unicode-and-atoms.json/inputs/base", "normalizeCell removes the stored U+200B in visual text"],
  ["merge-text-unicode-and-atoms.json/inputs/mine", "normalizeCell removes the stored U+200B in visual text"],
  ["merge-text-unicode-and-atoms.json/inputs/theirs", "normalizeCell removes the stored U+200B in visual text"],
  ["migrate-golden.json/scenarios/media in cells/output", "settleCues removes the mid-line audio-cue span"],
  ["supplement.splitpage", "Device-local path and bundled link locations are excluded from shared state"]
] as const;
const replyOrderDifferences = [
  ["merge-prototype-ids-comments.json/inputs/base", "c1"], ["merge-prototype-ids-comments.json/inputs/mine", "c1"],
  ["merge-prototype-ids-comments.json/inputs/theirs", "c1"], ["merge-prototype-ids-comments.json/merged", "c1"],
  ["migrate-golden.json/scenarios/schema 1 document/output", "c1"]
] as const;
function replyTime(value: unknown): number {
  const stamp = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2})))?$/.exec(value) : null;
  if (!stamp) { const numeric = typeof value === "string" || typeof value === "number" ? Number(value) : 0; return Number.isFinite(numeric) ? numeric : 0; }
  const year = Number(stamp[1]), month = Number(stamp[2]), day = Number(stamp[3]);
  const hour = Number(stamp[4] ?? 0), minute = Number(stamp[5] ?? 0), second = Number(stamp[6] ?? 0), millis = Number((stamp[7] ?? "").padEnd(3, "0"));
  const zoneHour = Number(stamp[9] ?? 0), zoneMinute = Number(stamp[10] ?? 0);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return 0;
  return date.getTime() - (stamp[8] === "-" ? -1 : 1) * (zoneHour * 60 + zoneMinute) * 60000;
}

function expectedProjection(name: string, document: DocumentShape): DocumentShape {
  const expected = structuredClone(document);
  if (knownDifferences.slice(0, 3).some(([fixture]) => name === fixture)) {
    const row = expected.rows[3]; assert.ok(row && typeof row.visualText === "string");
    row.visualText = row.visualText.replace(/\u200b/g, "");
  }
  if (name === knownDifferences[3][0]) {
    const row = expected.rows[1]; assert.ok(row && typeof row.audioText === "string");
    row.audioText = row.audioText.replace('<span class="audio-cue">SFX: ', "SFX: ").replace('Thunder</span></span>', 'Thunder</span>');
  }
  if (name === "supplement.splitpage") {
    const links = expected.rows[0]?.imageLinks as Record<string, unknown>[];
    assert.deepEqual(links.map(link => link.location), [{ kind: "path", path: "C:\\shoot\\take.mp4" }, { kind: "bundled", name: "notes.pdf" }]);
    for (const link of links) delete link.location;
  }
  return expected;
}

test("projection: 291 fixture values and canonical app saves", () => {
  let unchanged = 0, differences = 0;
  const reordered: [string, string][] = [];
    assert.equal(projectionReferences.length, 291);
    for (const fixture of projectionReferences) {
      const loaded = migrateRows(structuredClone(fixture.document));
      assertProjectionValues(loaded, fixture.document);
      withFullProjectedFixture(loaded, projected => {
      const saved = save(loaded);
      assert.equal(createHash("sha256").update(saved).digest("hex"), fixture.appSaved.sha256, fixture.name + " direct app save");
      const rekeyed = rekeyLoadedDocument(loaded) as DocumentShape;
      assertProjectionValues(rekeyed, loaded);
      const expected = expectedProjection(fixture.name, loaded);
      for (const comment of expected.comments) {
        const replies = comment.replies ?? [], projectedReplies = projected.comments.find(value => value.id === comment.id)?.replies ?? [];
        const idOrder = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        assertProjectionValues([...projectedReplies].sort(idOrder), [...replies].sort(idOrder));
        const sorted = [...replies].sort((a, b) => replyTime(a.createdAt) - replyTime(b.createdAt) || idOrder(a, b));
        assertProjectionValues(projectedReplies, sorted);
        if (replies.some((reply, index) => reply.id !== sorted[index]?.id)) {
          assert.ok(replyOrderDifferences.some(([name, id]) => name === fixture.name && id === comment.id), fixture.name + ": undeclared reply ordering");
          reordered.push([fixture.name, comment.id]);
        }
        if (comment.replies) comment.replies = sorted;
      }
      assertProjectionValues(projected, expected);
      const projectedSave = save(projected);
      assert.equal(projectedSave, save(rekeyLoadedDocument(expected) as DocumentShape), fixture.name + " canonical bytes");
      if (projectedSave === saved) unchanged++;
      if (knownDifferences.some(([name]) => name === fixture.name)) differences++;
    }); }
    assert.equal(differences, 5);
    assert.deepEqual(reordered, replyOrderDifferences);
    assert.equal(reordered.length, 5);
    assert.equal(unchanged, 175);
});

test("projection key order is content-independent: equal shared bytes produce equal app saves", () => {
  const fixture = projectionReferences[0]; assert.ok(fixture);
  const source = migrateRows(structuredClone(fixture.document)), reversed = migrateRows(Object.fromEntries(Object.entries(source).reverse()));
  assertProjectionValues(source, reversed);
  const a = createMonitoredSharedDocument(), b = createMonitoredSharedDocument();
  try {
    for (const handle of [a, b]) collabState(handle).doc.clientID = 314159265;
    hydrateSharedDocument(a, source); hydrateSharedDocument(b, reversed);
    assert.deepEqual(encodeSharedState(a), encodeSharedState(b));
    assert.notEqual(save(source), save(reversed));
    assert.equal(save(projectSharedDocument(a)), save(projectSharedDocument(b)));
  } finally { destroySharedDocument(a); destroySharedDocument(b); }
});

test("projection value comparison ignores only object key order", () => {
  assertProjectionValues({ a: 1, b: ["x", null] }, { b: ["x", null], a: 1 });
  const sparse = new Array<unknown>(2); sparse[1] = 1;
  for (const [a, b] of [[{}, { a: undefined }], [undefined, null], [sparse, [undefined, 1]], [-0, 0], [[1, 2], [2, 1]], [1, "1"]]) assert.throws(() => assertProjectionValues(a, b));
});
