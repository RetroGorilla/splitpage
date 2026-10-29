import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEPT_NOTICE, RESTORE_FAILED_NOTICE, alreadySavedNotice, differentScriptCopy, draftAgeText, draftMigrate, draftReasonFor, draftRefId,
  draftTitleOf, draftWhenText, importCopy, mergedFileNotice, missingFileCopy, missingFileName, restoredFileNotice, sameDocContent,
  takenDraftFate, unreadableFileCopy, untitledRestoredNotice
} from "../../../src/application/recovery/draft-restore.ts";
import type { DraftMigrate, TakenDraft } from "../../../src/application/recovery/draft-restore.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const ID_A = "d" + "a".repeat(32);
const ID_B = "d" + "b".repeat(32);

function migrator(): DraftMigrate {
  const ports = fakeMigration().ports;
  return (raw) => migrateRows(raw, ports);
}

function doc(migrate: DraftMigrate, title: string, docId = ID_A): ValidatedDocument {
  return migrate({ title: title, docId: docId, rows: [{ id: "r1", audioText: title }] });
}

function taken(fields: Partial<TakenDraft>): TakenDraft {
  return { header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify({ title: "Mine", rows: [{ id: "r1", audioText: "mine" }] }), ...fields };
}

test("draft restore: a missing, newer, corrupt or headerless draft settles without restoring", () => {
  const migrate = migrator();
  assert.deepEqual(takenDraftFate(null, migrate), { kind: "settled", outcome: "nothing-unsaved", notice: null });
  const newer = takenDraftFate({ unsupported: true }, migrate);
  assert.equal(newer.kind, "settled");
  assert.equal(newer.kind === "settled" && newer.outcome, "failed");
  assert.match(String(newer.kind === "settled" && newer.notice), /saved by a newer version of Splitpage/);
  const corrupt = takenDraftFate({ corrupt: true }, migrate);
  assert.equal(corrupt.kind === "settled" && corrupt.notice, "The changes recovered from the last session couldn't be read — they have been kept for the next launch.");
  assert.deepEqual(takenDraftFate({ stateJson: "{}" }, migrate), { kind: "settled", outcome: "failed", notice: null });
  assert.deepEqual(takenDraftFate({ header: {}, stateJson: 7 }, migrate), { kind: "settled", outcome: "failed", notice: null });
});

