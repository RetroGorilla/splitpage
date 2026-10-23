import { bootApp, closeApp, rewireRunningApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import {
  createHeldDesktop,
  createHeldFetch,
  createHeldFileHandle,
  firstWriteBeforeAdoption,
  mockClock,
  rightToday,
  traceFields
} from "./_m4-matrix.mjs";
import { cloneState } from "../core/document/clone.ts";
import { autoSavePolicy, unsavedChanges } from "../legacy/save-bridge.ts";
import { documentLocation, serverStatus } from "../legacy/location-bridge.ts";

const { currentDocument, liveSession, mergeBase, onDocumentReplaced, requestRefresh, runCommand, sessionStamps, sessionStarted } = await import("../legacy/session-bridge.ts");

const session = liveSession();
const probe = { epoch: () => (sessionStarted() ? session.epoch() : null), held: () => (sessionStarted() ? session.read((doc) => doc) : null) };
const TRACED = ["docIdWrittenOut"];
const tracing = new Set();

let unfollow = null;

function noteHeld() {
  for (const events of tracing) {
    events.push({ field: "state", value: currentDocument() === null ? null : "object", epoch: probe.epoch(), sessionHolds: probe.held() === currentDocument() });
  }
}

function followAbsorbs() {
  if (unfollow) unfollow();
  unfollow = sessionStarted() ? session.subscribe((change) => { if (change.kind === "server" || change.kind === "recovery") noteHeld(); }) : null;
}

onDocumentReplaced(function () {
  noteHeld();
  followAbsorbs();
});

function traceDocument() {
  const trace = traceFields(S, TRACED, probe);
  followAbsorbs();
  tracing.add(trace.events);
  return { events: trace.events, stop: () => { tracing.delete(trace.events); trace.stop(); } };
}

const bootTrace = traceDocument();
await bootApp();
bootTrace.stop();

const { LONG_DEMO } = await import("../js/_starters.js");
const { migrateRows } = await import("../js/02-state.js");
const { draftResume } = await import("../legacy/recovery-bridge.ts");
const { adoptRestoredState, migrateDocument, standaloneHtmlFor } = await import("../js/02b-doc-id.js");
const { restoreSnapshotFromCard } = await import("../js/03-sync.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow, saveDoc, setAutoSaveEnabled } = await import("../legacy/save-bridge.ts");
const { flushEdits } = await import("../js/12a-undo.js");
const { exportMetaLine, toMarkdownDoc } = await import("../adapters/formats/export-text.ts");
const { captureExportDocument, exportDocumentOf } = await import("../js/14b-export-kit.js");
const { exportFacts } = await import("../adapters/formats/export-kit.ts");
const { buildMarkdownProject, buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { PERSON_COLORS } = await import("../core/document/person-colors.ts");
const { preferences } = await import("../legacy/preferences-bridge.ts");
const { saveAuthorName } = await import("../js/10-comments.js");
const { sceneStatusCommand } = await import("../application/commands/scene-status.ts");
const { startNewScript } = await import("../js/18b-file-menu.js");
const { parseProjectFileState } = await import("../adapters/formats/project-file.ts");
const { finishServerDetect, publishToServer } = await import("../js/13-hosted.js");
const { SERVER_RESUME_KEY } = await import("../application/location/server-status.ts");
const homeModule = await import("../legacy/location-bridge.ts");
const { setHome } = homeModule;
const { applyTakenDraft } = await import("../js/20g-drafts.js");
const { DRAFT_LIMITS, browserDraftKey, createIdbDraftStore, draftBaseOf } = await import("../adapters/storage/draft-store-idb.ts");
const openDraftStore = (ports) => createIdbDraftStore(Object.assign({ limits: DRAFT_LIMITS, now: () => Date.now() }, ports));
const { makeDesktopHandle } = await import("../adapters/desktop/desktop-handle.ts");
const { grantVideoFile, hasSessionVideo, sessionVideoUrl } = await import("../js/06-rows.js");
const { normalizeVideoLink } = await import("../core/document/gallery.ts");

after(closeApp);

const { runIdleRefresh } = await import("../js/07-production-tags.js");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument, keepSnapshot } = await import("../legacy/transition-bridge.ts");
const refreshed = { into: null };
await rewireRunningApp({ refresh: (due) => (refreshed.into ? refreshed.into.push(...due) : runIdleRefresh(due)) });

async function traced(run) {
  const trace = traceDocument();
  try {
    await run();
  } finally {
    trace.stop();
  }
  return trace.events;
}

function assertAdoptedAtOnce(events, epochBefore) {
  assert.ok(events.some((e) => e.field === "state" && e.value !== null), "a document was assigned");
  assert.ok(session.epoch() > epochBefore, "the session opened a new epoch");
  const late = firstWriteBeforeAdoption(events, "state");
  assert.equal(late, null, "the session already held the document at every write that follows its assignment: " + JSON.stringify(late));
}

function script(title, extra) {
  return migrateRows(Object.assign({
    schema: 5, title: title, docId: "d" + "4".repeat(32),
    rows: [
      { id: "r1", visualText: "Wide", audioText: "One.", status: "todo" },
      { id: "r2", visualText: "Close", audioText: "Two.", status: "todo" }
    ]
  }, extra || {}));
}

function splitpageFile(doc, name) {
  return new File([buildSplitpageFile(exportDocumentOf(doc))], name || "m4.splitpage", { lastModified: 1 });
}

function demo() {
  return migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state)));
}

