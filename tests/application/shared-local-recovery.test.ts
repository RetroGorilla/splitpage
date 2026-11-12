import "../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionCapabilities } from "../../src/application/session/capabilities.ts";
import { createConflictStash } from "../../src/application/recovery/conflict-stash.ts";
import { createLocalWorkStash, createStashedWork } from "../../src/application/recovery/stashed-work.ts";
import { createDocumentMerge } from "../../src/application/session/document-merge.ts";
import type { DocumentMergePorts } from "../../src/application/session/document-merge.ts";
import { createLocalFilesOwner } from "../../src/application/transitions/local-files.ts";
import type { LocalFilesOwnerPorts } from "../../src/application/transitions/local-files-ports.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { fakeNotices } from "../features/fakes.ts";

const SHARED = createSessionCapabilities("shared", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
const STANDALONE = createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
const STASH_REASON = "Stashed work cannot be applied to a shared session.";
const MERGE_REASON = "Local merge is not available in a shared session.";
const RELOAD_REASON = "Reloading a local file is not available in a shared session.";

function recorder(calls: unknown[][]) {
  return (name: string) => (...args: unknown[]): never => { calls.push([name, ...args]); throw new Error("unexpected local recovery port"); };
}

function document() {
  return migrateRows({ docId: "d11111111111111111111111111111111", title: "Shared", rows: [] }, fakeMigration().ports);
}

test("shared stash storage refuses capture, read, clear, accept and reload-guard changes without accessing storage or blobs", () => {
  const calls: unknown[][] = [];
  const unused = recorder(calls);
  const stash = createConflictStash({ capability: SHARED, storage: unused("storage"), internImage: unused("intern") });
  const input = { mine: { rows: [{ id: "r1", visualImage: "__IMAGE__" }] }, blobs: { ["a".repeat(64)]: "data:image/png;base64,AA==" }, imagesStripped: true };
  assert.equal(stash.save(input), false);
  assert.equal(stash.read(), null);
  stash.clear();
  assert.equal(stash.accept(input, { rows: [{ id: "r1", imageRef: { sha: "b".repeat(64) } }] }), input);
  stash.dropReloadGuard();
  assert.deepEqual(input, { mine: { rows: [{ id: "r1", visualImage: "__IMAGE__" }] }, blobs: { ["a".repeat(64)]: "data:image/png;base64,AA==" }, imagesStripped: true });
  assert.deepEqual(calls, []);
});

test("shared local-work capture refuses before current document, ancestor, clock, editor, blob or stash ports", () => {
  const calls: unknown[][] = [];
  const unused = recorder(calls);
  const stash = { save: unused("save"), read: unused("read"), clear: unused("clear"), accept: unused("accept"), dropReloadGuard: unused("dropGuard") };
  const capture = createLocalWorkStash({ capability: SHARED, stash,
    current: unused("current"), base: unused("base"), now: unused("clock"), editor: unused("editor"), durable: unused("durable"), dataUrl: unused("blob") });
  assert.equal(capture(), false);
  assert.deepEqual(calls, []);
});

for (const [name, capability, reason] of [
  ["a shared session", SHARED, STASH_REASON],
  ["a session that refuses only the merge", { stash: STANDALONE.stash, merge: SHARED.merge }, MERGE_REASON]
] as const) {
  for (const override of [null, { mine: { rows: [] } }]) {
    test("stash application in " + name + " refuses before reading or accepting " + (override ? "an override" : "stored work") + ", marking, clearing, copying or merging", () => {
      const calls: unknown[][] = [];
      const unused = recorder(calls);
      const stash = { save: unused("save"), read: unused("read"), clear: unused("clear"), accept: unused("accept"), dropReloadGuard: unused("dropGuard") };
      const apply = createStashedWork<{ docId: string; rows: readonly unknown[] }, unknown>({ capability, stash,
        markWrittenOut: unused("mark"), copy: unused("copy"), merge: unused("merge") });
      const loaded = { docId: "d11111111111111111111111111111111", rows: [] };
      const out = apply(loaded, override);
      assert.deepEqual(out, { state: { docId: "d11111111111111111111111111111111", rows: [] }, report: null, snapshot: null, reason: reason });
      assert.equal((out as { state: unknown }).state, loaded);
      assert.deepEqual(calls, []);
    });
  }
}

test("a merge that refuses stashed work leaves the loaded document as the answer and carries the reason", () => {
  const loaded = { docId: "d11111111111111111111111111111111", rows: [] as readonly unknown[] };
  const stash = { save: () => true, read: () => null, clear: () => {}, accept: <T>(work: T) => work, dropReloadGuard: () => {} };
  const apply = createStashedWork<{ docId: string; rows: readonly unknown[] }, unknown>({ capability: STANDALONE, stash,
    markWrittenOut: () => {}, copy: doc => doc, merge: () => ({ state: null, reason: MERGE_REASON }) });
  const out = apply(loaded, { mine: { rows: [{ id: "r1" }] } }, {});
  assert.deepEqual(out, { state: { docId: "d11111111111111111111111111111111", rows: [] }, report: null, snapshot: null, reason: MERGE_REASON });
});

test("shared document merge refuses planning, applying and reporting before document, migration, history, undo, autosave, banner or toast ports", async () => {
  const calls: unknown[][] = [];
  const unused = recorder(calls);
  const ports: DocumentMergePorts<unknown> = {
    capability: SHARED, states: unused("states"), entry: unused("entry"), isDocument: unused("validate"), snapshot: unused("snapshot"),
    current: unused("current"), adopt: unused("adopt"), documentId: unused("id"), noteHistoryFrom: unused("history"), armUndo: unused("undo"),
    setBase: unused("base"), capture: unused("capture"), stillOwns: unused("owns"),
    view: { banner: unused("banner"), absorbed: unused("absorbed"), autoSave: unused("autosave"), toast: unused("toast") }
  };
  const merge = createDocumentMerge(ports);
  const doc = document();
  assert.throws(() => merge.states(null, doc, doc), { message: MERGE_REASON });
  for (const options of [undefined, null, { theirs: doc, mine: doc }, { theirs: doc, unchanged: true }, { theirs: doc, mergeOnly: true }, { theirs: doc, mine: doc, awaitUndoPoint: true }]) {
    assert.deepEqual(await merge.apply(options), { state: null, result: null, snapshot: null, reason: MERGE_REASON });
  }
  merge.report({ merged: doc, conflicts: [], stats: { rowsFromMe: 1, rowsFromThem: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 } });
  merge.report({ merged: doc, conflicts: [], stats: { rowsFromMe: 1, rowsFromThem: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 } }, { alreadySaved: true });
  assert.deepEqual(calls, []);
});

test("shared reload refuses the project and import routes before conflict, destination, history, file reads or adoption", async t => {
  const calls: unknown[][] = [];
  const unused = recorder(calls);
  const notices = fakeNotices();
  const ports: LocalFilesOwnerPorts = {
    capability: SHARED, document: { current: unused("current") }, session: { noteAbsorbedDirty: unused("dirty"), noteReload: unused("reload") },
    transitions: { open: unused("open") }, history: { keep: unused("snapshot") }, saving: { confirmSavedNow: unused("confirm") }, saves: { unsaved: unused("unsaved") },
    conflicts: { close: unused("close") }, location: { amendHome: unused("amend home"), setHome: unused("set home"), fileHome: unused("file home"), importHome: unused("import home") },
    lastFile: { load: unused("last file"), remember: unused("remember") }, syncIdentity: unused("identity"), stamps: { stampRow: unused("stamp") },
    notices: { ...notices.notices, busy: { begin: unused("busy"), end: unused("end busy") } }, resetProductionPanel: unused("reset"), panels: { close: unused("panel") }, undo: { flush: unused("flush") },
    imports: { parseProjectFileState: unused("parse"), docxToRows: unused("docx"), csvToRows: unused("csv"), detectTwoColumnFormat: unused("detect"), parseImportRows: unused("rows"), normalizeImportedRows: unused("normalize") },
    text: { sanitizeHtml: unused("sanitize") }, resumeNeeded: unused("resume"), desktop: { running: unused("desktop"), openFileDialog: unused("dialog"), routeOpen: unused("route") },
    files: { read: unused("read"), text: unused("read text"), permission: unused("permission"), openPicker: null, desktopHandle: unused("handle"), checkConflict: unused("conflict"), createWritable: unused("writer") },
    chooseFallback: unused("fallback")
  };
  const owner = createLocalFilesOwner();
  t.after(owner.startLocalFiles(ports));
  await owner.reloadProjectFromDisk();
  await owner.reloadFileFromDisk();
  assert.deepEqual(calls, []);
  assert.deepEqual(notices.shown.map(({ message, kind }) => [message, kind]), [[RELOAD_REASON, "warn"], [RELOAD_REASON, "warn"]]);
});