test("draft restore: a draft whose state does not parse to rows fails with the unreadable notice", () => {
  const migrate = migrator();
  for (const stateJson of ["not json", "null", JSON.stringify({ title: "no rows" })]) {
    const fate = takenDraftFate(taken({ stateJson }), migrate);
    assert.equal(fate.kind, "settled", stateJson);
    assert.equal(fate.kind === "settled" && fate.outcome, "failed");
    assert.match(String(fate.kind === "settled" && fate.notice), /couldn't be read/);
  }
});

test("draft restore: a readable draft is routed by its origin, untitled when it has none", () => {
  const migrate = migrator();
  const routes = [["server", "untitled"], ["file", "file"], ["import", "import"], ["untitled", "untitled"], ["other", "untitled"]] as const;
  for (const [kind, route] of routes) {
    const fate = takenDraftFate(taken({ header: { origin: { kind } } }), migrate);
    assert.equal(fate.kind === "restore" && fate.route, route, kind);
  }
  const bare = takenDraftFate(taken({ header: {} }), migrate);
  assert.equal(bare.kind === "restore" && bare.route, "untitled");
  assert.deepEqual(bare.kind === "restore" && bare.origin, { kind: "untitled" });
});

test("draft restore: the base is read only when the draft carries one", () => {
  const migrate = migrator();
  const without = takenDraftFate(taken({}), migrate);
  assert.equal(without.kind === "restore" && without.base, null);
  const withBase = takenDraftFate(taken({ baseJson: JSON.stringify({ title: "Base", rows: [] }) }), migrate);
  assert.equal(withBase.kind === "restore" && withBase.base?.title, "Base");
  assert.equal(withBase.kind === "restore" && withBase.mine.title, "Mine");
  const badBase = takenDraftFate(taken({ baseJson: "nope" }), migrate);
  assert.equal(badBase.kind === "restore" && badBase.base, null);
});

test("draft restore: draftMigrate only migrates an object with rows", () => {
  const seen: unknown[] = [];
  const migrate: DraftMigrate = (raw) => { seen.push(raw); return migrator()(raw); };
  assert.equal(draftMigrate(5, migrate), null);
  assert.equal(draftMigrate("[]", migrate), null);
  assert.equal(draftMigrate(JSON.stringify({ rows: {} }), migrate), null);
  assert.equal(seen.length, 0);
  assert.equal(draftMigrate(JSON.stringify({ title: "T", rows: [] }), migrate)?.title, "T");
  assert.equal(seen.length, 1);
});

test("draft restore: copies say why the draft opened as an unsaved copy and what the outcome is", () => {
  assert.equal(importCopy({ importName: "notes.docx" }).notice, "Your unsaved changes to notes.docx were recovered. They are open here as an unsaved copy — save them as a Splitpage script to keep them.");
  assert.match(importCopy({}).notice, /^Your unsaved changes to an imported file were recovered/);
  assert.deepEqual(missingFileCopy(taken({ fileProblem: "unreadable" }), "a.splitpage"), {
    notice: "The file these recovered changes belong to (a.splitpage) couldn't be read — they are open here as an unsaved copy.",
    outcome: "unreadable"
  });
  assert.deepEqual(missingFileCopy(taken({}), "a.splitpage"), {
    notice: "The file these recovered changes belong to (a.splitpage) isn't where it was — they are open here as an unsaved copy.",
    outcome: "untitled-copy"
  });
  assert.deepEqual(unreadableFileCopy("a.splitpage"), {
    notice: "The file these recovered changes belong to (a.splitpage) could not be read — they are open here as an unsaved copy.",
    outcome: "unreadable"
  });
});

test("draft restore: the missing file is named by the origin, then the draft's title, then a fallback", () => {
  const migrate = migrator();
  assert.equal(missingFileName(doc(migrate, "Pilot"), { fileName: "pilot.splitpage" }), "pilot.splitpage");
  assert.equal(missingFileName(doc(migrate, "Pilot"), {}), "Pilot");
  assert.equal(missingFileName(doc(migrate, ""), {}), "this script");
  assert.equal(draftTitleOf(null, "fallback"), "fallback");
});

test("draft restore: a file holding a different script is a copy only when its id is embedded and differs", () => {
  const migrate = migrator();
  const mine = doc(migrate, "Mine", ID_A);
  const base = doc(migrate, "Base", ID_B);
  assert.equal(draftRefId(mine, null), ID_A);
  assert.equal(draftRefId(mine, base), ID_B);
  const other = doc(migrate, "Disk", ID_A);
  assert.equal(differentScriptCopy({ state: other, docIdEmbedded: false }, ID_B, "x.splitpage"), null);
  assert.equal(differentScriptCopy({ state: other, docIdEmbedded: true }, "", "x.splitpage"), null);
  assert.equal(differentScriptCopy({ state: other, docIdEmbedded: true }, ID_A, "x.splitpage"), null);
  assert.deepEqual(differentScriptCopy({ state: other, docIdEmbedded: true }, ID_B, "x.splitpage"), {
    notice: "A different script has been saved as x.splitpage — the changes recovered from the last session are open here as an unsaved copy.",
    outcome: "untitled-copy"
  });
});

test("draft restore: content comparison ignores revision, editor, edit time and id", () => {
  const migrate = migrator();
  const a = doc(migrate, "Same", ID_A);
  const b = migrate({ title: "Same", docId: ID_B, rev: 9, lastEditedBy: "Ann", lastEditedAt: "2026-01-01T00:00:00.000Z", rows: [{ id: "r1", audioText: "Same" }] });
  assert.equal(sameDocContent(a, b, migrate), true);
  assert.equal(sameDocContent(a, doc(migrate, "Other"), migrate), false);
  assert.equal(sameDocContent(a, null, migrate), false);
  assert.equal(sameDocContent(undefined, a, migrate), false);
  assert.equal(sameDocContent(a, b, () => { throw new Error("bad"); }), false);
});

test("draft restore: age and session texts", () => {
  assert.equal(draftAgeText(undefined), "");
  assert.equal(draftAgeText(-1), "");
  assert.equal(draftAgeText(Infinity), "");
  assert.equal(draftAgeText(29999), "from a moment ago");
  assert.equal(draftAgeText(60000), "from 1 minute ago");
  assert.equal(draftAgeText(59 * 60000), "from 59 minutes ago");
  assert.equal(draftAgeText(60 * 60000), "from 1 hour ago");
  assert.equal(draftAgeText(3 * 3600000), "from 3 hours ago");
  assert.equal(draftAgeText(24 * 3600000), "from 1 day ago");
  assert.equal(draftAgeText(72 * 3600000), "from 3 days ago");
  assert.equal(draftWhenText(null), "");
  assert.equal(draftWhenText({ ageMs: 120000, previousSession: "running" }), "from 2 minutes ago, before Splitpage closed unexpectedly");
  assert.equal(draftWhenText({ previousSession: "session-end" }), "before Windows signed you out");
  assert.equal(draftWhenText({ previousSession: "clean-exit" }), "before Splitpage closed");
  assert.equal(draftWhenText({ ageMs: 0, previousSession: "none" }), "from a moment ago");
});

test("draft restore: restore notices", () => {
  const migrate = migrator();
  assert.equal(alreadySavedNotice(doc(migrate, "Pilot"), "p.splitpage"), "Opened Pilot — the changes from the last session were already saved");
  assert.equal(alreadySavedNotice(doc(migrate, ""), "p.splitpage"), "Opened p.splitpage — the changes from the last session were already saved");
  assert.equal(restoredFileNotice({ ageMs: 60000 }, "Pilot", "p.splitpage"), "Restored your unsaved changes to Pilot from 1 minute ago");
  assert.equal(restoredFileNotice({}, "", "p.splitpage"), "Restored your unsaved changes to p.splitpage");
  assert.equal(mergedFileNotice("p.splitpage"), "p.splitpage had changed since the last session — your recovered changes were merged into it. Nothing has been saved yet.");
  assert.match(mergedFileNotice(""), /^That file had changed/);
  assert.equal(untitledRestoredNotice({}), "Restored your unsaved script — it has never been saved, so save it somewhere.");
  assert.equal(untitledRestoredNotice({ previousSession: "clean-exit" }), "Restored your unsaved script before Splitpage closed — it has never been saved, so save it somewhere.");
  assert.equal(KEPT_NOTICE, "Another script was opened while the changes from the last session were being restored — they have been kept for the next launch.");
  assert.equal(RESTORE_FAILED_NOTICE, "Could not restore the changes from the last session — they have been kept for the next launch.");
});

test("draft restore: paused-copy reasons", () => {
  assert.equal(draftReasonFor("ENOSPC"), "this disk is full");
  assert.equal(draftReasonFor("EACCES"), draftReasonFor("EPERM"));
  assert.equal(draftReasonFor("QUOTA"), "this browser's storage is full");
  assert.equal(draftReasonFor("anything"), "the copy was refused");
});