function useDocument(doc) {
  loadTestDocument(doc);
  flushEdits();
  confirmSavedNow();
  return doc;
}

function mutateLive() {
  const s = currentDocument();
  s.title = "A different title";
  s.wordsPerMinute = 90;
  s.targetSeconds = 61;
  s.rows.forEach((row, i) => {
    row.audioText = "Changed audio " + i + ". " + row.audioText;
    row.status = i % 2 ? "todo" : "shot";
  });
  s.rows.pop();
  s.comments.forEach((c) => { c.author = "Someone Else"; c.resolved = !c.resolved; });
  s.comments.push({ id: "c-late", rowId: s.rows[0].id, field: "audioText", author: "Late", text: "Added after capture", replies: [], resolved: false, createdAt: "2026-10-08T00:00:00.000Z" });
  s.productionTags.forEach((tag) => { tag.status = tag.status === "have" ? "needed" : "have"; });
  s.brollShots.forEach((shot) => { shot.note = "changed after capture"; shot.name = shot.name + " (edited)"; });
  s.people.forEach((p) => { p.name = p.name + " Jr"; });
}

function serializedAfterMutation(serialize) {
  return async (t) => {
    mockClock(t);
    useDocument(demo());
    const before = serialize(captureExportDocument());
    const captured = captureExportDocument();
    mutateLive();
    assert.notEqual(serialize(captureExportDocument()), before, "the mutation shows in the live bytes, so the case can tell");
    assert.equal(serialize(captured), before, "the captured document gives the captured bytes");
  };
}

const EM_DASH = String.fromCharCode(0x2014);

const htmlHead = (doc) => ({ title: (doc.title || "Untitled Script") + " " + EM_DASH + " SplitShare", description: exportMetaLine(exportFacts(doc)) });

rightToday("X1", "buildSplitpageFile gives the captured bytes after the live document changed", serializedAfterMutation((doc) => buildSplitpageFile(doc)));

rightToday("X2", "buildMarkdownProject gives the captured bytes after the live document changed", serializedAfterMutation((doc) => buildMarkdownProject(doc)));

rightToday("X3", "standaloneHtmlFor with its head gives the captured bytes after the live document changed", serializedAfterMutation((doc) => standaloneHtmlFor(doc, htmlHead(doc))));

rightToday("X4", "toMarkdownDoc gives the captured bytes after the live document changed", serializedAfterMutation((doc) => toMarkdownDoc(doc)));

rightToday("X5", "exportFacts gives the captured facts after the live document changed", serializedAfterMutation((doc) => JSON.stringify(exportFacts(doc))));

function undeclaredChanges(before, after, changes) {
  const out = [];
  const keys = new Set(Object.keys(before).concat(Object.keys(after)));
  keys.forEach((key) => {
    if (key === "rows") return;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]) && !changes.docFields.includes(key)) out.push(key);
  });
  const rowsBefore = new Map(before.rows.map((r) => [r.id, r]));
  after.rows.forEach((row) => {
    const was = rowsBefore.get(row.id);
    if (!was) return;
    new Set(Object.keys(was).concat(Object.keys(row))).forEach((field) => {
      if (JSON.stringify(was[field]) !== JSON.stringify(row[field]) && !changes.cells.some((c) => c.rowId === row.id && c.field === field)) {
        out.push("row " + row.id + " " + field);
      }
    });
  });
  return out;
}

function namedEditor() {
  saveAuthorName("Sam Ortega");
  preferences().setMyColor(PERSON_COLORS[0]);
}

function committedPrecondition() {
  namedEditor();
  useDocument(demo());
  const row = currentDocument().rows[0];
  return { row: row, before: row.status };
}

const COMMITTED = ["applied", "noop", "rejected", "failed"];

function assertReportedAfterCommit(inject, message) {
  return () => {
    const { row, before } = committedPrecondition();
    const restore = inject();
    const reported = [];
    const consoleError = console.error;
    console.error = (error) => { reported.push(error); };
    let outcome = null;
    let thrown = null;
    try {
      outcome = runCommand(sceneStatusCommand(row.id, sessionStamps));
    } catch (error) {
      thrown = error;
    } finally {
      console.error = consoleError;
      restore();
      flushEdits();
    }
    assert.notEqual(row.status, before, "the committed change stays in the document");
    assert.equal(thrown, null, "a throw after the commit does not escape the command: " + (thrown && thrown.message));
    assert.ok(outcome && !COMMITTED.includes(outcome.kind), "a distinct outcome, got " + JSON.stringify(outcome && outcome.kind));
    assert.equal(unsavedChanges(), true, "the document stays marked unsaved");
    assert.deepEqual(reported.map((e) => e && e.message), [message], "the error reaches the existing error reporting");
  };
}

