import { bootApp, closeApp, seen } from "./_app-boot.mjs";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { cloneState } from "../core/document/clone.ts";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";
import { currentDocument } from "../legacy/session-bridge.ts";

const atBoot = await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { adoptRestoredState } = await import("../js/02b-doc-id.js");
const { applyMerge } = await import("../js/03-sync.js");
const { openLongDemo, startNewScript } = await import("../js/18b-file-menu.js");
const { seedCheckPasses } = await import("../legacy/seed-check.ts");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { applyTakenDraft } = await import("../js/20g-drafts.js");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

function fixedPoint(value) {
  if (value === null || value === undefined) return value;
  return JSON.stringify(migrateRows(cloneState(value))) === JSON.stringify(value);
}

async function drive(fn) {
  seen.length = 0;
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  await new Promise((r) => setTimeout(r, 20));
  return { records: seen.splice(0), thrown };
}

function only(got, site) {
  const at = got.records.filter((r) => r.site === site);
  assert.equal(at.length, 1, site + " assigned once: [" + got.records.map((r) => r.site).join(", ") + "] " + (got.thrown || ""));
  return at[0].value;
}

function rawDoc(title) {
  return {
    schema: 2,
    title: title,
    rows: [
      { id: "r1", visualText: "Wide on the <b>harbour</b>", audioText: "Every morning.", status: "ready" },
      { id: "r2", visualText: "Close", audioText: "Mara mends nets.", status: "bogus", lengthSeconds: 90 }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", text: "Tighter", replies: [] }]
  };
}

function migrated(title) {
  return migrateRows(rawDoc(title));
}

test("boot from the seed: the transition API's live-document port replaces the session's document once, with the seed script, a migrateRows fixed point", () => {
  assert.equal(seedCheckPasses(), true, "the page's seed check matches its state-data, as a fresh build's does");
  assert.deepEqual(atBoot.map((r) => r.site), ["replaced"]);
  const seed = JSON.parse(readFileSync(new URL("../seed-state.json", import.meta.url), "utf8"));
  assert.equal(atBoot[0].value.title, seed.title);
  assert.equal(atBoot[0].value.rows.length, seed.rows.length);
  assert.equal(fixedPoint(atBoot[0].value), true);
});

test("02b adoptRestoredState, through the live-document port: a migrateRows fixed point, its docId kept", async () => {
  const before = currentDocument().docId;
  const value = only(await drive(() => adoptRestoredState(rawDoc("Restored"))), "replaced");
  assert.equal(fixedPoint(value), true);
  assert.equal(currentDocument().docId, before, "the docId is put back before the replacement");
  assert.equal(fixedPoint(currentDocument()), true);
});

test("03-sync applyMerge's adopt, after a merge: the session absorbs the merged document, a migrateRows fixed point, with no replacement", async () => {
  const base = migrated("Merge");
  const mine = cloneState(base);
  const theirs = cloneState(base);
  mine.rows[0].audioText = "Mine.";
  theirs.rows[1].audioText = "Theirs.";
  const got = await drive(() => applyMerge({ base, mine, theirs, source: "stash", report: false }));
  assert.deepEqual(got.records, [], String(got.thrown || ""));
  assert.equal(currentDocument().rows[0].audioText, "Mine.");
  assert.equal(currentDocument().rows[1].audioText, "Theirs.");
  assert.equal(fixedPoint(currentDocument()), true);
});

test("03-sync applyMerge's adopt, nothing to merge: the session absorbs theirs as handed over, migrated in place as it enters, with no replacement", async () => {
  const fromMigrated = await drive(() => applyMerge({ theirs: migrated("Same"), source: "stash", unchanged: true, report: false }));
  assert.deepEqual(fromMigrated.records, [], String(fromMigrated.thrown || ""));
  assert.equal(currentDocument().title, "Same");
  assert.equal(fixedPoint(currentDocument()), true);
  const raw = rawDoc("Raw");
  const fromRaw = await drive(() => applyMerge({ theirs: raw, source: "stash", unchanged: true, report: false }));
  assert.deepEqual(fromRaw.records, [], String(fromRaw.thrown || ""));
  assert.equal(currentDocument(), raw, "the session holds the very object handed over");
  assert.equal(fixedPoint(raw), true, "in place: the very object handed over is now a migrateRows fixed point");
});

test("13-hosted openServerDoc: migrateDocument's answer through the live-document port, a migrateRows fixed point", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "doc1", rev: 3, state: rawDoc("From the server") }),
    { status: 200, headers: { "content-type": "application/json" } });
  useDesktopForTest({});
  try {
    const got = await drive(() => openDocument({ kind: "server", id: "doc1" }));
    assert.equal(fixedPoint(only(got, "replaced")), true);
  } finally {
    globalThis.fetch = realFetch;
    restoreDesktop();
  }
});

