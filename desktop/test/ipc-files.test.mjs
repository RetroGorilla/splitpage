import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createFileIpc } = require("../ipc-files.ts");
const { createRecents } = require("../recents.ts");
const { createFileRegistry, pathKey } = require("../file-service.ts");

function harness(t, saved = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-file-dialog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let state = { recents: [], ...saved };
  const store = {
    read: () => structuredClone(state),
    write: (mutator) => {
      state = mutator(structuredClone(state));
      return Promise.resolve(true);
    }
  };
  const fileIds = createFileRegistry();
  const recents = createRecents({ store, pathKey, fileIds });
  recents.load();
  const opened = [];
  const savedDialogs = [];
  const answers = [];
  const noted = [];
  const landed = [];
  const handlers = new Map();
  const documents = path.join(root, "Documents");
  const { registerFileIpc } = createFileIpc({
    dialog: {
      showOpenDialog: async (_parent, options) => {
        opened.push(options);
        return { canceled: true, filePaths: [] };
      },
      showSaveDialog: async (_parent, options) => {
        savedDialogs.push(options);
        return { canceled: true };
      }
    },
    documentsPath: () => documents,
    fileIds, recents, pathToTabId: new Map(), tabs: new Map(),
    tabOf: () => null, dialogParentFor: () => undefined,
    consumeTestDialogAnswer: () => answers.shift(),
    testDialogsSeen: () => 0, testMode: false,
    bundleJobs: {
      noteSaveTarget: (id, tab) => { noted.push({ id, tab }); },
      prepareWrite: async (id) => ({ refused: null, text: null, landed: (ok) => { if (ok) landed.push(id); } }),
      planSave: async () => ({ ok: true, plan: null }),
      chooseSave: () => ({ ok: true })
    }
  });
  registerFileIpc({ ipcHandle: (name, handler) => handlers.set(name, handler) });
  return {
    root, documents, store, recents, fileIds, opened, savedDialogs, answers, noted, landed,
    invoke: (name, ...args) => handlers.get("splitpage:" + name)({}, ...args)
  };
}

test("Open starts in Documents when no script has been saved or opened", async (t) => {
  const h = harness(t);
  assert.equal(await h.invoke("open-file-dialog"), null);
  assert.equal(h.opened[0].defaultPath, h.documents);
});

test("Open falls back to the most recently opened script's folder", async (t) => {
  const h = harness(t);
  const openedFolder = path.join(h.root, "opened");
  fs.mkdirSync(openedFolder);
  h.recents.note(path.join(h.root, "older.splitpage"), "Older");
  h.recents.note(path.join(openedFolder, "latest.md"), "Latest");
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[0].defaultPath, openedFolder);
});

test("Open prefers the last successful Save or Save As folder, even after another script is opened", async (t) => {
  const h = harness(t);
  const savedFolder = path.join(h.root, "saved scripts");
  fs.mkdirSync(savedFolder);
  const file = path.join(savedFolder, "script.splitpage");
  h.answers.push(file);
  const picked = await h.invoke("save-file-dialog", { suggestedName: "script.splitpage", script: true });
  assert.deepEqual(h.noted.map((n) => n.id), [picked.id], "a script save dialog notes the chosen file, for carrying its videos");
  await h.invoke("write-file", picked.id, "first save");
  assert.deepEqual(h.landed, [picked.id], "the landed write is reported so main can carry the videos itself");
  h.recents.note(path.join(h.root, "opened-later.md"), "Later");
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[0].defaultPath, savedFolder);
  const otherFolder = path.join(h.root, "other scripts");
  fs.mkdirSync(otherFolder);
  h.answers.push(path.join(otherFolder, "other.SPLITPAGE"));
  const other = await h.invoke("save-file-dialog", { suggestedName: "other.splitpage" });
  assert.equal(h.noted.length, 1, "a dialog not marked as a script save notes nothing");
  await h.invoke("write-file", other.id, "Save As");
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[1].defaultPath, otherFolder);
});

test("a missing saved folder falls back to recents, then Documents if that folder is missing too", async (t) => {
  const h = harness(t);
  const recentFolder = path.join(h.root, "recent");
  fs.mkdirSync(recentFolder);
  h.recents.note(path.join(recentFolder, "script.splitpage"), "Recent");
  await h.store.write((state) => ({ ...state, lastSavedFolder: path.join(h.root, "deleted") }));
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[0].defaultPath, recentFolder);
  fs.rmdirSync(recentFolder);
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[1].defaultPath, h.documents);
});

