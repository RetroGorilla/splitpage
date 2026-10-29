import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaveCompletion } from "../../src/application/save/save-completion.ts";
import type { SaveCompletionPorts } from "../../src/application/save/save-completion.ts";
import type { Home } from "../../src/application/location/document-location.ts";
import { buildExportDocument } from "../../src/core/document/export-document.ts";
import type { ExportDocument, ExportReadModels } from "../../src/core/document/export-document.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";

const NO_MODELS: ExportReadModels = { production: [], commentNumbers: {}, broll: [] };
const OLD_ID = "d0123456789abcdef0123456789abcdef";
const NEW_ID = "dfedcba9876543210fedcba9876543210";

function captured(): ExportDocument {
  const doc = migrateRows({ title: "Pilot", docId: OLD_ID, rev: 2, rows: [] }, fakeMigration().ports);
  return buildExportDocument(doc, "2026-10-29T00:00:00.000Z", NO_MODELS, { stamp: { rev: 3, lastEditedBy: "Adam", lastEditedAt: "2026-10-29T00:00:00.000Z" } });
}

function harness(changes = 4) {
  const log: string[] = [];
  const amended: Record<string, unknown>[] = [];
  const ports: SaveCompletionPorts = {
    document: { stamp: (stamp) => { log.push("stamp:" + stamp.name); return null; } },
    location: {
      amendHome: (record, fields) => { log.push("amendHome:" + Object.keys(fields).join(",")); amended.push({ ...fields }); return record; },
      markWrittenOut: (on) => { log.push("markWrittenOut:" + on); }
    },
    deferred: {
      copyHistory: (fromId, toId) => { log.push("copyHistory:" + fromId + ">" + toId); },
      syncIdentity: () => { log.push("syncIdentity"); },
      setBaseline: (published, reason) => { log.push("setBaseline:" + (published as { rev: number }).rev + ":" + reason); }
    },
    saves: {
      changes: () => changes,
      confirmSavedNow: () => { log.push("confirmSavedNow"); }
    }
  };
  return { log, amended, completion: createSaveCompletion(ports) };
}

const HOME = { kind: "file", name: "pilot.md" } as unknown as Home;

test("a confirmed write stamps, sets the baseline, amends the landed home, marks it written out and confirms clean, in that order", () => {
  const h = harness();
  const doc = captured();
  const published = { rev: 3 };
  h.completion.confirmWrite({ captured: doc, published, forkDocId: null, docIdAtSave: OLD_ID, seqAtSave: 4, landed: { home: HOME, lastModified: 77 } });
  assert.deepEqual(h.log, [
    "stamp:stamp-edit",
    "setBaseline:3:saveDoc: the bytes just written",
    "amendHome:diskBase,lastModified",
    "markWrittenOut:true",
    "syncIdentity",
    "confirmSavedNow"
  ]);
  assert.deepEqual(h.amended, [{ diskBase: published, lastModified: 77 }]);
});

test("a write with no landed home, or no modified time, amends less", () => {
  const h = harness();
  h.completion.confirmWrite({ captured: captured(), published: { rev: 3 }, forkDocId: null, docIdAtSave: OLD_ID, seqAtSave: 4, landed: null });
  assert.equal(h.log.some((l) => l.startsWith("amendHome")), false);
  const g = harness();
  g.completion.confirmWrite({ captured: captured(), published: { rev: 3 }, forkDocId: null, docIdAtSave: OLD_ID, seqAtSave: 4, landed: { home: HOME, lastModified: null } });
  assert.ok(g.log.includes("amendHome:diskBase"));
});

test("an edit made during the save leaves the document unconfirmed", () => {
  const h = harness(5);
  h.completion.confirmWrite({ captured: captured(), published: { rev: 3 }, forkDocId: null, docIdAtSave: OLD_ID, seqAtSave: 4, landed: null });
  assert.equal(h.log.includes("confirmSavedNow"), false);
  assert.equal(h.log.at(-1), "syncIdentity");
});

test("a forked copy copies the history and takes the new id when the save still owns the document", () => {
  const h = harness();
  h.completion.confirmWrite({ captured: captured(), published: { rev: 3 }, forkDocId: NEW_ID, docIdAtSave: OLD_ID, seqAtSave: 4, landed: null });
  assert.deepEqual(h.log.slice(2), [
    "copyHistory:" + OLD_ID + ">" + NEW_ID,
    "stamp:stamp-document-id",
    "markWrittenOut:true",
    "syncIdentity",
    "confirmSavedNow"
  ]);
});

test("a copy that lands after the save lost the document only copies the history", () => {
  const h = harness();
  h.completion.adoptSavedCopyDocId(NEW_ID, OLD_ID, false);
  assert.deepEqual(h.log, ["copyHistory:" + OLD_ID + ">" + NEW_ID]);
  const g = harness();
  g.completion.adoptSavedCopyDocId(null, OLD_ID, false);
  assert.deepEqual(g.log, []);
});