rightToday("E1", "a command's effect pass writes no document content that its change set does not declare", () => {
  const { row } = committedPrecondition();
  const before = JSON.parse(JSON.stringify(currentDocument()));
  const outcome = runCommand(sceneStatusCommand(row.id, sessionStamps));
  assert.equal(outcome.kind, "applied", "the command applied");
  const undeclared = undeclaredChanges(before, JSON.parse(JSON.stringify(currentDocument())), outcome.changes);
  assert.deepEqual(undeclared, [], "undeclared document changes after the effect pass: " + JSON.stringify(undeclared));
  assert.equal(before.personColors && before.personColors["Sam Ortega"], undefined, "the document had no colour for the editor");
  assert.equal(currentDocument().personColors["Sam Ortega"], PERSON_COLORS[0], "the editor's colour was written");
  assert.ok(outcome.changes.docFields.includes("personColors"), "the change set declares the colour");
});

rightToday("E2a", "a throw in undo recording after a commit gives a distinct reported outcome and keeps the document", assertReportedAfterCommit(() => {
  const resolve = Promise.resolve;
  Promise.resolve = function () { throw new Error("undo recording failed"); };
  return () => { Promise.resolve = resolve; };
}, "undo recording failed"));

rightToday("E2b", "a throw in an effect after a commit gives a distinct reported outcome and keeps the document", assertReportedAfterCommit(() => {
  const start = globalThis.setTimeout;
  globalThis.setTimeout = function () { throw new Error("effect failed"); };
  return () => { globalThis.setTimeout = start; };
}, "effect failed"));

rightToday("E2c", "a throw in a session listener after a commit gives a distinct reported outcome and keeps the document", assertReportedAfterCommit(() => {
  const off = session.subscribe(() => { throw new Error("listener failed"); });
  return off;
}, "listener failed"));

function serverFetch(answerFor) {
  const held = createHeldFetch({
    connection: () => "tab",
    answer: (r) => {
      const found = answerFor(r);
      return found || { status: 200, body: {} };
    }
  });
  return held;
}

rightToday("T2a", "a new document opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("Before new"));
  const epoch = session.epoch();
  const events = await traced(() => startNewScript());
  assertAdoptedAtOnce(events, epoch);
});

rightToday("T2a-tab", "a new tab's blank document opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("Before new tab"));
  const epoch = session.epoch();
  const events = await traced(async () => {
    document.querySelector('#newtab-page [data-newtab-action="new"]').click();
    for (let turn = 0; turn < 50 && session.epoch() === epoch; turn++) await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(currentDocument().title, "Untitled Script");
  assertAdoptedAtOnce(events, epoch);
});

rightToday("T2a-boot", "the boot document opens its epoch at the transition, not at the next render", () => {
  assert.ok(bootTrace.events.some((e) => e.field === "state" && e.value !== null), "the boot assigned a document");
  const late = firstWriteBeforeAdoption(bootTrace.events, "state");
  assert.equal(late, null, "the session already held the boot document at every write that follows its assignment: " + JSON.stringify(late));
});

rightToday("T2b", "an opened file opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("Before open"));
  const epoch = session.epoch();
  const events = await traced(() => openDocument({ kind: "file", file: splitpageFile(script("Opened", { docId: "d" + "5".repeat(32) })), handle: null, options: { skipSnapshot: true, silent: true } }));
  assertAdoptedAtOnce(events, epoch);
});

rightToday("T2c-open", "a server document opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("Before server"));
  const served = script("From the server", { docId: "d" + "6".repeat(32) });
  const held = serverFetch((r) => (r.method === "GET" && r.url.includes("api/docs/server-b") ? { status: 200, body: { id: "server-b", rev: 3, state: served } } : null));
  const uninstall = held.install();
  try {
    const epoch = session.epoch();
    const events = await traced(async () => { assert.equal(await openDocument({ kind: "server", id: "server-b" }), true); });
    assertAdoptedAtOnce(events, epoch);
  } finally {
    uninstall();
  }
});

rightToday("T2c-resume", "a resumed server draft opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("Before resume"));
  const docId = "d" + "c".repeat(32);
  const base = script("Server draft", { docId: docId });
  const mine = cloneState(base);
  mine.rows[0].audioText = "Unsaved in the browser.";
  const theirs = cloneState(base);
  theirs.rows[1].audioText = "Changed on the server.";
  const store = openDraftStore({ indexedDB: window.indexedDB });
  const key = browserDraftKey(draftBaseOf("", location.href), "server-r");
  assert.deepEqual(await store.put({
    key: key, base: draftBaseOf("", location.href), docId: "server-r", rev: 2, title: "Server draft", writerId: "another-tab",
    editSeq: 1, schema: 5, docIdWrittenOut: true, stateJson: JSON.stringify(mine), baseJson: JSON.stringify(base)
  }), { ok: true, evicted: 0 });
  const held = serverFetch((r) => (r.method === "GET" && r.url.includes("api/docs/server-r") ? { status: 200, body: { id: "server-r", rev: 3, state: theirs } } : null));
  const uninstall = held.install();
  const available = serverStatus().mode().available;
  serverStatus().recordMode({ available: true });
  try {
    const epoch = session.epoch();
    const events = await traced(async () => { assert.equal(await openDocument({ kind: "server", id: "server-r" }), true); });
    assert.equal(currentDocument().rows[0].audioText, "Unsaved in the browser.", "the draft was resumed");
    assert.equal(currentDocument().rows[1].audioText, "Changed on the server.");
    assertAdoptedAtOnce(events, epoch);
  } finally {
    serverStatus().recordMode({ available: available });
    uninstall();
    await store.remove(key, "another-tab");
    setHome("none");
  }
});