test("18-local-files adoptProjectState, from a .splitpage file, through the live-document port: a migrateRows fixed point", async () => {
  const file = new File([buildSplitpageFile(exportDocumentOf(migrated("On disk")))], "disk.splitpage", { lastModified: 1 });
  const got = await drive(() => openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } }));
  assert.equal(fixedPoint(only(got, "replaced")), true);
});

test("18-local-files loadFileIntoEditor, from a .txt import, through the live-document port: a migrateRows fixed point", async () => {
  const file = new File(["Wide on the harbour\tEvery morning.\nClose\tMara mends nets."], "import.txt", { lastModified: 1 });
  const got = await drive(() => openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } }));
  assert.equal(fixedPoint(only(got, "replaced")), true);
});

test("18b replaceWithNewDocument, a new script and the long demo, through the live-document port: migrateRows fixed points", async () => {
  assert.equal(fixedPoint(only(await drive(() => startNewScript()), "replaced")), true);
  assert.equal(fixedPoint(only(await drive(() => openLongDemo()), "replaced")), true);
});

test("20g recoverDraftAsUnsavedCopy, an imported file's draft, through the live-document port: a migrateRows fixed point with a minted docId", async () => {
  const draftId = "d" + "1".repeat(32);
  const t = { header: { origin: { kind: "import", importName: "a.docx" } }, stateJson: JSON.stringify(Object.assign(rawDoc("Import draft"), { docId: draftId })) };
  const value = only(await drive(() => applyTakenDraft(t)), "replaced");
  assert.equal(fixedPoint(value), true);
  assert.match(value.docId, /^d[0-9a-f]{32}$/);
  assert.notEqual(value.docId, draftId, "the copy is given a docId of its own before it is assigned");
});

test("20g restoreFileDraft, a desktop file untouched since the draft's base: the draft, last through the live-document port, a migrateRows fixed point", async () => {
  const docId = "d" + "2".repeat(32);
  const disk = migrateRows(Object.assign(rawDoc("On disk"), { docId }));
  const bytes = new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(disk)));
  useDesktopForTest({
    readFile: async () => ({ name: "disk.splitpage", bytes, lastModified: 1 }),
    setDocumentState: () => {},
    draftRestoreDone: () => {}
  });
  const t = {
    header: { origin: { kind: "file", fileName: "disk.splitpage" }, docIdWrittenOut: true },
    file: { id: "f1", name: "disk.splitpage" },
    stateJson: JSON.stringify(Object.assign(rawDoc("Edited since"), { docId })),
    baseJson: JSON.stringify(disk)
  };
  try {
    const got = await drive(() => applyTakenDraft(t));
    const value = got.records.filter((r) => r.site === "replaced").pop().value;
    assert.equal(fixedPoint(value), true);
    assert.equal(value.title, "Edited since");
  } finally {
    restoreDesktop();
  }
});

test("20g adoptUntitledDraft, through the live-document port: a migrateRows fixed point", async () => {
  const t = { header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(rawDoc("Untitled draft")) };
  assert.equal(fixedPoint(only(await drive(() => applyTakenDraft(t)), "replaced")), true);
});

test("20j adoptNewDocument, from the new-tab page's New script, through the live-document port: a migrateRows fixed point", async () => {
  const button = document.querySelector('#newtab-page [data-newtab-action="new"]');
  assert.ok(button, "the page has the button");
  const got = await drive(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  assert.equal(fixedPoint(only(got, "replaced")), true);
});
