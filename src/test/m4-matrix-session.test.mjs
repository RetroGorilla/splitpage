import { bootApp, closeApp, rewireRunningApp } from "./_app-boot.mjs";
import { after } from "node:test";
import assert from "node:assert/strict";
import {
  createHeldDesktop,
  createHeldFileHandle,
  firstWriteBeforeAdoption,
  mockClock,
  rightToday
} from "./_m4-matrix.mjs";
import { cloneState } from "../core/document/clone.ts";
import { autoSavePolicy, unsavedChanges } from "../legacy/save-bridge.ts";
import { documentLocation } from "../legacy/location-bridge.ts";

const { currentDocument, liveSession, mergeBase, onDocumentReplaced, requestRefresh, runCommand, sessionStamps, sessionStarted } = await import("../legacy/session-bridge.ts");

const session = liveSession();
const probe = { epoch: () => (sessionStarted() ? session.epoch() : null), held: () => (sessionStarted() ? session.read((doc) => doc) : null) };
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
  const events = [];
  followAbsorbs();
  tracing.add(events);
  return { events, stop: () => { tracing.delete(events); } };
}

const bootTrace = traceDocument();
await bootApp();
bootTrace.stop();

const { LONG_DEMO } = await import("../starters/index.ts");
const { migrateRows } = await import("../legacy/document-ports.ts");
const { adoptRestoredState, migrateDocument } = await import("../bootstrap/startup/document-entry.js");
const { standaloneHtmlFor } = await import("../adapters/page/standalone-html.js");
const { restoreSnapshotFromCard } = await import("../bootstrap/wiring/history-panel.ts");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow, saveDoc, setAutoSaveEnabled } = await import("../legacy/save-bridge.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { exportMetaLine, toMarkdownDoc } = await import("../adapters/formats/export-text.ts");
const { captureExportDocument, exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { exportFacts } = await import("../adapters/formats/export-kit.ts");
const { buildMarkdownProject, buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { PERSON_COLORS } = await import("../core/document/person-colors.ts");
const { preferences } = await import("../legacy/preferences-bridge.ts");

import { saveAuthorName as saveAuthorNameWith } from "../application/comment-author.js";
import { preferences as commentPreferences } from "../legacy/preferences-bridge.ts";
const flushEdits = () => undoOwner().flush();
function saveAuthorName(name) { saveAuthorNameWith(commentPreferences(), name); }
const { sceneStatusCommand } = await import("../application/commands/scene-status.ts");
const { startNewScript } = await import("../bootstrap/wiring/file-menu-controls.ts");
const { parseProjectFileState } = await import("../adapters/formats/project-file.ts");
const homeModule = await import("../legacy/location-bridge.ts");
const { setHome } = homeModule;
const { applyTakenDraft, draftTaker } = await import("../bootstrap/wiring/drafts.ts");
const { DRAFT_LIMITS, browserDraftKey, createIdbDraftStore, draftBaseOf } = await import("../adapters/storage/draft-store-idb.ts");
const openDraftStore = (ports) => createIdbDraftStore(Object.assign({ limits: DRAFT_LIMITS, now: () => Date.now() }, ports));
const { makeDesktopHandle } = await import("../adapters/desktop/desktop-handle.ts");
const { videoFiles } = await import("../bootstrap/wiring/video-files.ts");
const { grant: grantVideoFile, has: hasSessionVideo, url: sessionVideoUrl } = videoFiles;
const { normalizeVideoLink } = await import("../core/document/gallery.ts");

after(closeApp);

const { runIdleRefresh } = await import("../features/tags/production-tags.js");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument, keepSnapshot } = await import("../bootstrap/wiring/transition-owners.ts");
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

rightToday("T2c-copy", "a left-over browser draft of a server document opens as an unsaved copy whose epoch opens at the transition, not at the next render", async () => {
  useDocument(script("Before the copy"));
  const docId = "d" + "c".repeat(32);
  const base = script("Server draft", { docId: docId });
  const mine = cloneState(base);
  mine.rows[0].audioText = "Unsaved in the browser.";
  const store = openDraftStore({ indexedDB: window.indexedDB });
  const key = browserDraftKey(draftBaseOf("", location.href), "server-r");
  assert.deepEqual(await store.put({
    key: key, base: draftBaseOf("", location.href), docId: "server-r", rev: 2, title: "Server draft", writerId: "another-tab",
    editSeq: 1, schema: 5, docIdWrittenOut: true, stateJson: JSON.stringify(mine), baseJson: JSON.stringify(base)
  }), { ok: true, evicted: 0 });
  try {
    const taken = await draftTaker()();
    assert.equal(taken.browserKey, key, "setup: the left-over draft is offered");
    const epoch = session.epoch();
    const events = await traced(async () => { assert.equal(await applyTakenDraft(taken), "untitled-copy"); });
    assert.equal(currentDocument().rows[0].audioText, "Unsaved in the browser.", "the draft's work is open");
    assert.equal(homeModule.currentHome().kind, "none", "as an unsaved copy");
    assertAdoptedAtOnce(events, epoch);
  } finally {
    await store.remove(key);
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

rightToday("T1", "Save As and detached recovery fork the id; open, restore and a same-id reopen keep it", async () => {
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