rightToday("T2c-resume-switch", "a late server resume leaves a document opened during its fetch in place", async (t) => {
  mockClock(t);
  useDocument(script("Before late resume"));
  const base = script("Late server draft", { docId: "d" + "e".repeat(32) });
  const mine = cloneState(base);
  mine.rows[0].audioText = "Recovered browser edits.";
  const store = openDraftStore({ indexedDB: window.indexedDB });
  const key = browserDraftKey(draftBaseOf("", location.href), "server-late-resume");
  assert.deepEqual(await store.put({
    key: key, base: draftBaseOf("", location.href), docId: "server-late-resume", rev: 2, title: base.title, writerId: "another-tab",
    editSeq: 1, schema: 5, docIdWrittenOut: true, stateJson: JSON.stringify(mine), baseJson: JSON.stringify(base)
  }), { ok: true, evicted: 0 });
  const held = serverFetch((r) => (r.method === "GET" && r.url.includes("api/docs/server-late-resume")
    ? { status: 200, body: { id: "server-late-resume", rev: 3, state: base } } : null));
  held.holdWhen((r) => r.method === "GET" && r.url.includes("api/docs/server-late-resume"));
  const uninstall = held.install();
  const available = serverStatus().mode().available;
  serverStatus().recordMode({ available: true });
  let resuming;
  try {
    resuming = openDocument({ kind: "server", id: "server-late-resume" });
    await held.gates.arrived("fetch");
    assert.equal(draftResume().serverResume().id, "server-late-resume", "setup: the held fetch belongs to a server draft resume");
    const connection = homeModule.currentConn();
    const replacement = script("Opened during resume", { docId: "d" + "f".repeat(32) });
    const file = splitpageFile(replacement, "opened-during-resume.splitpage");
    const target = createHeldFileHandle({ name: file.name });
    await openDocument({ kind: "file", file: file, handle: target.handle, options: { skipSnapshot: true, silent: true } });
    assert.equal(currentDocument().title, replacement.title, "setup: the replacement document opened while the resume fetch was held");
    assert.equal(homeModule.currentConn(), connection, "setup: opening the file kept the same connection");
    const opened = JSON.stringify(currentDocument());
    const baseline = JSON.stringify(mergeBase());
    const destination = homeModule.currentHome();
    const epoch = session.epoch();
    held.gates.release("fetch");
    await resuming;
    assert.equal(currentDocument().title, replacement.title, "late server resume must leave the newly opened document in place");
    assert.equal(JSON.stringify(currentDocument()), opened, "the opened document's contents and identity are unchanged");
    assert.equal(session.epoch(), epoch, "the opened document's session is unchanged");
    assert.equal(JSON.stringify(mergeBase()), baseline, "the opened document's baseline is unchanged");
    assert.equal(unsavedChanges(), false, "the opened document stays clean");
    assert.equal(homeModule.currentHome(), destination, "the opened document keeps its file destination");
    assert.equal(target.commits.length, 0, "the resume writes nothing to the opened file");
    assert.deepEqual(held.requests.map((r) => r.method), ["GET"], "the resume sends no server write");
  } finally {
    held.gates.releaseAll("fetch");
    if (resuming) await resuming;
    serverStatus().recordMode({ available: available });
    uninstall();
    await store.remove(key, "another-tab");
    setHome("none");
  }
});

