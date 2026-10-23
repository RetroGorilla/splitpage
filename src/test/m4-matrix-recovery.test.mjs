import { bootApp, closeApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { currentDocument } from "../legacy/session-bridge.ts";
import {
  createFakeLocks,
  createFaultyIdbFactory,
  createHeldBlobBackend,
  createHeldDesktop,
  createHeldDraftStore,
  createHeldFetch,
  mockClock,
  rightToday
} from "./_m4-matrix.mjs";
import { cloneState } from "../core/document/clone.ts";
import { autoSavePolicy, unsavedChanges } from "../legacy/save-bridge.ts";
import { serverStatus } from "../legacy/location-bridge.ts";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { draftResume } = await import("../legacy/recovery-bridge.ts");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { pushSnapshot, restoreSnapshotFromCard } = await import("../js/03-sync.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow, setAutoSaveEnabled } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { buildSplitpageFile } = await import("../js/20d-formats.js");
const { openProjectFile } = await import("../js/18-local-files.js");
const { startNewScript } = await import("../js/18b-file-menu.js");
const { applyTakenDraft, armBrowserServerDraft, flushDraftNow, offerBrowserDraftAfterLinkOff } = await import("../js/20g-drafts.js");
const { DRAFT_LIMITS, browserDraftKey, createIdbDraftStore, draftBaseOf } = await import("../adapters/storage/draft-store-idb.ts");
const openDraftStore = (ports) => createIdbDraftStore(Object.assign({ limits: DRAFT_LIMITS, now: () => Date.now() }, ports));
const { bytesForSync, createMemoryBackend, ensureBytes, has, internDataUrl, isDurableSync, persist, setBackend: setBlobBackend } = await import("../adapters/storage/02c-blobs.js");
const { addGalleryPicture } = await import("../core/document/gallery.ts");
const homeModule = await import("../legacy/location-bridge.ts");
const { loadTestDocument } = await import("./_document.mjs");

const require = createRequire(import.meta.url);
const { createDraftStore } = require("../../desktop/drafts.js");

after(closeApp);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const OTHER = "another-tab";
const LOCK_PREFIX = "splitpage-draft-writer-";
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

function serverDocument(serverId, title, docLetter) {
  useDocument(script(title, { docId: idOf(docLetter) }));
  window.__hostedTest.setSession({ docId: serverId, rev: 1 });
}

function typeInto(text) {
  currentDocument().rows[0].audioText = text;
  noteSessionEdit();
}

function draftKey(serverId) {
  return browserDraftKey(draftBaseOf("", location.href), serverId);
}

function record(serverId, doc, writerId, extra) {
  return Object.assign({
    key: draftKey(serverId), base: draftBaseOf("", location.href), docId: serverId, rev: 1, title: doc.title,
    writerId: writerId, editSeq: 5, schema: 5, docIdWrittenOut: true,
    stateJson: JSON.stringify(doc), baseJson: JSON.stringify(doc)
  }, extra || {});
}

function browserStore(wrap) {
  document.getElementById("toast-host").textContent = "";
  const factory = new IDBFactory();
  const front = wrap ? wrap(factory) : factory;
  drafts().browser.useIndexedDB(front);
  const seed = createHeldDraftStore(openDraftStore({ indexedDB: factory }));
  return { factory: factory, front: front, store: seed.store, held: seed };
}

async function endCase() {
  confirmSavedNow();
  await flushDraftNow();
  draftResume().dropServerResume();
  window.__hostedTest.setSession({ docId: null });
  drafts().browser.useIndexedDB(new IDBFactory());
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

async function resumeBrowserDraft(serverId, outcome) {
  assert.equal(await armBrowserServerDraft(serverId), true, "the draft was taken for restoring");
  draftResume().serverResume().onDone(outcome || "server-resumed");
  await until(() => !drafts().restorePending(), "the restore settled");
}

rightToday("B1", "a late draft write for the previous document neither removes the current document's draft record nor claims its key", async (t) => {
  const clock = mockClock(t);
  const idb = browserStore();
  const blobs = createHeldBlobBackend(createMemoryBackend());
  setBlobBackend(blobs.backend);
  try {
    serverDocument("srv-a", "Document A", "a");
    addGalleryPicture(currentDocument().rows[0], internDataUrl(PNG), "a.png");
    window.__hostedTest.setSession({ docId: "srv-a", rev: 1 });
    blobs.holdOp("put");
    typeInto("Edited in A.");
    clock.tick(1500);
    await blobs.arrivedAt("put");

    const docB = script("Document B", { docId: idOf("b") });
    await idb.store.put(record("srv-b", docB, OTHER));
    serverDocument("srv-b", "Document B", "b");
    await resumeBrowserDraft("srv-b");
    assert.equal(drafts().browser.status().keyOnDisk, draftKey("srv-b"), "setup: the writer tracks document B's draft");
    assert.notEqual(await idb.store.get(draftKey("srv-b")), null, "setup: document B's draft record is stored before the late write lands");
    assert.equal(blobs.gates.parked("blob.put").length, 1, "setup: document A's write is still held");

    blobs.releaseOp("put");
    await settleIo();
    assert.notEqual(await idb.store.get(draftKey("srv-b")), null, "the current document's draft record is still stored");
    assert.equal(drafts().browser.status().keyOnDisk, draftKey("srv-b"), "the late write did not claim the writer's key from the current document");
  } finally {
    blobs.gates.releaseAll("blob.put");
    setBlobBackend(null);
    await endCase();
  }
});

rightToday("B2", "with Web Locks a live writer's draft is not taken over, and it is once that writer's lock is gone", async () => {
  const locks = createFakeLocks();
  const uninstall = locks.install();
  try {
    const idb = browserStore();
    let letGo = () => {};
    const alive = locks.request(LOCK_PREFIX + OTHER, () => new Promise((resolve) => { letGo = resolve; }));
    await pause();
    assert.equal(locks.isHeld(LOCK_PREFIX + OTHER), true, "setup: the other tab holds its writer lock");
    const doc = script("Shared", { docId: idOf("c") });
    await idb.store.put(record("srv-c", doc, OTHER));
    serverDocument("srv-c", "Shared", "c");

    assert.equal(await armBrowserServerDraft("srv-c"), false, "a live writer's draft is not taken over");
    assert.equal(draftResume().serverResume(), null, "nothing is waiting to resume");
    assert.equal(drafts().restorePending(), false);
    assert.equal((await idb.store.get(draftKey("srv-c"))).writerId, OTHER, "the draft still belongs to the other tab");

    letGo();
    await alive;
    await resumeBrowserDraft("srv-c");
    await until(async () => (await idb.store.get(draftKey("srv-c"))).writerId === drafts().browser.writerId(), "the draft was claimed");
  } finally {
    uninstall();
    await endCase();
  }
});

rightToday("B3", "without Web Locks every other writer counts as dead and its draft is taken over (D12)", () => cleanly(async () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: new Proxy(nav, {
      get: (target, prop) => (prop === "locks" ? undefined : Reflect.get(target, prop, target)),
      has: (target, prop) => (prop === "locks" ? false : Reflect.has(target, prop))
    }),
    configurable: true,
    writable: true
  });
  try {
    assert.equal(globalThis.navigator.locks, undefined, "setup: this case runs without Web Locks");
    const idb = browserStore();
    const doc = script("Shared without locks", { docId: idOf("d") });
    await idb.store.put(record("srv-d", doc, OTHER));
    serverDocument("srv-d", "Shared without locks", "d");
    await resumeBrowserDraft("srv-d");
    await until(async () => (await idb.store.get(draftKey("srv-d"))).writerId === drafts().browser.writerId(), "the draft was claimed");
    assert.equal(drafts().browser.status().keyOnDisk, draftKey("srv-d"));
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else delete globalThis.navigator;
  }
}));

