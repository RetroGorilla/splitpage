import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";
import { documentOpenings, documentSources, documentTransitions, openDocument } from "../../src/bootstrap/wiring/transition-owners.ts";
import { documentEntry } from "../../src/bootstrap/wiring/ports/document-entry.ts";
import { openingStatus } from "../../src/bootstrap/wiring/ports/transitions.ts";
import { currentCapabilities, currentDocument, liveSession, runCommand, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { enterSharedSession, leaveRunningSharedSession, sharedSessionParts } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { mountRowsRenderFeature, stopRowsRenderFeature } from "../../src/bootstrap/wiring/render.ts";
import { confirmSavedNow, unsavedChanges } from "../../src/bootstrap/wiring/save-owners.ts";
import { fileHome, currentHome, setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { localFileMenuControls, localFilesOwner } from "../../src/bootstrap/wiring/local-files.ts";
import { localFilesOwnerPorts } from "../../src/bootstrap/wiring/ports/local-files.ts";
import { createLocalFilesOwner } from "../../src/application/transitions/local-files.ts";
import { startNewScript, openLongDemo } from "../../src/bootstrap/wiring/file-menu-controls.ts";
import { applyTakenDraft } from "../../src/bootstrap/wiring/drafts.ts";
import { useDesktopForTest, restoreDesktop } from "../../src/adapters/desktop/desktop-port.ts";
import type { DesktopFileEntry } from "../../src/adapters/desktop/desktop-port.ts";
import { startDesktopView } from "../../src/features/desktop/desktop.ts";
import type { DesktopPorts } from "../../src/features/desktop/ports.ts";
import type { DesktopOpenedFile } from "../../src/application/desktop/shell.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fromHtml } from "../../src/bootstrap/richtext.ts";
import { encodeSharedState } from "../../src/adapters/collab/document.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { fakeClock } from "../application/session-fakes.ts";
import { operation } from "../adapters/collab/executor-support.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import { flowBaseReference } from "../../src/core/collab/base-reference.ts";

const SOURCE = { schema: 2, docId: "d" + "1".repeat(32), title: "Entry source", rev: 1, rows: [{ id: "R1", audioText: "abc" }] };
const TARGET = { schema: 2, docId: "d" + "2".repeat(32), title: "Opened target", rev: 1, rows: [{ id: "R2", audioText: "Target words" }] };
let serial = 10;
before(async () => { await bootApp(JSON.stringify(SOURCE)); await localFilesOwner().tryResumeLastProject(); });
after(() => { restoreDesktop(); stopApp(); closeApp(); });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function switcher() {
  const log: string[] = [], errors: unknown[] = [], standalone = currentCapabilities(); let held: string | null = null;
  const ports: SharedSwitchPorts = { opening: openingStatus, commandRefused: undefined, refusal: () => { log.push("refusal"); return null; },
    settle: () => { log.push("settle"); }, detach: () => { setHome("none"); },
    bindings: { enter: () => { log.push("enter"); }, settle: () => { log.push("binding-settle"); return held; }, leave: () => { log.push("leave"); } },
    common: standalone, standalone, migrate: migrateRows, docId: () => { log.push("id"); return "d" + String(serial++).padStart(32, "0"); },
    editor: () => "Editor", structure: { cells: fromHtml }, report: error => { errors.push(error); }, timers: fakeClock(), now: () => 0 };
  return { ports, log, errors, hold: (reason: string | null) => { held = reason; } };
}

function reset() {
  (document.activeElement as HTMLElement | null)?.blur();
  documentTransitions().open({ from: { raw: structuredClone(SOURCE) }, reason: "C8 fixture" });
  setHome("none"); confirmSavedNow(); assert.equal(documentOpenings.openingPending(), false);
}

async function share() {
  reset(); const s = switcher(); stopRowsRenderFeature();
  assert.deepEqual(await enterSharedSession(s.ports), { ok: true });
  const parts = sharedSessionParts(); assert.ok(parts);
  return { ...s, parts };
}

function close() {
  if (sharedSession()) assert.deepEqual(leaveRunningSharedSession(), { ok: true });
  mountRowsRenderFeature(); setHome("none");
}

async function refusedDuringOpening(s: ReturnType<typeof switcher>) {
  const doc = currentDocument(), epoch = liveSession().epoch(), generation = liveSession().generation();
  assert.equal(documentOpenings.openingPending(), true);
  assert.deepEqual(await enterSharedSession(s.ports), { ok: false, reason: "opening-pending" });
  assert.equal(currentDocument() === doc, true);
  assert.deepEqual([liveSession().epoch(), liveSession().generation(), sharedSession(), sharedSessionParts(), s.log, s.errors], [epoch, generation, false, null, [], []]);
}

async function enterAfterLanding(s: ReturnType<typeof switcher>, title: string) {
  assert.equal(documentOpenings.openingPending(), false); assert.equal(sharedSession(), false); assert.equal(currentDocument()?.title, title);
  (document.activeElement as HTMLElement | null)?.blur();
  stopRowsRenderFeature(); assert.deepEqual(await enterSharedSession(s.ports), { ok: true }); assert.deepEqual(s.errors, []);
}

function heldFile(name: string) {
  const read = deferred<string>(), ready = deferred<undefined>();
  const file = Object.assign(new File([], name, { lastModified: 1 }), { text: () => { ready.resolve(undefined); return read.promise; } });
  return { file, read, ready };
}

function atRead(ready: Promise<void>, opening: Promise<unknown>): Promise<void> {
  let began = false;
  const started = ready.then(() => { began = true; });
  const ended = opening.then(() => { assert.equal(began, true, "opening finished without reaching its read"); },
    () => { assert.equal(began, true, "opening failed before reaching its read"); });
  return Promise.race([started, ended]);
}

for (const imported of [false, true]) test("C8 shared entry refuses during asynchronous " + (imported ? "import" : "file open") + " and succeeds after landing", async () => {
  reset(); const s = switcher(), input = heldFile(imported ? "Imported file.txt" : "Target.splitpage");
  const opening = openDocument({ kind: "file", file: input.file, handle: null });
  try {
    await atRead(input.ready.promise, opening); await refusedDuringOpening(s);
    input.read.resolve(imported ? "Imported words" : JSON.stringify(TARGET)); await opening;
    await enterAfterLanding(s, imported ? "Imported file" : "Opened target");
  } finally { input.read.resolve(imported ? "Imported words" : JSON.stringify(TARGET)); await opening.catch(() => {}); close(); }
});

test("C8 a failed opening and a cancelled picker release their captured opening tokens", async () => {
  reset(); const before = currentDocument(), input = heldFile("Unreadable.splitpage");
  const opening = openDocument({ kind: "file", file: input.file, handle: null });
  await atRead(input.ready.promise, opening); assert.equal(documentOpenings.openingPending(), true);
  input.read.reject(new Error("read failed")); assert.equal(await opening, false);
  assert.equal(documentOpenings.openingPending(), false); assert.equal(currentDocument() === before, true);
  const picked = deferred<never>(), ready = deferred<undefined>(), owner = createLocalFilesOwner();
  const base = localFilesOwnerPorts(localFileMenuControls), stop = owner.startLocalFiles({ ...base,
    files: { ...base.files, openPicker: () => { ready.resolve(undefined); return picked.promise; } } });
  try {
    const choosing = owner.openLocalFile(); await atRead(ready.promise, choosing); assert.equal(documentOpenings.openingPending(), true);
    picked.reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); await choosing;
    assert.equal(documentOpenings.openingPending(), false); assert.equal(currentDocument() === before, true);
  } finally { stop(); }
});

for (const lostEpoch of [false, true]) test("C8 a real asynchronous draft resume " + (lostEpoch ? "retires its lost epoch and keeps the replacement" : "blocks shared entry until its standalone landing"), async () => {
  reset(); const s = switcher();
  const read = deferred<DesktopFileEntry>(), ready = deferred<undefined>();
  useDesktopForTest({ readFile: () => { ready.resolve(undefined); return read.promise; }, setDocumentState: () => {} });
  const target = migrateRows(structuredClone(TARGET)), json = JSON.stringify(target), bytes = new TextEncoder().encode(json);
  const opening = applyTakenDraft({ header: { origin: { kind: "file" }, docIdWrittenOut: true }, file: { id: "draft-file", name: "Draft.splitpage" }, stateJson: json, baseJson: json });
  try {
    await atRead(ready.promise, opening); await refusedDuringOpening(s);
    if (lostEpoch) {
      documentTransitions().startNew({ from: { raw: { title: "Replacement", rows: [{ id: "N", audioText: "New words" }] } }, reason: "epoch replacement" });
      assert.equal(documentOpenings.openingPending(), false);
    }
    read.resolve({ id: "draft-file", name: "Draft.splitpage", lastModified: 1, size: bytes.length, bytes });
    assert.equal(await opening, lostEpoch ? "kept" : "nothing-unsaved");
    await enterAfterLanding(s, lostEpoch ? "Replacement" : "Opened target");
  } finally {
    read.resolve({ id: "draft-file", name: "Draft.splitpage", lastModified: 1, size: bytes.length, bytes });
    await opening.catch(() => {}); restoreDesktop(); close();
  }
});

test("C8 desktop open-with keeps entry pending from file read through standalone landing", async () => {
  reset(); const s = switcher(), read = deferred<File>(), ready = deferred<undefined>();
  let completion: Promise<unknown> | null = null, settled = 0;
  let incoming: ((entry: DesktopOpenedFile) => void) | null = null;
  const ports: DesktopPorts = { entry: documentEntry, opening: { track: work => {
    const result = documentOpenings.track(work); completion = Promise.resolve(result); return result;
  } }, running: () => true,
    shell: () => ({ onOpenFile: callback => { incoming = callback; }, onRestoreNotice: () => {}, onReassignDocId: () => {}, onMenuCommand: () => {},
      openPrompterInBrowser: async () => ({ ok: false, code: "OPEN_FAILED" }), openPrompterInChromium: async () => ({ ok: false, code: "OPEN_FAILED" }) }),
    canOpenPrompterInBrowser: () => false, makeHandle: () => ({ getFile: () => { ready.resolve(undefined); return read.promise; } }), wireBlobs: () => {},
    document: { current: currentDocument }, place: { fileHome: () => null }, notices: { show: () => { assert.fail("unexpected desktop notice"); } },
    documents: { open: openDocument }, saves: { unsaved: unsavedChanges, save: async () => {} }, startup: { ready: () => null },
    flushDraft: () => {}, reassignDocId: () => false, documentState: { notify: () => {}, settled: () => { settled++; }, awaitHanded: () => {} }, menuCommands: { run: () => false } };
  const desktop = startDesktopView(ports);
  try {
    desktop.initDesktop(); assert.ok(incoming);
    assert.doesNotThrow(() => { (incoming as (entry: DesktopOpenedFile) => void)({ id: "outside", name: "Outside.splitpage" }); });
    assert.ok(completion); await atRead(ready.promise, completion); await refusedDuringOpening(s);
    read.resolve(Object.assign(new File([], "Outside.splitpage"), { text: async () => JSON.stringify(TARGET) })); await completion;
    assert.equal(settled, 1);
    await enterAfterLanding(s, "Opened target");
  } finally {
    read.resolve(Object.assign(new File([], "Outside.splitpage"), { text: async () => JSON.stringify(TARGET) }));
    if (completion) await completion; desktop.dispose(); close();
  }
});

for (const kind of ["direct open", "direct new", "New", "demo", "dropped file", "recent file", "preparsed inbound"] as const) test("C8 leaves first for " + kind, async () => {
  const page = await share();
  const file = Object.assign(new File([], "Target.splitpage"), { text: async () => JSON.stringify(TARGET) });
  const handle = { getFile: async () => file, name: file.name };
  try {
    if (kind === "direct open") documentTransitions().open({ from: { raw: structuredClone(TARGET) }, reason: "direct open" });
    else if (kind === "direct new") documentTransitions().startNew({ from: { raw: structuredClone(TARGET) }, reason: "direct new" });
    else if (kind === "New") assert.equal(startNewScript(), true);
    else if (kind === "demo") assert.equal(openLongDemo(), true);
    else await openDocument({ kind: "file", file, handle: kind === "recent file" ? handle : null,
      ...(kind === "preparsed inbound" ? { parsed: { state: migrateRows(structuredClone(TARGET)), kind: "splitpage" }, options: { skipSnapshot: true, silent: true } } : {}) });
    assert.equal(sharedSession(), false); assert.equal(collabState(page.parts.handle).destroyed, true);
    assert.equal(page.log.filter(item => item === "binding-settle").length, 1); assert.equal(page.log.filter(item => item === "leave").length, 1);
    assert.deepEqual(page.errors, []);
    if (kind !== "New" && kind !== "demo") assert.equal(currentDocument()?.title, "Opened target");
    if (kind === "New") assert.equal(currentDocument()?.title, "Untitled Script");
    if (kind === "recent file") assert.equal(fileHome()?.handle, handle);
  } finally { close(); }
});

for (const resumed of [false, true]) test("C8 " + (resumed ? "manual resume" : "plain Open") + " leaves before local access and blocks shared entry until landing", async () => {
  const page = await share(), input = heldFile("Chosen.splitpage"), ready = deferred<undefined>();
  let reads = 0;
  const handle = { getFile: async () => input.file, queryPermission: async () => "granted", requestPermission: async () => "granted" },
    owner = createLocalFilesOwner(), base = localFilesOwnerPorts(localFileMenuControls);
  const stop = owner.startLocalFiles({ ...base, files: { ...base.files,
    openPicker: async () => { assert.equal(sharedSession(), false); return [handle]; },
    read: async () => { assert.equal(sharedSession(), false); reads++; ready.resolve(undefined); return input.file; } } });
  const opening = resumed ? owner.resumeFromHandle(handle) : owner.openLocalFile();
  try {
    await atRead(ready.promise, opening); await atRead(input.ready.promise, opening);
    assert.equal(reads, 1); assert.equal(collabState(page.parts.handle).destroyed, true);
    const next = switcher(); await refusedDuringOpening(next);
    input.read.resolve(JSON.stringify(TARGET)); await opening;
    await enterAfterLanding(next, "Opened target");
  } finally { input.read.resolve(JSON.stringify(TARGET)); await opening.catch(() => {}); stop(); close(); }
});

test("C8 external prompter opens leave first and hold admission through fetching the script", async () => {
  const page = await share(), ready = deferred<undefined>(), response = deferred<Response>(), previous = globalThis.fetch;
  const hooks = window as unknown as { __prompterTest: { launchFromScript: (token: string) => Promise<boolean> } };
  globalThis.fetch = async () => { assert.equal(sharedSession(), false); ready.resolve(undefined); return response.promise; };
  const opening = hooks.__prompterTest.launchFromScript("1".repeat(64));
  const reply = () => new Response(JSON.stringify({ name: "Reading.splitpage", text: JSON.stringify(TARGET) }), { status: 200 });
  try {
    await atRead(ready.promise, opening); assert.equal(collabState(page.parts.handle).destroyed, true);
    const next = switcher(); await refusedDuringOpening(next);
    response.resolve(reply()); assert.equal(await opening, true); await enterAfterLanding(next, "Opened target");
  } finally { response.resolve(reply()); await opening.catch(() => {}); globalThis.fetch = previous; close(); }
});

test("C8 a held binding refuses all entry boundaries before source access or New side effects", async () => {
  const page = await share(); page.hold("buffer-composition");
  const bytes = encodeSharedState(page.parts.handle), doc = currentDocument(), undo = page.parts.undo.sizes(); let reads = 0;
  const file = Object.assign(new File([], "Held.splitpage"), { text: async () => { reads++; return JSON.stringify(TARGET); } });
  const owner = createLocalFilesOwner(), base = localFilesOwnerPorts(localFileMenuControls);
  const stop = owner.startLocalFiles({ ...base, files: { ...base.files, openPicker: async () => { reads++; return []; }, read: async () => { reads++; return file; } } });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { reads++; throw new Error("unexpected fetch"); };
  const unregister = documentSources().register({ id: "C8 custom entry", takes: opening => opening.kind === "custom-entry",
    open: () => { reads++; return true; } });
  try {
    assert.throws(() => documentTransitions().open({ from: { raw: TARGET }, reason: "refused" }), /buffer-composition/);
    assert.throws(() => documentTransitions().startNew({ from: { raw: TARGET }, reason: "refused" }), /buffer-composition/);
    assert.equal(await openDocument({ kind: "file", file }), false);
    assert.equal(await openDocument({ kind: "custom-entry" }), false);
    assert.equal(startNewScript(), false); assert.equal(openLongDemo(), false);
    await owner.openLocalFile(); await owner.resumeFromHandle(null);
    const hooks = window as unknown as { __prompterTest: { launchFromScript: (token: string) => Promise<boolean> } };
    assert.equal(await hooks.__prompterTest.launchFromScript("1".repeat(64)), false);
    assert.equal(reads, 0); assert.equal(currentDocument() === doc, true);
    assert.deepEqual(encodeSharedState(page.parts.handle), bytes); assert.deepEqual(page.parts.undo.sizes(), undo);
    assert.equal(sharedSessionParts() === page.parts, true); assert.equal(documentOpenings.openingPending(), false);
  } finally { unregister(); globalThis.fetch = previous; stop(); page.hold(null); close(); }
});

test("C8 shared reload reads no local file, and a shared edit asks no close question", async () => {
  const page = await share(); let reads = 0;
  const handle = { getFile: async () => { reads++; throw new Error("unexpected local read"); } };
  try {
    for (const kind of ["file", "import"] as const) {
      setHome(kind, { name: "Local.splitpage", handle, format: "splitpage" });
      const bytes = encodeSharedState(page.parts.handle);
      if (kind === "file") await localFilesOwner().reloadProjectFromDisk(); else await localFilesOwner().reloadFileFromDisk();
      assert.equal(reads, 0); assert.deepEqual(encodeSharedState(page.parts.handle), bytes); assert.equal(sharedSession(), true);
    }
    setHome("none");
    const edit = operation({ kind: "text-insert", id: "close-edit", by: "Editor", target: { owner: "R1", segment: "b:R1", field: "audioText" },
      at: { left: flowBaseReference("R1", "audioText", 0), right: flowBaseReference("R1", "audioText", 1), affinity: "after" }, content: [{ value: "X", marks: [] }] });
    assert.equal(runCommand({ name: "close probe", needs: "edit", plan: () => ({ changes: changeSet({ cells: [{ rowId: "R1", field: "audioText" }] }),
      apply: () => { assert.fail("shared probe applied standalone"); }, shared: { operations: [edit], description: { label: "typing", selection: null, typing: null } } }) }).kind, "applied");
    assert.equal(currentDocument()?.rows[0]?.audioText, "aXbc"); assert.equal(unsavedChanges(), false);
    const bytes = encodeSharedState(page.parts.handle), undo = page.parts.undo.sizes();
    const event = new window.Event("beforeunload", { cancelable: true }); window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false); assert.deepEqual(encodeSharedState(page.parts.handle), bytes); assert.deepEqual(page.parts.undo.sizes(), undo);
    assert.equal(currentHome().kind, "none");
  } finally { close(); }
});