rightToday("T2c-reopen", "a server document reopened after a sign-in opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("Before reopen"));
  const served = script("Reopened from the server", { docId: "d" + "d".repeat(32) });
  const held = serverFetch((r) => {
    if (r.method !== "GET") return null;
    if (r.url.includes("api/docs/server-r2")) return { status: 200, body: { id: "server-r2", rev: 4, state: served } };
    return { status: 200, body: { role: "edit", scope: "" } };
  });
  const uninstall = held.install();
  sessionStorage.setItem(SERVER_RESUME_KEY, JSON.stringify({ id: "server-r2", rev: 0 }));
  try {
    const epoch = session.epoch();
    const events = await traced(async () => {
      await finishServerDetect();
      for (let turn = 0; turn < 200 && currentDocument().title !== "Reopened from the server"; turn++) await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(currentDocument().title, "Reopened from the server", "the document was reopened");
    assertAdoptedAtOnce(events, epoch);
  } finally {
    uninstall();
    sessionStorage.removeItem(SERVER_RESUME_KEY);
    setHome("none");
  }
});

rightToday("T2c-reopen-switch", "a late sign-in resume leaves a document opened during its fetch in place and keeps the stash", async (t) => {
  mockClock(t);
  useDocument(script("Before sign-in resume"));
  const served = script("Late signed-in server copy", { docId: "d" + "c".repeat(32) });
  const mine = cloneState(served);
  mine.rows[0].audioText = "Typed before signing in.";
  const stash = JSON.stringify({ at: new Date().toISOString(), by: "", base: served, mine: mine });
  const held = serverFetch((r) => {
    if (r.method !== "GET") return null;
    if (r.url.includes("api/docs/server-r3")) return { status: 200, body: { id: "server-r3", rev: 5, state: served } };
    return { status: 200, body: { role: "edit", scope: "" } };
  });
  held.holdWhen((r) => r.method === "GET" && r.url.includes("api/docs/server-r3"));
  const uninstall = held.install();
  sessionStorage.setItem(SERVER_RESUME_KEY, JSON.stringify({ id: "server-r3", rev: 4 }));
  sessionStorage.setItem("splitpage-conflict-stash", stash);
  try {
    const detecting = finishServerDetect();
    await held.gates.arrived("fetch");
    const connection = homeModule.currentConn();
    const replacement = script("Opened during sign-in resume", { docId: "d" + "b".repeat(32) });
    const file = splitpageFile(replacement, "opened-during-sign-in.splitpage");
    const target = createHeldFileHandle({ name: file.name });
    await openDocument({ kind: "file", file: file, handle: target.handle, options: { skipSnapshot: true, silent: true } });
    assert.equal(currentDocument().title, replacement.title, "setup: the replacement document opened while the resume fetch was held");
    assert.equal(homeModule.currentConn(), connection, "setup: opening the file kept the same connection");
    const opened = JSON.stringify(currentDocument());
    const baseline = JSON.stringify(mergeBase());
    const destination = homeModule.currentHome();
    const epoch = session.epoch();
    held.gates.release("fetch");
    await detecting;
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(currentDocument().title, replacement.title, "late sign-in resume must leave the newly opened document in place");
    assert.equal(JSON.stringify(currentDocument()), opened, "the opened document's contents and identity are unchanged");
    assert.equal(session.epoch(), epoch, "the opened document's session is unchanged");
    assert.equal(JSON.stringify(mergeBase()), baseline, "the opened document's baseline is unchanged");
    assert.equal(unsavedChanges(), false, "the opened document stays clean");
    assert.equal(homeModule.currentHome(), destination, "the opened document keeps its file destination");
    assert.equal(target.commits.length, 0, "the resume writes nothing to the opened file");
    assert.equal(held.requests.filter((r) => r.method !== "GET").length, 0, "the resume sends no server write");
    assert.equal(sessionStorage.getItem("splitpage-conflict-stash"), stash, "the edits typed before signing in are kept");
  } finally {
    held.gates.releaseAll("fetch");
    uninstall();
    sessionStorage.removeItem(SERVER_RESUME_KEY);
    sessionStorage.removeItem("splitpage-conflict-stash");
    setHome("none");
  }
});

rightToday("T2c-reopen-stale", "a sign-in resume dropped for a newly opened document does not come back over it at a later sign-in", async (t) => {
  mockClock(t);
  useDocument(script("Before stale sign-in resume"));
  const served = script("Stale signed-in server copy", { docId: "d" + "a".repeat(32) });
  const mine = cloneState(served);
  mine.rows[0].audioText = "Typed before the dropped sign-in.";
  const stash = JSON.stringify({ at: new Date().toISOString(), by: "", base: served, mine: mine });
  const pending = JSON.stringify({ id: "server-r4", rev: 4 });
  const held = serverFetch((r) => {
    if (r.method !== "GET") return null;
    if (r.url.includes("api/docs/server-r4")) return { status: 200, body: { id: "server-r4", rev: 5, state: served } };
    return { status: 200, body: { role: "edit", scope: "" } };
  });
  held.holdWhen((r) => r.method === "GET" && r.url.includes("api/docs/server-r4"));
  const uninstall = held.install();
  sessionStorage.setItem(SERVER_RESUME_KEY, pending);
  sessionStorage.setItem("splitpage-conflict-stash", stash);
  try {
    const detecting = finishServerDetect();
    await held.gates.arrived("fetch");
    const replacement = script("Opened during the dropped sign-in resume", { docId: "d" + "9".repeat(32) });
    const file = splitpageFile(replacement, "opened-during-dropped-sign-in.splitpage");
    const target = createHeldFileHandle({ name: file.name });
    await openDocument({ kind: "file", file: file, handle: target.handle, options: { skipSnapshot: true, silent: true } });
    held.gates.release("fetch");
    await detecting;
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(currentDocument().title, replacement.title, "setup: the first resume was dropped for the newly opened document");
    assert.equal(sessionStorage.getItem(SERVER_RESUME_KEY), pending, "setup: the dropped resume kept its key");
    const opened = JSON.stringify(currentDocument());
    const baseline = JSON.stringify(mergeBase());
    const destination = homeModule.currentHome();
    const epoch = session.epoch();
    await finishServerDetect();
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(currentDocument().title, replacement.title, "a later sign-in must not resume the server document over the opened one");
    assert.equal(JSON.stringify(currentDocument()), opened, "the opened document's contents and identity are unchanged");
    assert.equal(session.epoch(), epoch, "the opened document's session is unchanged");
    assert.equal(JSON.stringify(mergeBase()), baseline, "the opened document's baseline is unchanged");
    assert.equal(unsavedChanges(), false, "the opened document stays clean");
    assert.equal(homeModule.currentHome(), destination, "the opened document keeps its file destination");
    assert.equal(target.commits.length, 0, "nothing is written to the opened file");
    assert.equal(held.requests.filter((r) => r.method !== "GET").length, 0, "no server write is sent");
    assert.equal(sessionStorage.getItem(SERVER_RESUME_KEY), pending, "the key stays for the next page load");
    assert.equal(sessionStorage.getItem("splitpage-conflict-stash"), stash, "the edits typed before signing in are kept");
  } finally {
    held.gates.releaseAll("fetch");
    uninstall();
    sessionStorage.removeItem(SERVER_RESUME_KEY);
    sessionStorage.removeItem("splitpage-conflict-stash");
    setHome("none");
  }
});

rightToday("T2d", "a restored draft opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("Before draft"));
  const epoch = session.epoch();
  const draft = script("Draft", { docId: "d" + "7".repeat(32) });
  const events = await traced(async () => {
    const outcome = await applyTakenDraft({ header: { origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: JSON.stringify(draft) });
    assert.equal(outcome, "applied");
  });
  assertAdoptedAtOnce(events, epoch);
});

rightToday("T2e", "a restored history version opens its epoch at the transition, not at the next render", async () => {
  useDocument(script("History"));
  const point = cloneState(currentDocument());
  point.rows[0].audioText = "As it was.";
  const ticket = keepSnapshot("A point to go back to", point);
  await ticket.done;
  const button = document.createElement("button");
  button.setAttribute("data-id", ticket.id);
  const epoch = session.epoch();
  const events = await traced(async () => { assert.equal(await restoreSnapshotFromCard(button), "restored"); });
  assertAdoptedAtOnce(events, epoch);
});

function withHeldDesktop() {
  const fake = window.__desktopTest.makeFakeBackend();
  const held = createHeldDesktop(fake);
  window.__desktopTest.setBackend(held.desktop);
  return { fake: fake, held: held, restore: () => window.__desktopTest.restoreBackend() };
}

rightToday("T1", "Save As, publish and detached recovery fork the id; open, restore and a same-id reopen keep it", async () => {
  const idOf = (letter) => "d" + letter.repeat(32);

  useDocument(script("Fork by Save As", { docId: idOf("1") }));
  documentLocation().markWrittenOut(true);
  const target = createHeldFileHandle({ name: "forked.md" });
  window.showSaveFilePicker = async () => target.handle;
  try {
    await saveDoc({ saveAs: true });
  } finally {
    delete window.showSaveFilePicker;
    setHome("none");
  }
  assert.notEqual(currentDocument().docId, idOf("1"), "Save As gave the copy a new id");
  assert.match(currentDocument().docId, /^d[0-9a-f]{32}$/);
  assert.equal(target.commits.length, 1, "the copy was written once");
  assert.ok(target.text().includes(currentDocument().docId) && !target.text().includes(idOf("1")), "the file carries the new id, not the old one");

  useDocument(script("Fork by publish", { docId: idOf("2") }));
  documentLocation().markWrittenOut(true);
  serverStatus().recordMode({ available: true, readOnly: false });
  const held = serverFetch((r) => (r.method === "POST" && r.url.endsWith("api/docs") ? { status: 200, body: { id: "srv-1", rev: 1 } } : null));
  const uninstall = held.install();
  try {
    assert.equal(await publishToServer(), true);
  } finally {
    uninstall();
    setHome("none");
  }
  assert.notEqual(currentDocument().docId, idOf("2"), "publishing gave the copy a new id");
  assert.equal(held.matching("POST", "api/docs")[0].body.state.docId, currentDocument().docId, "the server was sent the new id");

  useDocument(script("Detached", { docId: idOf("3") }));
  const draft = script("Recovered", { docId: idOf("4") });
  await applyTakenDraft({ header: { origin: { kind: "file", fileName: "gone.splitpage" } }, stateJson: JSON.stringify(draft) });
  assert.equal(currentDocument().title, "Recovered");
  assert.notEqual(currentDocument().docId, idOf("4"), "a detached recovery got a new id");

  useDocument(script("Before open"));
  const opened = script("Opened", { docId: idOf("5") });
  await openDocument({ kind: "file", file: splitpageFile(opened), handle: null, options: { skipSnapshot: true, silent: true } });
  assert.equal(currentDocument().docId, idOf("5"), "open keeps the file's id");
  const epoch = session.epoch();
  await openDocument({ kind: "file", file: splitpageFile(opened), handle: null, options: { skipSnapshot: true, silent: true } });
  assert.equal(currentDocument().docId, idOf("5"), "a same-id reopen keeps the id");
  assert.ok(session.epoch() > epoch, "and is a new epoch all the same");

  adoptRestoredState(script("Restored", { docId: idOf("6") }));
  assert.equal(currentDocument().docId, idOf("5"), "restore keeps the open document's id");
  assert.equal(currentDocument().title, "Restored");
});

const HTML_HEAD = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>';

rightToday("T4", "opening an .html file over the parse bound keeps its script data byte for byte", async () => {
  const hostile = Array.from({ length: 60 }, (_, i) => "<b id=i" + i + ">").join("") + "<p>x".repeat(300);
  const raw = {
    schema: 5, title: "Formatted", docId: "d" + "8".repeat(32),
    rows: [
      { id: "r1", status: "todo", visualText: "", audioText: "<strong>bold</strong> and <em>italic</em>" },
      { id: "r2", status: "todo", visualText: "", audioText: hostile }
    ]
  };
  const markup = HTML_HEAD + '<script id="state-data" type="application/json">\n' + JSON.stringify(raw).replace(/<\//g, "<\\/") + "\n</script></body></html>";
  const parsed = await parseProjectFileState(new File([markup], "crafted.html", { lastModified: 1 }));
  const unbounded = new window.DOMParser().parseFromString(markup, "text/html");
  const expected = migrateDocument(JSON.parse(unbounded.getElementById("state-data").textContent), { kind: "file" });
  assert.equal(parsed.kind, "html");
  assert.equal(parsed.state.rows[0].audioText, "<strong>bold</strong> and <em>italic</em>", "the bold and italic in the script data are still there");
  assert.equal(JSON.stringify(parsed.state), JSON.stringify(expected), "the opened state equals an unbounded parse of the same file");
});


async function withRestoredFileDraft(variant, run) {
  const docId = "d" + "9".repeat(32);
  const original = script("On disk", { docId: docId });
  const mine = cloneState(original);
  mine.rows[0].audioText = "Unsaved here.";
  const disk = cloneState(original);
  if (variant === "changed") disk.rows[1].audioText = "Changed on disk.";
  const { fake, held, restore } = withHeldDesktop();
  try {
    const picked = await fake.saveFileDialog({ suggestedName: "disk.splitpage" });
    await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(disk))));
    const outcome = await applyTakenDraft({
      header: { origin: { kind: "file", fileName: picked.name }, docIdWrittenOut: true },
      file: { id: picked.id, name: picked.name },
      stateJson: JSON.stringify(mine),
      baseJson: JSON.stringify(original)
    });
    await run({
      outcome: outcome,
      disk: disk,
      fileId: picked.id,
      writes: () => held.calls.filter((c) => c.op === "writeFile"),
      onDisk: async () => new TextDecoder().decode((await fake.readFile(picked.id)).bytes)
    });
  } finally {
    restore();
  }
}

