import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import {
  createHeldDesktop,
  createHeldFetch,
  mockClock,
  rightToday
} from "./_m4-matrix.mjs";
import { cloneState } from "../core/document/clone.ts";
import { autoSavePolicy, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";

await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { restoreSnapshotFromCard } = await import("../bootstrap/wiring/history-panel.ts");
const { noteSessionEdit } = await import("../bootstrap/wiring/session-owner.ts");
const { confirmSavedNow, setAutoSaveEnabled } = await import("../bootstrap/wiring/save-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const flushEdits = () => undoOwner().flush();
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { startNewScript } = await import("../bootstrap/wiring/file-menu-controls.ts");
const { applyTakenDraft } = await import("../bootstrap/wiring/drafts.ts");
const { flushDraftNow } = await import("../bootstrap/wiring/recovery-owners.ts");
const { bytesForSync, createMemoryBackend, ensureBytes, has, internDataUrl, isDurableSync, persist, setBackend: setBlobBackend } = await import("../adapters/storage/02c-blobs.ts");
const { addGalleryPicture } = await import("../core/document/gallery.ts");
const homeModule = await import("../bootstrap/wiring/location-owner.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument, keepSnapshot } = await import("../bootstrap/wiring/transition-owners.ts");

const require = createRequire(import.meta.url);
const { createDraftStore } = require("../../desktop/drafts.js");

after(closeApp);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const idOf = (letter) => "d" + letter.repeat(32);
const drafts = () => window.__desktopTest.drafts;
const pause = () => new Promise((resolve) => setImmediate(resolve));

async function settleIo(turns = 80) {
  for (let turn = 0; turn < turns; turn++) await pause();
}

async function until(check, what) {
  for (let turn = 0; turn < 600; turn++) {
    if (await check()) return;
    await pause();
  }
  assert.fail("never happened: " + what);
}

function script(title, extra) {
  return migrateRows(Object.assign({
    schema: 5, title: title, docId: idOf("4"),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  }, extra || {}));
}

function splitpageFile(doc, name) {
  return new File([buildSplitpageFile(exportDocumentOf(doc))], name || "m4.splitpage", { lastModified: 1 });
}

function useDocument(doc) {
  loadTestDocument(doc);
  flushEdits();
  confirmSavedNow();
  return doc;
}

function typeInto(text) {
  currentDocument().rows[0].audioText = text;
  noteSessionEdit();
}

async function endCase() {
  confirmSavedNow();
  await flushDraftNow();
  useDocument(script("After the case", { docId: idOf("0") }));
  setAutoSaveEnabled(true);
}

async function cleanly(run) {
  try {
    await run();
  } finally {
    await endCase();
  }
}

function toasts() {
  return Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)")).map((el) => (el.classList.contains("has-action") ? el.firstChild.nodeValue : el.textContent));
}

async function advance(clock, ms) {
  clock.tick(ms);
  await settleIo();
}

rightToday("B8", "restoring a draft of an unsaved script writes nothing anywhere", (t) => cleanly(async () => {
  const clock = mockClock(t);
  setAutoSaveEnabled(true);
  const base = script("Restored", { docId: idOf("3") });
  const mine = cloneState(base);
  mine.rows[0].audioText = "Unsaved in the browser.";
  const sent = createHeldFetch({ connection: () => "tab" });
  const uninstall = sent.install();
  try {
    useDocument(script("Before the untitled draft"));
    const outcome = await applyTakenDraft({ header: { origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: JSON.stringify(mine) });
    assert.equal(outcome, "applied");
    assert.equal(currentDocument().rows[0].audioText, "Unsaved in the browser.", "the recovered work is on screen");
    assert.equal(unsavedChanges(), true, "and unsaved");
    await advance(clock, 40000);
    assert.deepEqual(sent.requests, [], "nothing was sent anywhere");
    assert.equal(homeModule.currentHome().kind, "none", "no file destination was set");
    assert.equal(autoSavePolicy().pending(), false, "no autosave is armed");
  } finally {
    uninstall();
  }
}));

function withDraftWrites() {
  const written = [];
  const fake = window.__desktopTest.makeFakeBackend();
  fake.writeDraft = (p) => { written.push(p); return Promise.resolve({ ok: true }); };
  window.__desktopTest.setBackend(fake);
  return { last: () => written[written.length - 1], restore: () => window.__desktopTest.restoreBackend() };
}

rightToday("B10", "a draft whose pictures could not be persisted carries them inline and restores with them", async () => {
  const failing = createMemoryBackend();
  failing.put = () => Promise.reject(new Error("blob store full"));
  setBlobBackend(failing);
  const consoles = [...new Set([window.console, globalThis.console])];
  const warns = consoles.map((c) => c.warn);
  consoles.forEach((c) => { c.warn = () => {}; });
  const desk = withDraftWrites();
  try {
    useDocument(script("Pictures", { docId: idOf("7") }));
    const rec = internDataUrl(PNG);
    addGalleryPicture(currentDocument().rows[0], rec, "p.png");
    typeInto("With a picture.");
    assert.equal((await flushDraftNow()).ok, true);
    const stored = desk.last();
    assert.notEqual(stored, undefined, "the draft was written all the same");
    assert.match(stored.stateJson, /data:image\/png;base64,/, "the picture's bytes travel inside the draft");
    const restored = migrateRows(JSON.parse(stored.stateJson));
    const slot = restored.rows[0].imageRef;
    assert.equal(slot && slot.sha256, rec.sha256, "restoring gives the same picture back");
  } finally {
    desk.restore();
    consoles.forEach((c, i) => { c.warn = warns[i]; });
    setBlobBackend(null);
    await endCase();
  }
});

rightToday("B10b", "a draft whose pictures are stored locally carries only their refs, and after a restart they come back from the store", async () => {
  const disk = Object.assign(createMemoryBackend(), { name: "disk", persistent: true });
  setBlobBackend(disk);
  const desk = withDraftWrites();
  try {
    useDocument(script("Stored pictures", { docId: idOf("8") }));
    const rec = internDataUrl(PNG);
    assert.deepEqual(await persist([rec.sha256]), [], "setup: the picture is stored");
    assert.equal(isDurableSync(rec.sha256), true);
    addGalleryPicture(currentDocument().rows[0], rec, "q.png");
    typeInto("With a stored picture.");
    assert.equal((await flushDraftNow()).ok, true);
    const stored = desk.last();
    assert.notEqual(stored, undefined, "the draft was written");
    assert.doesNotMatch(stored.stateJson, /data:image\//, "the draft carries no picture bytes");
    assert.match(stored.stateJson, new RegExp(rec.sha256), "the draft names the picture by its hash");

    window.__blobsTest.forgetMemory();
    assert.equal(has(rec.sha256), false, "setup: after the restart the picture is not in memory");
    const restored = migrateRows(JSON.parse(stored.stateJson));
    const slot = restored.rows[0].imageRef;
    assert.equal(slot && slot.sha256, rec.sha256, "restoring gives the same picture back");
    assert.deepEqual(await ensureBytes([rec.sha256]), [], "its bytes come back from the store");
    const bytes = bytesForSync(rec.sha256);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    assert.equal(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""), rec.sha256, "and they are the picture's own bytes");
  } finally {
    desk.restore();
    setBlobBackend(null);
    await endCase();
  }
});

rightToday("B11", "after a restart, the unsaved work left by the closed session comes back as unsaved work and writes nothing", async (t) => {
  mockClock(t);
  const sent = createHeldFetch({ connection: () => "tab" });
  const uninstall = sent.install();
  try {
    useDocument(script("The fresh start"));
    const left = script("Left behind", { docId: idOf("8") });
    left.rows[0].audioText = "Typed before the crash.";
    const outcome = await applyTakenDraft({ header: { origin: { kind: "untitled" }, docIdWrittenOut: false, writtenAt: Date.now() - 60000 }, stateJson: JSON.stringify(left), ageMs: 60000 });
    assert.equal(outcome, "applied");
    assert.equal(currentDocument().title, "Left behind");
    assert.equal(currentDocument().rows[0].audioText, "Typed before the crash.");
    assert.equal(unsavedChanges(), true, "it is marked unsaved");
    assert.ok(toasts().some((x) => /Restored your unsaved script/.test(x) && /save it somewhere/.test(x)), "the user is told it was never saved");
    const gone = await applyTakenDraft({ header: { origin: { kind: "file", fileName: "gone.splitpage" }, docIdWrittenOut: true }, stateJson: JSON.stringify(left) });
    assert.equal(gone, "untitled-copy", "a draft of a file that is no longer there opens as an unsaved copy");
    assert.equal(homeModule.currentHome().kind, "none");
    assert.equal(unsavedChanges(), true);
    assert.deepEqual(sent.requests, [], "nothing was sent anywhere");
  } finally {
    uninstall();
    await endCase();
  }
});

function withHeldDesktop() {
  const fake = window.__desktopTest.makeFakeBackend();
  const held = createHeldDesktop(fake);
  window.__desktopTest.setBackend(held.desktop);
  return { fake: fake, held: held, restore: () => window.__desktopTest.restoreBackend() };
}

rightToday("K1", "a desktop file-draft restore whose document is replaced across its awaits does not overwrite the replacement", async () => {
  useDocument(script("Before the restore"));
  const original = script("On disk", { docId: idOf("9") });
  const mine = cloneState(original);
  mine.rows[0].audioText = "Unsaved here.";
  const { fake, held, restore } = withHeldDesktop();
  try {
    const picked = await fake.saveFileDialog({ suggestedName: "disk.splitpage" });
    await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(original))));
    held.holdOp("readFile");
    const restoring = applyTakenDraft({
      header: { origin: { kind: "file", fileName: picked.name }, docIdWrittenOut: true },
      file: { id: picked.id, name: picked.name },
      stateJson: JSON.stringify(mine),
      baseJson: JSON.stringify(original)
    });
    await held.arrivedAt("readFile");
    startNewScript();
    assert.equal(currentDocument().title, "Untitled Script", "setup: the user replaced the document meanwhile");
    held.releaseOp("readFile");
    const outcome = await restoring;
    assert.ok(!["unreadable", "untitled-copy"].includes(outcome), "setup: the restore read the file");
    assert.equal(outcome, "kept", "the restore tells the desktop app the draft is kept, so it opens nothing over the replacement");
    assert.equal(currentDocument().title, "Untitled Script", "the replacement document is still the open document");
    assert.equal(currentDocument().rows.some((r) => r.audioText === "Unsaved here."), false, "the late restore put none of its text into the replacement");
  } finally {
    held.gates.releaseAll("desktop.readFile");
    restore();
    homeModule.setHome("none");
  }
});

