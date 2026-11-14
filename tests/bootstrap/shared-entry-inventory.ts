import assert from "node:assert/strict";
import { currentDocument, liveSession, onDocumentReplaced, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { documentTransitions, openDocument, documentOpenings } from "../../src/bootstrap/wiring/transition-owners.ts";
import { entryCapabilities as capabilities } from "../../src/bootstrap/wiring/ports/capabilities.ts";
import { localFilesOwnerPorts } from "../../src/bootstrap/wiring/ports/local-files.ts";
import { documentEntry } from "../../src/bootstrap/wiring/ports/document-entry.ts";
import { createLocalFilesOwner } from "../../src/application/transitions/local-files.ts";
import { localFileMenuControls } from "../../src/bootstrap/wiring/local-files.ts";
import { applyTakenDraft, draftTaker } from "../../src/bootstrap/wiring/drafts.ts";
import { applyStashedWork, draftResume } from "../../src/bootstrap/wiring/recovery-owners.ts";
import { applyMerge } from "../../src/bootstrap/wiring/document-merge.ts";
import { restoreMergeSnapshot } from "../../src/bootstrap/wiring/session-merge.ts";
import { restoreSnapshotFromCard } from "../../src/bootstrap/wiring/history-panel.ts";
import { historyOwner } from "../../src/bootstrap/wiring/history.ts";
import { startNewScript, openLongDemo } from "../../src/bootstrap/wiring/file-menu-controls.ts";
import { setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { useDesktopForTest, restoreDesktop } from "../../src/adapters/desktop/desktop-port.ts";
import type { DesktopTakenDraft } from "../../src/adapters/desktop/desktop-port.ts";
import { startDesktopView } from "../../src/features/desktop/desktop.ts";
import type { DesktopPorts } from "../../src/features/desktop/ports.ts";
import type { DesktopOpenedFile } from "../../src/application/desktop/shell.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { enterSharedSession, leaveRunningSharedSession, sharedSessionParts } from "../../src/bootstrap/wiring/shared-session.ts";
import { sharedUndoRoute } from "../../src/bootstrap/wiring/undo.ts";
import { collabState } from "../../src/adapters/collab/state.ts";
import { entrySwitchFixture } from "./shared-entry-switch-support.ts";
import { fakeNotices } from "../features/fakes.ts";

export const OWNER_ENTRY_METHODS = { open: "replace", startNew: "replace", recover: "replace", restore: "replace", copyId: "read" } as const;
export const ENTRY_CAPABILITIES = ["saveDestinations", "autosave", "merge", "reload", "stash", "drafts", "history", "folders", "bundles", "moves", "documentEntry", "lastFileResume"] as const;
export const COMMON_CAPABILITIES = ["edit", "comment"] as const;
const TARGET = { title: "Recovered draft", rows: [{ id: "D1", audioText: "Recovered words" }] };
const ZERO_ACCESS = { picker: 0, read: 0, permission: 0, protect: 0, lookup: 0, snapshot: 0, draftTaken: 0, draftApplied: 0, fetch: 0, route: 0, importDialog: 0 };

function button(root: string, attributes: Record<string, string>) {
  const parent = document.getElementById(root); assert.ok(parent);
  const item = document.createElement("button");
  for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
  parent.append(item); item.click(); item.remove();
}

function setupEntry() {
  const access = { ...ZERO_ACCESS }, base = localFilesOwnerPorts(localFileMenuControls), owner = createLocalFilesOwner();
  const file = Object.assign(new File([], "Target.splitpage"), { text: async () => { access.read++; return JSON.stringify(TARGET); } });
  const imported = Object.assign(new File([], "Target.txt"), { text: async () => { access.read++; return "Imported words"; } });
  const handle = { name: file.name, getFile: async () => { access.read++; return file; }, requestPermission: async () => { access.permission++; return "granted" as const; } };
  const stop = owner.startLocalFiles({ ...base,
    desktop: { ...base.desktop, running: () => false },
    files: { ...base.files, openPicker: async () => { access.picker++; return []; }, read: async () => { access.read++; return file; } },
    lastFile: { ...base.lastFile, load: async () => { access.read++; return handle; } },
    history: { keep: () => { access.snapshot++; } }
  });
  const desktopOwner = createLocalFilesOwner();
  const stopDesktopOwner = desktopOwner.startLocalFiles({ ...base, desktop: { ...base.desktop, running: () => true,
    openFileDialog: async () => { access.picker++; return null; } } });
  const taken: DesktopTakenDraft = { header: { format: "splitpage-draft", formatVersion: 1, tabId: "draft-tab", state: { bytes: 1, sha256: "unused" },
    origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: JSON.stringify(TARGET), baseJson: null, baseProblem: null, usedPrevGeneration: false };
  useDesktopForTest({ setDocumentState: () => {}, listRecents: async () => [],
    readFile: async () => { access.read++; throw new Error("unexpected read"); },
    routeOpen: async () => { access.route++; return { where: "other-tab" }; },
    openFileDialog: async () => { access.picker++; return null; },
    takeDraft: async () => { access.draftTaken++; return taken; }, draftRestoreDone: () => {} });
  const history = historyOwner(), previousHistory = { getHistorySnapshot: history.getHistorySnapshot, protectHistorySnapshot: history.protectHistorySnapshot, captureSnapshot: history.captureSnapshot };
  Object.assign(history, { getHistorySnapshot: async () => { access.lookup++; return null; },
    protectHistorySnapshot: () => { access.protect++; return () => {}; }, captureSnapshot: () => { access.snapshot++; return null; } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { access.fetch++; return new Response("", { status: 404 }); };
  const capabilityCalls: Array<{ name: string; reason: string }> = [];
  const originals = { ...capabilities }; let collecting = false;
  for (const [name, read] of Object.entries(originals)) Object.assign(capabilities, { [name]: () => {
    const answer = read();
    if (collecting && !answer.allowed) capabilityCalls.push({ name, reason: answer.reason });
    return answer;
  } });
  let incoming: ((entry: DesktopOpenedFile) => void) | null = null;
  const desktop: DesktopPorts = { entry: documentEntry, opening: documentOpenings, running: () => true,
    shell: () => ({ onOpenFile: callback => { incoming = callback; }, onRestoreNotice: () => {}, onReassignDocId: () => {}, onMenuCommand: () => {},
      openPrompterInBrowser: async () => ({ ok: false, code: "OPEN_FAILED" }), openPrompterInChromium: async () => ({ ok: false, code: "OPEN_FAILED" }) }),
    canOpenPrompterInBrowser: () => false, makeHandle: () => handle, wireBlobs: () => {},
    document: { current: currentDocument }, place: { fileHome: () => null }, notices: fakeNotices().notices, documents: { open: openDocument },
    saves: { unsaved: () => false, save: async () => {} }, startup: { ready: () => null }, flushDraft: () => {}, reassignDocId: () => false,
    documentState: { notify: () => {}, settled: () => {}, awaitHanded: () => {} }, menuCommands: { run: () => false } };
  return { access, owner, desktopOwner, file, imported, handle, taken, capabilityCalls,
    begin: () => { collecting = true; }, end: () => { collecting = false; },
    desktopOpen: () => { const mounted = startDesktopView(desktop); try { mounted.initDesktop(); assert.ok(incoming); incoming({ id: "target", name: file.name }); } finally { mounted.dispose(); } },
    close: () => { stopDesktopOwner(); stop(); Object.assign(capabilities, originals); Object.assign(history, previousHistory); globalThis.fetch = previousFetch; restoreDesktop(); } };
}

type EntryFixture = ReturnType<typeof setupEntry>;
interface EntryCase {
  readonly name: string;
  readonly capability: string;
  readonly owner?: keyof typeof OWNER_ENTRY_METHODS;
  readonly prepare?: (context: EntryFixture) => void;
  readonly result?: string;
  readonly resultReason?: true;
  readonly run: (context: EntryFixture) => unknown;
}
const arrival = () => ({ from: { raw: structuredClone(TARGET) }, reason: "inventory entry" });
export const ENTRY_CASES: readonly EntryCase[] = [
  { name: "open", owner: "open", capability: "documentEntry", run: () => documentTransitions().open(arrival()) },
  { name: "new", owner: "startNew", capability: "documentEntry", run: () => documentTransitions().startNew(arrival()) },
  { name: "recover", owner: "recover", capability: "documentEntry", run: () => documentTransitions().recover({ ...arrival(), detached: false, baseline: null }) },
  { name: "restore", owner: "restore", capability: "documentEntry", run: () => documentTransitions().restore(arrival()) },
  { name: "file source", capability: "documentEntry", run: c => openDocument({ kind: "file", file: c.file }) },
  { name: "import", capability: "documentEntry", run: c => openDocument({ kind: "file", file: c.imported }) },
  { name: "inbound parsed file", capability: "documentEntry", run: c => openDocument({ kind: "file", file: c.file, parsed: { state: migrateRows(structuredClone(TARGET)), kind: "splitpage" } }) },
  { name: "browser picker", capability: "documentEntry", run: c => c.owner.openLocalFile() },
  { name: "desktop dialog", capability: "documentEntry", run: c => c.desktopOwner.openLocalFile() },
  { name: "manual resume", capability: "documentEntry", run: c => c.owner.resumeFromHandle(c.handle) },
  { name: "resume banner", capability: "documentEntry", prepare: c => { localFileMenuControls().showResumeBanner(c.handle); }, run: () => {
    const item = document.getElementById("resume-continue"); assert.ok(item); item.click();
  } },
  { name: "automatic resume", capability: "lastFileResume", run: c => c.owner.tryResumeLastProject() },
  { name: "File New", capability: "documentEntry", run: () => startNewScript() },
  { name: "demo", capability: "documentEntry", run: () => openLongDemo() },
  { name: "new tab New", capability: "documentEntry", run: () => button("newtab-page", { "data-newtab-action": "new" }) },
  { name: "starter", capability: "documentEntry", run: () => {
    const item = document.querySelector<HTMLButtonElement>('[data-newtab-action="starter"]'); assert.ok(item); item.click();
  } },
  { name: "paste as new", capability: "documentEntry", run: () => button("newtab-page", { "data-newtab-action": "paste" }) },
  { name: "new tab Open", capability: "documentEntry", run: () => button("newtab-page", { "data-newtab-action": "open" }) },
  { name: "drop", capability: "documentEntry", run: c => {
    const zone = document.getElementById("newtab-drop"); assert.ok(zone);
    zone.dispatchEvent(Object.assign(new window.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: { types: ["Files"], files: [c.file] } }));
  } },
  { name: "new tab recent", capability: "documentEntry", run: () => button("newtab-page", { "data-newtab-action": "open-recent", "data-file-id": "target" }) },
  { name: "File recent", capability: "documentEntry", run: () => button("menu-sub-recent", { "data-recent-id": "target" }) },
  { name: "desktop open-with", capability: "documentEntry", run: c => c.desktopOpen() },
  { name: "external prompter", capability: "documentEntry", run: () => (window as unknown as { __prompterTest: { launchFromScript: (token: string) => Promise<boolean> } }).__prompterTest.launchFromScript("1".repeat(64)) },
  { name: "draft take", capability: "drafts", prepare: () => { draftResume().setRestorePending(true); }, run: () => draftTaker()?.() },
  { name: "draft apply", capability: "drafts", result: "kept", run: async c => { const answer = await applyTakenDraft(c.taken); if (answer === "applied") c.access.draftApplied++; return answer; } },
  { name: "version restore", capability: "history", result: "refused", run: () => restoreMergeSnapshot("snapshot") },
  { name: "history card", capability: "history", result: "refused", run: () => { const item = document.createElement("button"); item.dataset.id = "snapshot"; return restoreSnapshotFromCard(item); } },
  { name: "project reload", capability: "reload", prepare: c => { setHome("file", { name: c.file.name, handle: c.handle, format: "splitpage" }); }, run: c => c.owner.reloadProjectFromDisk() },
  { name: "import reload", capability: "reload", prepare: c => { setHome("import", { name: c.imported.name, handle: c.handle, format: "txt" }); }, run: c => c.owner.reloadFileFromDisk() },
  { name: "local merge", capability: "merge", resultReason: true, run: () => applyMerge({ theirs: migrateRows(structuredClone(TARGET)), unchanged: true }) },
  { name: "stashed work", capability: "stash", resultReason: true, run: () => applyStashedWork(migrateRows(structuredClone(TARGET)), null) },
  ...ENTRY_CAPABILITIES.map(name => ({ name: "capability " + name, capability: name, run: () => capabilities[name]() }))
];

export async function exerciseHeldEntry(entry: EntryCase, phase: "enter" | "leave") {
  const f = entrySwitchFixture(), context = setupEntry();
  let attempted = false, pending: Promise<unknown> = Promise.resolve(), caught: string | null = null;
  let sameDocument = false, sameRevision = false;
  const attempt = () => {
    if (attempted) return;
    attempted = true;
    const doc = currentDocument(), epoch = liveSession().epoch(), generation = liveSession().generation();
    const modal = document.getElementById("import-modal"); assert.ok(modal);
    const importHidden = modal.hidden;
    context.begin();
    try { pending = Promise.resolve(entry.run(context)); } catch (error) { caught = error instanceof Error ? error.message : String(error); }
    finally { context.end(); }
    if (importHidden && !modal.hidden) context.access.importDialog++;
    sameDocument = currentDocument() === doc;
    sameRevision = liveSession().epoch() === epoch && liveSession().generation() === generation;
  };
  const stop = onDocumentReplaced(() => { if (phase === "leave" && !sharedSession()) attempt(); });
  const ports = { ...f.ports, docId: () => { if (phase === "enter") attempt(); return f.ports.docId(); } };
  try {
    if (phase === "enter") entry.prepare?.(context);
    const entered = await enterSharedSession(ports);
    const parts = sharedSessionParts(); assert.ok(parts);
    let left: unknown = null;
    if (phase === "leave") { entry.prepare?.(context); left = leaveRunningSharedSession(); }
    const result = await pending;
    assert.equal(attempted, true);
    assert.deepEqual(context.access, ZERO_ACCESS, "no entry access before refusal");
    assert.equal(sameDocument, true, "entry kept current document"); assert.equal(sameRevision, true, "entry kept revision");
    assert.equal(entry.owner ? caught === "session-switching" : caught === null, true, "named owner refusal: " + caught);
    assert.equal(context.capabilityCalls.some(call => call.name === entry.capability && call.reason === "session-switching"), true, "named capability refusal");
    if (entry.result !== undefined) assert.equal(result, entry.result);
    if (entry.resultReason) assert.equal(result && typeof result === "object" && "reason" in result ? result.reason : null, "session-switching");
    assert.deepEqual(entered, { ok: true });
    assert.deepEqual([currentDocument()?.title, currentDocument()?.rows.map(row => [row.id, row.audioText])], ["Captured script", [["R1", "Captured words"]]]);
    if (phase === "leave") {
      assert.deepEqual(left, { ok: true }); assert.equal(sharedSessionParts() === null, true); assert.equal(sharedUndoRoute() === null, true);
      assert.equal(collabState(parts.handle).destroyed, true);
      documentTransitions().startNew(arrival()); assert.equal(currentDocument()?.title, TARGET.title);
    }
    assert.deepEqual(f.errors, []);
  } finally { stop(); context.close(); f.close(); }
}