async function settleSaves(clock) {
  clock.tick(40000);
  for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
}

rightToday("T5", "restoring a draft onto an unchanged file schedules no save and leaves the confirmed baseline as it was", async (t) => {
  const clock = mockClock(t);
  setAutoSaveEnabled(true);
  useDocument(script("Before restore"));
  await withRestoredFileDraft("unchanged", async (restored) => {
    assert.equal(restored.outcome, "applied");
    assert.equal(currentDocument().rows[0].audioText, "Unsaved here.", "the restored text is on screen");
    const fileBefore = await restored.onDisk();
    const baselineBefore = JSON.stringify(mergeBase());
    assert.equal(mergeBase().rows[0].audioText, restored.disk.rows[0].audioText, "the baseline is the file's own content");
    await settleSaves(clock);
    assert.equal(restored.writes().length, 0, "nothing was written to the file after the restore");
    assert.equal(await restored.onDisk(), fileBefore, "the file holds what it held");
    assert.equal(JSON.stringify(mergeBase()), baselineBefore, "the baseline did not move");
    assert.equal(unsavedChanges(), true, "the recovered work is still unsaved");
    assert.equal(homeModule.currentHome().kind, "file", "the destination is still the file");
    assert.equal(homeModule.currentHome().handle._desktopId, restored.fileId, "and it is the same file");
  });
});