rightToday("K1b", "a desktop file-draft merge whose document is replaced while its backup is stored does not overwrite the replacement", async () => {
  useDocument(script("Before the restore"));
  const original = script("On disk", { docId: idOf("9") });
  const disk = cloneState(original);
  disk.rows[1].audioText = "Changed on disk.";
  const mine = cloneState(original);
  mine.rows[0].audioText = "Unsaved here.";
  const { fake, restore } = withHeldDesktop();
  try {
    const picked = await fake.saveFileDialog({ suggestedName: "disk.splitpage" });
    await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(disk))));
    window.__historyTest.injectFault("delay-put");
    const restoring = applyTakenDraft({
      header: { origin: { kind: "file", fileName: picked.name }, docIdWrittenOut: true },
      file: { id: picked.id, name: picked.name },
      stateJson: JSON.stringify(mine),
      baseJson: JSON.stringify(original)
    });
    await until(() => currentDocument().title === "On disk", "the restore opened the changed file");
    await settleIo(20);
    assert.equal(currentDocument().rows[0].audioText, "One.", "setup: the merge is waiting for its backup");
    startNewScript();
    assert.equal(currentDocument().title, "Untitled Script", "setup: the user replaced the document meanwhile");
    window.__historyTest.releaseDelayedPut();
    const outcome = await restoring;
    assert.equal(outcome, "kept", "the restore keeps the draft for the next launch");
    assert.equal(currentDocument().title, "Untitled Script", "the replacement document is still the open document");
    assert.equal(currentDocument().rows.some((r) => r.audioText === "Unsaved here." || r.audioText === "Changed on disk."), false,
      "the late merge put none of its text into the replacement");
    assert.equal(homeModule.currentHome().kind, "none", "and the replacement keeps its own destination");
  } finally {
    window.__historyTest.injectFault(null);
    restore();
    homeModule.setHome("none");
  }
});