async function advance(clock, ms) {
  clock.tick(ms);
  await settleIo();
}

async function quotaSetup(clock, faults) {
  setAutoSaveEnabled(false);
  let faulty = null;
  const idb = browserStore((factory) => {
    faulty = createFaultyIdbFactory(factory);
    return faulty;
  });
  serverDocument("srv-q", "Quota", "e");
  faulty.failNext(faulty.quotaError(), { mode: "readwrite", times: faults });
  return { faulty: faulty, idb: idb, attempts: () => faulty.transactions.filter((mode) => mode === "readwrite").length };
}

rightToday("B4", "quota pauses crash recovery with a notice and backs off 5, 10, 20 and 40 seconds, then writes the latest work", (t) => cleanly(async () => {
  const clock = mockClock(t);
  const { idb, attempts } = await quotaSetup(clock, 4);
  typeInto("First edit.");
  await advance(clock, 1500);
  assert.equal(attempts(), 1, "the first write was tried");
  assert.equal(toasts().filter((x) => /Crash recovery is paused — this browser's storage is full/.test(x)).length, 1, "the pause is announced once, with its reason");
  assert.equal(drafts().status().paused, true);
  typeInto("Second edit, while paused.");
  await advance(clock, 4999);
  assert.equal(attempts(), 1, "no retry before 5 seconds");
  await advance(clock, 1);
  assert.equal(attempts(), 2, "the retry came after 5 seconds");
  await advance(clock, 9999);
  assert.equal(attempts(), 2, "no retry before 10 more seconds");
  await advance(clock, 1);
  assert.equal(attempts(), 3);
  await advance(clock, 19999);
  assert.equal(attempts(), 3, "no retry before 20 more seconds");
  await advance(clock, 1);
  assert.equal(attempts(), 4);
  await advance(clock, 39999);
  assert.equal(attempts(), 4, "no retry before 40 more seconds");
  await advance(clock, 1);
  assert.equal(attempts(), 5, "the last wait was 40 seconds, and this write landed");
  assert.equal(drafts().status().paused, false, "the pause ended with the first write that landed");
  assert.equal(toasts().filter((x) => /Crash recovery is working again/.test(x)).length, 1);
  assert.equal(JSON.parse((await idb.store.get(draftKey("srv-q"))).stateJson).rows[0].audioText, "Second edit, while paused.", "the draft holds the latest work");
  assert.equal(unsavedChanges(), true, "the document stayed unsaved throughout");
}));

rightToday("B4b", "a change noted while a retry is in flight does not bring the next retry forward from its backoff", (t) => cleanly(async () => {
  const clock = mockClock(t);
  const { attempts } = await quotaSetup(clock, 3);
  typeInto("First edit.");
  await advance(clock, 1500);
  assert.equal(attempts(), 1, "setup: the first write failed");
  assert.equal(drafts().status().paused, true, "setup: crash recovery is paused after the first failure");
  clock.tick(5000);
  typeInto("Typed as the retry went out.");
  await settleIo();
  assert.equal(attempts(), 2, "setup: the retry went out and failed, so the next wait is 10 seconds");
  assert.equal(drafts().status().paused, true, "setup: crash recovery is still paused after the retry failed");
  await advance(clock, 9999);
  assert.equal(attempts(), 2, "the next retry waited its whole backoff");
}));

rightToday("B5", "unavailable storage turns browser drafts off quietly, with no retry and no notice", (t) => cleanly(async () => {
  const clock = mockClock(t);
  setAutoSaveEnabled(false);
  let opens = 0;
  browserStore(() => ({ open() { opens++; throw new Error("SecurityError"); } }));
  serverDocument("srv-u", "Unavailable", "f");
  typeInto("Typed with no storage.");
  await advance(clock, 1500);
  assert.equal(opens, 1, "storage was tried once");
  assert.equal(drafts().browser.status().off, true, "browser drafts are off");
  assert.deepEqual(toasts().filter((x) => /Crash recovery/.test(x)), [], "no notice");
  typeInto("Typed again.");
  await advance(clock, 120000);
  assert.equal(opens, 1, "storage was not tried again");
  assert.equal(unsavedChanges(), true, "the document is unaffected");
  browserStore();
  assert.equal(drafts().browser.status().off, false, "a working store turns them back on");
}));

rightToday("B6", "a corrupt draft record reads as none: nothing is resumed, offered or thrown", () => cleanly(async () => {
  const idb = browserStore();
  const doc = script("Corrupt", { docId: idOf("1") });
  await idb.store.put(record("srv-k", doc, OTHER));
  serverDocument("srv-k", "Corrupt", "1");
  await resumeBrowserDraft("srv-k");
  draftResume().dropServerResume();
  const kinds = {
    "not JSON": "{ this is not json",
    "JSON that is not a document": JSON.stringify({ title: "x" }),
    "a number": "42"
  };
  for (const [kind, stateJson] of Object.entries(kinds)) {
    await idb.store.put(record("srv-k", doc, OTHER, { stateJson: stateJson }));
    serverDocument("srv-k", "Corrupt", "1");
    assert.equal(await armBrowserServerDraft("srv-k"), false, kind + ": not resumed");
    assert.equal(draftResume().serverResume(), null, kind + ": nothing waits");
    assert.equal(drafts().restorePending(), false, kind + ": no restore is pending");
    window.__hostedTest.setSession({ docId: null });
    assert.equal(await offerBrowserDraftAfterLinkOff("srv-k"), false, kind + ": not offered after a link was turned off");
    assert.equal(currentDocument().title, "Corrupt", kind + ": the open document is untouched");
  }
  await idb.store.remove(draftKey("srv-k"));
  const raw = await new Promise((resolve, reject) => {
    const open = idb.factory.open("splitpage-drafts", 1);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise((resolve, reject) => {
    const tx = raw.transaction(["meta"], "readwrite");
    tx.objectStore("meta").put({ key: draftKey("srv-k"), base: draftBaseOf("", location.href), docId: "srv-k", writerId: OTHER, writtenAt: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  raw.close();
  serverDocument("srv-k", "Corrupt", "1");
  assert.equal(await armBrowserServerDraft("srv-k"), false, "a header with no body: not resumed");
}));

rightToday("B7", "a writer discards only the draft it wrote: a newer generation from another tab survives", (t) => cleanly(async () => {
  const clock = mockClock(t);
  setAutoSaveEnabled(false);
  const idb = browserStore();
  serverDocument("srv-g", "Generations", "2");
  typeInto("Mine, generation one.");
  await advance(clock, 1500);
  const key = draftKey("srv-g");
  assert.equal((await idb.store.get(key)).writerId, drafts().browser.writerId(), "setup: this tab wrote the draft");
  const theirs = script("Generations", { docId: idOf("2") });
  theirs.rows[0].audioText = "Theirs, generation two.";
  await idb.store.put(record("srv-g", theirs, OTHER, { editSeq: 99 }));
  const discardsBefore = drafts().status().discards;
  confirmSavedNow();
  await flushDraftNow();
  assert.equal(drafts().status().discards, discardsBefore + 1, "setup: this tab tried to discard its draft");
  const kept = await idb.store.get(key);
  assert.notEqual(kept, null, "the other tab's draft was not discarded");
  assert.equal(kept.writerId, OTHER);
  assert.equal(JSON.parse(kept.stateJson).rows[0].audioText, "Theirs, generation two.", "and it holds its own generation");
}));

rightToday("B8", "restoring a browser draft onto a server document, or an unsaved script, writes neither the server nor a file", (t) => cleanly(async () => {
  const clock = mockClock(t);
  setAutoSaveEnabled(true);
  const base = script("Restored", { docId: idOf("3") });
  const mine = cloneState(base);
  mine.rows[0].audioText = "Unsaved in the browser.";
  const theirs = cloneState(base);
  theirs.rows[1].audioText = "Changed on the server.";
  const sent = createHeldFetch({
    connection: () => "tab",
    answer: (r) => (r.method === "GET" && r.url.includes("api/docs/srv-r") ? { status: 200, body: { id: "srv-r", rev: 3, state: theirs } } : { status: 200, body: {} })
  });
  const uninstall = sent.install();
  const available = serverStatus().mode().available;
  serverStatus().recordMode({ available: true });
  try {
    const idb = browserStore();
    await idb.store.put(record("srv-r", mine, OTHER, { baseJson: JSON.stringify(base) }));
    useDocument(script("Before the server draft"));
    const { openServerDoc } = await import("../js/13-hosted.js");
    assert.equal(await openServerDoc("srv-r"), true);
    assert.equal(currentDocument().rows[0].audioText, "Unsaved in the browser.", "the draft was resumed");
    assert.equal(currentDocument().rows[1].audioText, "Changed on the server.");
    assert.equal(unsavedChanges(), true, "the resumed work is unsaved");
    await advance(clock, 40000);
    assert.deepEqual(sent.requests.filter((r) => r.method !== "GET").map((r) => r.method + " " + r.url), [], "nothing was written to the server");

    useDocument(script("Before the untitled draft"));
    const outcome = await applyTakenDraft({ header: { origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: JSON.stringify(mine) });
    assert.equal(outcome, "applied");
    assert.equal(currentDocument().rows[0].audioText, "Unsaved in the browser.", "the recovered work is on screen");
    assert.equal(unsavedChanges(), true, "and unsaved");
    await advance(clock, 40000);
    assert.deepEqual(sent.requests.filter((r) => r.method !== "GET").map((r) => r.method + " " + r.url), [], "still nothing written");
    assert.equal(homeModule.currentHome().kind, "none", "no file or server destination was set");
    assert.equal(autoSavePolicy().pending(), false, "no autosave is armed");
  } finally {
    serverStatus().recordMode({ available: available });
    uninstall();
  }
}));

rightToday("B9", "a revoked link keeps the draft as an unsaved local copy and sends no write to the server", async (t) => {
  mockClock(t);
  const sent = createHeldFetch({
    connection: () => "tab",
    answer: (r) => (r.method === "GET" && r.url.includes("api/docs/srv-gone") ? { status: 404, body: { error: "not-found" } } : { status: 200, body: {} })
  });
  const uninstall = sent.install();
  try {
    const idb = browserStore();
    const doc = script("Unsaved work on a revoked link", { docId: idOf("5") });
    doc.rows[0].audioText = "Kept for the user.";
    await idb.store.put(record("srv-gone", doc, OTHER));
    useDocument(script("Open elsewhere", { docId: idOf("6") }));
    const { openServerDoc } = await import("../js/13-hosted.js");
    window.__hostedTest.setSession({ docId: null });
    assert.equal(await openServerDoc("srv-gone"), false);
    await until(() => !drafts().restorePending(), "the restore settled");
    assert.equal(currentDocument().rows[0].audioText, "Kept for the user.", "the draft's work is open");
    assert.equal(unsavedChanges(), true, "as unsaved work");
    assert.equal(homeModule.currentHome().kind, "none", "with no server destination");
    assert.notEqual(currentDocument().docId, idOf("5"), "and its own new identity");
    assert.deepEqual(sent.requests.filter((r) => r.method !== "GET").map((r) => r.method + " " + r.url), [], "no write went to the server");
    assert.ok(toasts().some((x) => /unsaved copy/.test(x)), "the user is told it is an unsaved copy");
  } finally {
    uninstall();
    await endCase();
  }
});

rightToday("B10", "a draft whose pictures could not be persisted carries them inline and restores with them", async (t) => {
  const clock = mockClock(t);
  const idb = browserStore();
  const failing = createMemoryBackend();
  failing.put = () => Promise.reject(new Error("blob store full"));
  setBlobBackend(failing);
  const consoles = [...new Set([window.console, globalThis.console])];
  const warns = consoles.map((c) => c.warn);
  consoles.forEach((c) => { c.warn = () => {}; });
  try {
    serverDocument("srv-p", "Pictures", "7");
    const rec = internDataUrl(PNG);
    addGalleryPicture(currentDocument().rows[0], rec, "p.png");
    window.__hostedTest.setSession({ docId: "srv-p", rev: 1 });
    typeInto("With a picture.");
    await advance(clock, 1500);
    const stored = await idb.store.get(draftKey("srv-p"));
    assert.notEqual(stored, null, "the draft was written all the same");
    assert.match(stored.stateJson, /data:image\/png;base64,/, "the picture's bytes travel inside the draft");
    const restored = migrateRows(JSON.parse(stored.stateJson));
    const slot = restored.rows[0].imageRef;
    assert.equal(slot && slot.sha256, rec.sha256, "restoring gives the same picture back");
  } finally {
    consoles.forEach((c, i) => { c.warn = warns[i]; });
    setBlobBackend(null);
    await endCase();
  }
});

rightToday("B10b", "a draft whose pictures are stored locally carries only their refs, and after a restart they come back from the store", async (t) => {
  const clock = mockClock(t);
  const idb = browserStore();
  const disk = Object.assign(createMemoryBackend(), { name: "disk", persistent: true });
  setBlobBackend(disk);
  try {
    serverDocument("srv-q", "Stored pictures", "8");
    const rec = internDataUrl(PNG);
    assert.deepEqual(await persist([rec.sha256]), [], "setup: the picture is stored");
    assert.equal(isDurableSync(rec.sha256), true);
    addGalleryPicture(currentDocument().rows[0], rec, "q.png");
    window.__hostedTest.setSession({ docId: "srv-q", rev: 1 });
    typeInto("With a stored picture.");
    await advance(clock, 1500);
    const stored = await idb.store.get(draftKey("srv-q"));
    assert.notEqual(stored, null, "the draft was written");
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
  await openProjectFile(splitpageFile(doc), null, { skipSnapshot: true, silent: true });
  confirmSavedNow();
  const point = cloneState(currentDocument());
  point.rows[0].audioText = "As it was.";
  const ticket = pushSnapshot("A point to go back to", point);
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
    await openProjectFile(splitpageFile(doc), null, { skipSnapshot: true, silent: true });
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
    await openProjectFile(splitpageFile(other), null, { skipSnapshot: true, silent: true });
    confirmSavedNow();
  });
  assert.equal(outcome, "changed");
  assert.equal(currentDocument().title, "Another script", "the other document is untouched");
  assert.equal(currentDocument().rows[0].audioText, "One.");
  assert.ok(toasts().some((x) => /A different document was opened while restoring, so nothing was restored/.test(x)), "the user is told nothing was restored");
});

rightToday("H2", "a snapshot holds the document as it was when pushSnapshot was called", async () => {
  useDocument(script("Before the snapshot", { docId: idOf("d") }));
  const ticket = pushSnapshot("Before the edit");
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