rightToday("T5-merge", "restoring a draft onto a changed file merges, halts autosave and leaves the file and baseline as they were", async (t) => {
  const clock = mockClock(t);
  setAutoSaveEnabled(true);
  useDocument(script("Before merge restore"));
  await withRestoredFileDraft("changed", async (restored) => {
    assert.equal(restored.outcome, "merged");
    assert.equal(currentDocument().rows[0].audioText, "Unsaved here.");
    assert.equal(currentDocument().rows[1].audioText, "Changed on disk.");
    const fileBefore = await restored.onDisk();
    const baselineBefore = JSON.stringify(mergeBase());
    await settleSaves(clock);
    assert.equal(restored.writes().length, 0, "the merge did not autosave");
    assert.equal(await restored.onDisk(), fileBefore);
    assert.equal(JSON.stringify(mergeBase()), baselineBefore);
    assert.match(autoSavePolicy().halted(), /Autosave is paused/);
    assert.equal(unsavedChanges(), true, "the merged work is still unsaved");
    assert.equal(homeModule.currentHome().handle._desktopId, restored.fileId, "the destination is still the file");
  });
});

rightToday("T6", "with autosave off, nothing is scheduled after a restore or an edit", async (t) => {
  const clock = mockClock(t);
  useDocument(script("Before off"));
  setAutoSaveEnabled(false);
  try {
    await withRestoredFileDraft("unchanged", async (restored) => {
      assert.equal(restored.outcome, "applied");
      const fileBefore = await restored.onDisk();
      currentDocument().rows[1].audioText = "Typed after the restore.";
      noteSessionEdit();
      await settleSaves(clock);
      assert.equal(await restored.onDisk(), fileBefore, "the file holds what it held: no automatic write with autosave off");
      assert.equal(unsavedChanges(), true, "the work is still unsaved");
    });
  } finally {
    setAutoSaveEnabled(true);
  }
});