rightToday("K2", "a desktop draft write that lands after the tab navigated is refused, pauses nothing, and the next write lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m4-k2-"));
  const store = createDraftStore({ dir: dir, fs: require("node:fs"), fsp: require("node:fs/promises"), path: require("node:path"), crypto: require("node:crypto"), appVersion: "test", testHooks: { writeDelayMs: 120 } });
  const TAB = "0123456789abcdef0123456789abcdef";
  const fake = window.__desktopTest.makeFakeBackend();
  fake.writeDraft = (p) => store.write(TAB, {
    title: p.title, docId: p.docId, docIdWrittenOut: p.docIdWrittenOut, schema: p.schema, editSeq: p.editSeq,
    origin: { kind: p.originKind, filePath: null, fileName: null, fileKind: null, importName: null, baseLastModified: null, baseSize: null, server: null },
    placement: null
  }, p.stateJson, p.baseJson === undefined ? null : p.baseJson, p.seq);
  window.__desktopTest.setBackend(fake);
  try {
    useDocument(script("Navigated"));
    typeInto("Typed before the tab navigated.");
    const flushing = flushDraftNow();
    await settleIo(5);
    store.resetSeq(TAB);
    const late = await flushing;
    assert.equal(late.ok, false);
    assert.equal(late.code, "STALE_SEQ", "the write that landed after the navigation was refused");
    assert.equal(store.hasDraft(TAB), false, "it left no draft behind");
    assert.equal(drafts().status().paused, false, "a stale write does not pause crash recovery");
    typeInto("Typed after the tab navigated.");
    const next = await flushDraftNow();
    assert.equal(next.ok, true, "the next write on the new page lands");
    assert.equal(store.hasDraft(TAB), true);
  } finally {
    window.__desktopTest.restoreBackend();
    confirmSavedNow();
    await flushDraftNow();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function snapshotRestore(setup) {
  const doc = script("History", { docId: idOf("b") });
  await openDocument({ kind: "file", file: splitpageFile(doc), handle: null, options: { skipSnapshot: true, silent: true } });
  confirmSavedNow();
  const point = cloneState(currentDocument());
  point.rows[0].audioText = "As it was.";
  const ticket = keepSnapshot("A point to go back to", point);
  await ticket.done;
  const button = document.createElement("button");
  button.setAttribute("data-id", ticket.id);
  window.__historyTest.injectFault("delay-put");
  const restoring = restoreSnapshotFromCard(button);
  let finished = false;
  restoring.then(() => { finished = true; }, () => { finished = true; });
  try {
    await settleIo(20);
    assert.equal(finished, false, "setup: the restore is waiting for its backup");
    currentDocument().rows[1].audioText = "Typed while the backup was being stored.";
    await setup(doc);
  } finally {
    window.__historyTest.releaseDelayedPut();
  }
  return restoring;
}

rightToday("H1", "a history restore that completes after a same-id reopen does not overwrite the reopened session", async () => {
  const outcome = await snapshotRestore(async (doc) => {
    const replaced = currentDocument();
    await openDocument({ kind: "file", file: splitpageFile(doc), handle: null, options: { skipSnapshot: true, silent: true } });
    confirmSavedNow();
    assert.notEqual(currentDocument(), replaced, "setup: the reopen put a new document in place");
    assert.equal(currentDocument().docId, replaced.docId, "setup: the reopened document has the same id");
    currentDocument().rows[1].audioText = "Typed in the reopened session.";
    noteSessionEdit();
  });
  assert.equal(currentDocument().rows[0].audioText, "One.", "the reopened session's first scene is untouched");
  assert.equal(currentDocument().rows[1].audioText, "Typed in the reopened session.", "its own typing is still there");
  assert.notEqual(outcome, "restored", "the late restore was refused");
});

rightToday("H1-switch", "a history restore that completes after another document was opened is refused and says so", async () => {
  const other = script("Another script", { docId: idOf("c") });
  const outcome = await snapshotRestore(async () => {
    await openDocument({ kind: "file", file: splitpageFile(other), handle: null, options: { skipSnapshot: true, silent: true } });
    confirmSavedNow();
  });
  assert.equal(outcome, "changed");
  assert.equal(currentDocument().title, "Another script", "the other document is untouched");
  assert.equal(currentDocument().rows[0].audioText, "One.");
  assert.ok(toasts().some((x) => /A different document was opened while restoring, so nothing was restored/.test(x)), "the user is told nothing was restored");
});

rightToday("H2", "a snapshot holds the document as it was when keepSnapshot was called", async () => {
  useDocument(script("Before the snapshot", { docId: idOf("d") }));
  const ticket = keepSnapshot("Before the edit");
  currentDocument().rows[0].audioText = "Typed after the snapshot call.";
  currentDocument().title = "Renamed after the snapshot call";
  noteSessionEdit();
  const stored = await ticket.done;
  assert.equal(stored.stored, true);
  const got = await window.__historyTest.read({ docId: idOf("d"), id: ticket.id });
  const held = JSON.parse(got.stateJson);
  assert.equal(held.title, "Before the snapshot", "the title is the one at the call");
  assert.equal(held.rows[0].audioText, "One.", "the text is the one at the call");
});
