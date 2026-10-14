import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { importRowsCommand } from "../../src/application/commands/import-rows.ts";
import type { ImportScan } from "../../src/application/commands/import-rows.ts";
import type { StampPorts } from "../../src/application/session/ports.ts";
import type { DocumentRow, ValidatedDocument } from "../../src/core/document/validated.ts";
import { migratedThenSet } from "../core/migrate-ports.ts";
import { harness, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-14T12:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function ports(name = "Adam"): StampPorts & { asked: () => number } {
  let asked = 0;
  return {
    asked: function () { return asked; },
    clock: { nowIso: function () { asked++; return STAMP; } },
    editor: { name: function () { return name; } }
  };
}

function fixture(): Record<string, unknown> {
  return {
    title: "Harbour",
    docId: "d" + "1".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo", updatedAt: OLD, updatedBy: "Sam" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "shot", updatedAt: OLD, updatedBy: "Sam" }
    ],
    comments: [{ id: "c1", rowId: "r2", field: "audioText", body: "Tighter", replies: [] }]
  };
}

function opened(hooks: { reconcile?: (doc: ValidatedDocument) => number } = {}): ReturnType<typeof harness> {
  const entry = function (): ValidatedDocument { return migratedThenSet(fixture()); };
  const h = harness(undefined, hooks.reconcile ? { entry: entry, reconcile: hooks.reconcile } : { entry: entry });
  h.session.adopt({});
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function imported(...texts: string[]): DocumentRow[] {
  return texts.map(function (text, i) { return { id: "n" + (i + 1), visualText: "", imageRef: null, audioText: text }; });
}

const NO_SCAN: ImportScan = function () { return ""; };

function rowsOf(h: ReturnType<typeof harness>): Record<string, unknown>[] {
  return h.session.read(function (doc) { return doc ? JSON.parse(JSON.stringify(doc.rows)) as Record<string, unknown>[] : []; });
}

function snapshot(h: ReturnType<typeof harness>): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

const COMMIT = ["reconcile", "undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"];

test("an append is one transaction: the scenes go after the existing ones, stamped once, with one undo record and one effect pass", () => {
  const h = opened();
  const p = ports();
  const rows = imported("Alpha.", "Beta.");
  const imp = importRowsCommand({ rows: rows, replace: false, scan: NO_SCAN }, p);
  const out = runConfined(h.session, imp.command);
  assert.deepEqual(out, {
    kind: "applied",
    generation: 1,
    changes: changeSet({ rowsInserted: ["n1", "n2"], derive: ["production", "broll"] })
  });
  assert.deepEqual(h.log, COMMIT);
  const now = rowsOf(h);
  assert.deepEqual(now.map(function (r) { return r.id; }), ["r1", "r2", "n1", "n2"]);
  assert.equal(now[0]?.updatedAt, OLD, "the existing scenes keep their stamps");
  assert.deepEqual([now[2]?.updatedAt, now[2]?.updatedBy, now[3]?.updatedAt, now[3]?.updatedBy], [STAMP, "Adam", STAMP, "Adam"]);
  assert.equal(p.asked(), 1, "one transaction reads the clock once");
  assert.equal(rows[0]?.updatedAt, undefined, "the decoded scenes the request holds are not written");
  assert.deepEqual(imp.report(), { count: 2, found: "" });
});

test("a replace removes every existing scene in the same transaction and reconciles comments inside it", () => {
  let reconciled = 0;
  const h = opened({ reconcile: function () { reconciled++; return 0; } });
  const out = runConfined(h.session, importRowsCommand({ rows: imported("Only."), replace: true, scan: NO_SCAN }, ports()).command);
  assert.equal(out.kind, "applied");
  assert.deepEqual(out.kind === "applied" ? out.changes.rowsRemoved : null, ["r1", "r2"]);
  assert.deepEqual(rowsOf(h).map(function (r) { return r.id; }), ["n1"]);
  assert.equal(reconciled, 1, "the comment anchors are reconciled once, inside the transaction");
  assert.deepEqual(h.log, COMMIT);
});

test("the scan runs inside the transaction on the live document with the imported scenes already in place", () => {
  const h = opened();
  let seen: string[] = [];
  const scan: ImportScan = function (doc, rows) {
    seen = doc.rows.map(function (r) { return r.id; });
    rows.forEach(function (row) { row.visualText = "<b>scanned</b>"; });
    return "1 found.";
  };
  const imp = importRowsCommand({ rows: imported("Alpha."), replace: false, scan: scan }, ports());
  assert.equal(runConfined(h.session, imp.command).kind, "applied");
  assert.deepEqual(seen, ["r1", "r2", "n1"]);
  assert.equal(rowsOf(h)[2]?.visualText, "<b>scanned</b>", "what the scan wrote is part of the import");
  assert.deepEqual(imp.report(), { count: 1, found: "1 found." });
  assert.equal(h.log.filter(function (l) { return l === "undo.record"; }).length, 1, "and of its one undo record");
});

test("a scan that throws fails the import and leaves the document as it was", () => {
  const h = opened();
  const before = snapshot(h);
  const scan: ImportScan = function () { throw new Error("scan broke"); };
  const out = runConfined(h.session, importRowsCommand({ rows: imported("Alpha."), replace: true, scan: scan }, ports()).command);
  assert.equal(out.kind, "failed");
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
  assert.equal(h.session.generation(), 0);
});

test("nothing to import is a no-op; no document and a denied session are refused before planning", () => {
  const h = opened();
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, importRowsCommand({ rows: [], replace: true, scan: NO_SCAN }, ports()).command), { kind: "noop" });
  assert.equal(snapshot(h), before);
  h.deny("review");
  assert.deepEqual(runConfined(h.session, importRowsCommand({ rows: imported("A."), replace: false, scan: NO_SCAN }, ports()).command), { kind: "rejected", reason: "review" });
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.log, []);
  const empty = harness();
  assert.deepEqual(empty.session.run(importRowsCommand({ rows: imported("A."), replace: false, scan: NO_SCAN }, ports()).command), { kind: "rejected", reason: NO_DOCUMENT });
});

test("the import keeps the document's identity and every field outside its scenes", () => {
  const h = opened();
  const before = h.session.read(function (doc) { return doc ? { docId: doc.docId, title: doc.title, comments: JSON.stringify(doc.comments) } : null; });
  assert.equal(runConfined(h.session, importRowsCommand({ rows: imported("A."), replace: false, scan: NO_SCAN }, ports()).command).kind, "applied");
  const after = h.session.read(function (doc) { return doc ? { docId: doc.docId, title: doc.title, comments: JSON.stringify(doc.comments) } : null; });
  assert.deepEqual(after, before);
  assert.equal(h.session.epoch(), 1, "an import is an edit, not an adoption");
});
