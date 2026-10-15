import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "../../src/application/session/change-set.ts";
import { galleryCommand } from "../../src/application/commands/gallery.ts";
import type { StampPorts } from "../../src/application/session/ports.ts";
import { addGalleryVideo, removeGallerySlot, rowSlots } from "../../src/core/document/gallery.ts";
import type { DocumentRow } from "../../src/core/document/validated.ts";
import { harness, rawScript, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-15T12:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";
const VIDEO = "https://youtu.be/abc";

function stamps(name = "Adam"): StampPorts {
  return {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { return name; } }
  };
}

function scripted(): Record<string, unknown> {
  const raw = rawScript("Harbour");
  const rows = raw.rows as Record<string, unknown>[];
  rows.forEach(function (row) { row.updatedAt = OLD; row.updatedBy = "Sam"; });
  (rows[1] as Record<string, unknown>).imageLinks = [{ href: VIDEO }];
  return raw;
}

function opened(): ReturnType<typeof harness> {
  const h = harness();
  h.session.adopt(scripted());
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function rowOf(h: ReturnType<typeof harness>, rowId: string): Record<string, unknown> | null {
  return h.session.read(function (doc) {
    const row = doc && doc.rows.find(function (r) { return r.id === rowId; });
    return row ? JSON.parse(JSON.stringify(row)) as Record<string, unknown> : null;
  });
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function galleryChanges(rowId: string, fields: string[]) {
  return changeSet({ cells: fields.concat(["updatedAt", "updatedBy"]).map(function (field) { return { rowId: rowId, field: field }; }) });
}

test("a gallery edit is one generation, one undo record and one effect pass, naming only the fields it changed and the stamps", () => {
  const h = opened();
  const out = runConfined(h.session, galleryCommand("r1", function (row) { return addGalleryVideo(row, { href: VIDEO }) !== -1; }, stamps()));
  assert.deepEqual(out, { kind: "applied", generation: 1, changes: galleryChanges("r1", ["imageLinks"]) });
  assert.deepEqual(h.log, ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"]);
  const row = rowOf(h, "r1");
  assert.deepEqual(rowSlots(row as DocumentRow)[0]?.links.map(function (l) { return l.href; }), [VIDEO]);
  assert.equal(row?.updatedAt, STAMP);
  assert.equal(row?.updatedBy, "Adam");
  assert.equal(rowOf(h, "r2")?.updatedAt, OLD, "no other scene is stamped");
});

test("a field the edit deletes is deleted in the document, and declared", () => {
  const h = opened();
  const out = runConfined(h.session, galleryCommand("r2", function (row) { return removeGallerySlot(row, 0); }, stamps()));
  assert.equal(out.kind, "applied");
  assert.deepEqual(out.kind === "applied" ? out.changes.cells.map(function (c) { return c.field; }) : [], ["imageLinks", "updatedAt", "updatedBy"]);
  assert.equal("imageLinks" in (rowOf(h, "r2") || {}), false);
});

test("an edit that declines, or that changes nothing, is a no-op with no stamp", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, galleryCommand("r1", function () { return false; }, stamps())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, galleryCommand("r1", function () { return true; }, stamps())), { kind: "noop" });
  assert.deepEqual(runConfined(h.session, galleryCommand("gone", function () { return true; }, stamps())), { kind: "noop" });
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
});

test("the edit runs on a copy while planning: the live scene is written only by apply", () => {
  const h = opened();
  let seen: DocumentRow | null = null;
  const out = runConfined(h.session, galleryCommand("r1", function (row) {
    seen = row;
    row.imageLinks = [{ href: VIDEO }];
    assert.equal(rowOf(h, "r1")?.imageLinks, undefined, "the document is untouched while the edit runs");
    return true;
  }, stamps()));
  assert.equal(out.kind, "applied");
  (seen as unknown as DocumentRow).imageLinks = [{ href: "https://e.x/late" }];
  assert.deepEqual(rowOf(h, "r1")?.imageLinks, [{ href: VIDEO }], "a later write to the copy does not reach the document");
});

test("in review mode the edit is refused before it runs", () => {
  const h = opened();
  const before = snapshot(h);
  h.deny("review");
  let ran = 0;
  assert.deepEqual(runConfined(h.session, galleryCommand("r2", function (row) { ran++; return removeGallerySlot(row, 0); }, stamps())), { kind: "rejected", reason: "review" });
  assert.equal(ran, 0);
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
});

test("a stamp port that throws fails the command and rolls the gallery back with it", () => {
  const h = opened();
  const before = snapshot(h);
  const broken: StampPorts = {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { throw new Error("no editor"); } }
  };
  const out = runConfined(h.session, galleryCommand("r2", function (row) { return removeGallerySlot(row, 0); }, broken));
  assert.equal(out.kind, "failed");
  assert.equal(snapshot(h), before, "the link and the stamp are as they were");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.published, []);
});