rightToday("L1a", "a refresh the old document asked for does not run once the document was replaced", async (t) => {
  const clock = mockClock(t);
  const jobs = [];
  refreshed.into = jobs;
  t.after(() => { refreshed.into = null; });
  useDocument(script("Old document"));
  clock.tick(5000);
  requestRefresh("m4-old-document");
  startNewScript();
  assert.equal(currentDocument().title, "Untitled Script", "the replacement happened");
  jobs.length = 0;
  clock.tick(5000);
  assert.equal(jobs.includes("m4-old-document"), false, "the old document's refresh did not run after the replacement: " + jobs.join(","));
});

rightToday("L1b", "an autosave or draft the old document armed writes nothing for itself once the document was replaced", async (t) => {
  const clock = mockClock(t);
  setAutoSaveEnabled(true);
  useDocument(script("Not this one"));
  const { fake, held, restore } = withHeldDesktop();
  try {
    const picked = await fake.saveFileDialog({ suggestedName: "old.splitpage" });
    await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(script("Old file", { docId: "d" + "a".repeat(32) })))));
    const handle = makeDesktopHandle(picked);
    await openDocument({ kind: "file", file: await handle.getFile(), handle: handle, options: { skipSnapshot: true, silent: true } });
    held.calls.length = 0;
    const fileBefore = new TextDecoder().decode((await fake.readFile(picked.id)).bytes);
    currentDocument().rows[0].audioText = "Typed in the old document.";
    noteSessionEdit();
    assert.ok(autoSavePolicy().pending(), "an autosave is armed for the old document");
    startNewScript();
    await settleSaves(clock);
    assert.equal(new TextDecoder().decode((await fake.readFile(picked.id)).bytes), fileBefore, "the old document's file holds what it held after the replacement");
    const drafted = held.calls.filter((c) => c.op === "writeDraft").map((c) => c.args[0].stateJson);
    assert.equal(drafted.filter((json) => json.includes("Typed in the old document.")).length, 0, "no draft of the old document's text was written for the replacement");
    assert.equal(currentDocument().title, "Untitled Script");
  } finally {
    restore();
  }
});

rightToday("L1d", "no subscription made for the old document survives its replacement", () => {
  useDocument(script("Subscribed"));
  const heardOld = [];
  liveSession().subscribe((change) => heardOld.push(change.kind));
  currentDocument().rows[0].audioText = "Typed in the old document.";
  noteSessionEdit();
  assert.deepEqual(heardOld, ["edit"], "setup: the subscription hears the document it was made for");
  startNewScript();
  assert.equal(currentDocument().title, "Untitled Script", "the replacement happened");
  const heardNew = [];
  liveSession().subscribe((change) => heardNew.push(change.kind));
  currentDocument().rows[0].audioText = "Typed in the replacement.";
  noteSessionEdit();
  assert.deepEqual(heardOld, ["edit"], "the old document's subscription heard nothing after the replacement");
  assert.deepEqual(heardNew, ["edit"], "a subscription made for the replacement hears it");
});

rightToday("L1c", "an object URL made for the old document's session video is revoked once the document was replaced", async () => {
  const created = [];
  const revoked = [];
  const make = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    const url = "blob:m4-matrix/" + created.length;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  try {
    useDocument(script("Has a video"));
    const link = normalizeVideoLink({ name: "clip.mp4", size: 5 });
    grantVideoFile(new File(["12345"], "clip.mp4"), link);
    assert.ok(sessionVideoUrl(link), "the video has an object URL while its document is open");
    startNewScript();
    assert.equal(currentDocument().title, "Untitled Script", "the replacement happened");
    assert.ok(hasSessionVideo(link), "the file grant survives the switch");
    assert.deepEqual(created.filter((url) => !revoked.includes(url)), [], "every object URL made for the old document is revoked");
  } finally {
    URL.createObjectURL = make;
    URL.revokeObjectURL = revoke;
  }
});