test("a file at the remembered folder path is not used as a directory", async (t) => {
  const h = harness(t);
  const file = path.join(h.root, "not-a-folder");
  fs.writeFileSync(file, "file");
  await h.store.write((state) => ({ ...state, lastSavedFolder: file }));
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[0].defaultPath, h.documents);
});

for (const recentAvailable of [true, false]) {
  test(`Open bounds each unavailable folder probe and falls back to ${recentAvailable ? "recents" : "Documents"}`, async (t) => {
    const h = harness(t, { lastSavedFolder: "\\\\offline\\scripts" });
    const recentFolder = path.join(h.root, "recent");
    h.recents.note(path.join(recentFolder, "script.splitpage"), "Recent");
    t.mock.method(fs.promises, "stat", (folder) => {
      if (recentAvailable && folder === recentFolder) return Promise.resolve({ isDirectory: () => true });
      return new Promise(() => {});
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const opening = h.invoke("open-file-dialog");
    t.mock.timers.tick(999);
    await new Promise(setImmediate);
    assert.equal(h.opened.length, 0);
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    if (!recentAvailable) {
      assert.equal(h.opened.length, 0);
      t.mock.timers.tick(999);
      await new Promise(setImmediate);
      assert.equal(h.opened.length, 0);
      t.mock.timers.tick(1);
      await new Promise(setImmediate);
    }
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0].defaultPath, recentAvailable ? recentFolder : h.documents);
    assert.equal(await opening, null);
  });
}

test("cancelled, unwritten and failed saves leave the saved folder unchanged and preserve Save dialog options", async (t) => {
  const h = harness(t, { lastSavedFolder: os.tmpdir() });
  const options = { suggestedName: "script.splitpage", filters: [{ name: "Script", extensions: ["splitpage"] }] };
  assert.equal(await h.invoke("save-file-dialog", options), null);
  assert.deepEqual(h.savedDialogs[0], { defaultPath: options.suggestedName, filters: options.filters });
  h.answers.push(path.join(h.root, "unwritten.splitpage"));
  await h.invoke("save-file-dialog", options);
  h.answers.push(path.join(h.root, "missing", "failed.splitpage"));
  const failed = await h.invoke("save-file-dialog", options);
  await assert.rejects(h.invoke("write-file", failed.id, "failed"), { code: "ENOENT" });
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[0].defaultPath, os.tmpdir());
});

for (const extension of ["csv", "docx", "txt", "html", "htm", "md", "pdf"]) {
  test(`exporting ${extension} through a Save dialog does not replace the saved script folder`, async (t) => {
    const h = harness(t, { lastSavedFolder: os.tmpdir() });
    h.answers.push(path.join(h.root, "export." + extension));
    const picked = await h.invoke("save-file-dialog", { suggestedName: "export." + extension });
    await h.invoke("write-file", picked.id, "export");
    await h.invoke("open-file-dialog");
    assert.equal(h.opened[0].defaultPath, os.tmpdir());
  });
}

test("autosaving an opened script does not replace the saved script folder", async (t) => {
  const h = harness(t, { lastSavedFolder: os.tmpdir() });
  const id = h.fileIds.register(path.join(h.root, "opened.splitpage"));
  await h.invoke("write-file", id, "autosave");
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[0].defaultPath, os.tmpdir());
});

test("autosaving an earlier Save dialog's file does not replace a later Save As folder", async (t) => {
  const h = harness(t);
  const laterFolder = path.join(h.root, "later");
  fs.mkdirSync(laterFolder);
  h.answers.push(path.join(h.root, "first.splitpage"), path.join(laterFolder, "later.splitpage"));
  const first = await h.invoke("save-file-dialog", { suggestedName: "first.splitpage" });
  await h.invoke("write-file", first.id, "first save");
  const later = await h.invoke("save-file-dialog", { suggestedName: "later.splitpage" });
  await h.invoke("write-file", later.id, "Save As");
  await h.invoke("write-file", first.id, "autosave of the first script");
  await h.invoke("open-file-dialog");
  assert.equal(h.opened[0].defaultPath, laterFolder);
});
