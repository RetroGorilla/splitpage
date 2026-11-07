import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { confirmSavedNow, saveDoc, setAutoSaveEnabled, unsavedChanges } from "../bootstrap/wiring/save-owners.ts";
import * as homeModule from "../bootstrap/wiring/location-owner.ts";
import { currentDocument, liveSession } from "../bootstrap/wiring/session-owner.ts";

localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
await bootApp();

const { migrateRows } = await import("../bootstrap/document-ports.ts");
const { exportDocumentOf } = await import("../bootstrap/wiring/export-capture.ts");
const { buildMarkdownProject, buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { bundledNamesInProject } = await import("../../shared/video-embed.ts");
const { makeDesktopHandle } = await import("../adapters/desktop/desktop-handle.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const { offerBundleAfterDrop } = await import("../bootstrap/wiring/gallery.ts");
const { videoFiles } = await import("../bootstrap/wiring/video-files.ts");
const { rowSlots } = await import("../core/document/gallery.ts");
const { applyTakenDraft } = await import("../bootstrap/wiring/drafts.ts");
const { flushDraftNow } = await import("../bootstrap/wiring/recovery-owners.ts");

after(closeApp);

const ID = (letter) => "d" + letter.repeat(32);
const DROP = { name: "take one.mp4", size: 9, path: "C:\\Drops\\take one.mp4" };
const LINK = { name: DROP.name, size: DROP.size, location: { kind: "path", path: DROP.path }, poster: true };

function script(title, docId) {
  return migrateRows({
    schema: 5, title, docId,
    rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageLinks: [LINK] }]
  });
}

function linkIn(doc) {
  const row = doc.rows.find((r) => r.id === "r1");
  return row ? rowSlots(row)[0]?.links[0]?.location : undefined;
}

async function openFromDesktop(fake, doc, name) {
  loadTestDocument(script("Placeholder", ID("0")));
  undoOwner().flush();
  confirmSavedNow();
  const picked = await fake.saveFileDialog({ suggestedName: name });
  await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(doc))));
  const handle = makeDesktopHandle(picked);
  await openDocument({ kind: "file", file: await handle.getFile(), handle, options: { skipSnapshot: true, silent: true } });
  assert.equal(homeModule.currentHome().handle, handle, "setup: the script is open from its file");
  return handle;
}

function heldBundle() {
  const fake = window.__desktopTest.makeFakeBackend();
  const finishes = [];
  fake.bundleVideoFile = function (token, job) {
    (this._bundleCalls = this._bundleCalls || []).push({ token, job });
    return new Promise((resolve) => { finishes.push(resolve); });
  };
  window.__desktopTest.setBackend(fake);
  return { fake, finishes };
}

async function dropAndAccept() {
  videoFiles.grant(new File([new Uint8Array(DROP.size)], DROP.name, { type: "video/mp4" }), LINK);
  offerBundleAfterDrop("r1", [DROP], null);
  const accept = document.getElementById("bundle-accept");
  assert.equal(document.getElementById("bundle-modal").hidden, false, "setup: the drop asks");
  accept.click();
}

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return check();
};

test("Save As waits for a running copy, and the bytes it writes link the copy, with the real ownership in play", async () => {
  setAutoSaveEnabled(false);
  const { fake, finishes } = heldBundle();
  const written = [];
  const write = fake.writeFile;
  fake.writeFile = function (id, data) {
    written.push(new TextDecoder().decode(data));
    return write.call(this, id, data);
  };
  try {
    const before = await openFromDesktop(fake, script("Episode 12", ID("1")), "Episode 12.splitpage");
    await dropAndAccept();
    assert.ok(await until(() => finishes.length === 1), "the copy reached main");
    const writesBefore = written.length;
    let saved = false;
    const saving = saveDoc({ saveAs: true }).then(() => { saved = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(saved, false, "the save waits while the copy runs");
    assert.equal(written.length, writesBefore, "nothing is written before the copy finishes");
    assert.equal(document.getElementById("bundle-progress").hidden, false, "the wait shows the progress panel with Cancel");
    finishes[0]({ ok: true, name: "take one.mp4" });
    await saving;
    assert.notEqual(homeModule.currentHome().handle, before, "the document now lives in the new file");
    assert.deepEqual(linkIn(currentDocument()), { kind: "bundled", name: "take one.mp4" });
    assert.equal(written.length, writesBefore + 1);
    assert.deepEqual(bundledNamesInProject(written[written.length - 1]), ["take one.mp4"], "the written script links the copy, so main carries it");
  } finally {
    window.__desktopTest.restoreBackend();
    document.getElementById("toast-host").replaceChildren();
  }
});

test("Cancel on the wait for a copy that never answers ends the Save As at once, with nothing written and the document unchanged", async () => {
  setAutoSaveEnabled(false);
  const { fake, finishes } = heldBundle();
  const written = [];
  const write = fake.writeFile;
  fake.writeFile = function (id, data) { written.push(id); return write.call(this, id, data); };
  try {
    const before = await openFromDesktop(fake, script("Episode 12", ID("7")), "Episode 12.splitpage");
    const writesBefore = written.length;
    await dropAndAccept();
    assert.ok(await until(() => finishes.length === 1), "the copy reached main");
    const saving = saveDoc({ saveAs: true });
    assert.ok(await until(() => !document.getElementById("bundle-progress").hidden), "the wait shows the panel");
    document.getElementById("bundle-cancel").click();
    await saving;
    assert.equal(written.length, writesBefore, "nothing was written");
    assert.equal(homeModule.currentHome().handle, before, "the document stays with its script");
    assert.deepEqual(linkIn(currentDocument()), LINK.location, "the drop keeps its path");
    assert.equal(document.getElementById("bundle-progress").hidden, true);
  } finally {
    window.__desktopTest.restoreBackend();
    document.getElementById("toast-host").replaceChildren();
  }
});

test("a drop that lands while a Save As writes gets no prompt and keeps its path when the write fails", async () => {
  setAutoSaveEnabled(false);
  const fake = window.__desktopTest.makeFakeBackend();
  const bundles = [];
  let fail = null;
  const backend = Object.assign({}, fake, {
    writeFile: () => new Promise((_resolve, reject) => { fail = reject; }),
    bundleVideoFile: (token, job) => { bundles.push(job); return Promise.resolve({ ok: true, name: "take one.mp4" }); }
  });
  window.__desktopTest.setBackend(backend);
  try {
    const before = await openFromDesktop(fake, script("Episode 12", ID("8")), "Episode 12.splitpage");
    const saving = saveDoc({ saveAs: true });
    assert.ok(await until(() => fail !== null), "the save is writing");
    videoFiles.grant(new File([new Uint8Array(DROP.size)], DROP.name, { type: "video/mp4" }), LINK);
    offerBundleAfterDrop("r1", [DROP], null);
    assert.equal(document.getElementById("bundle-modal").hidden, true, "no copy prompt during the save");
    fail(new Error("disk full"));
    await saving;
    assert.equal(homeModule.currentHome().handle, before, "the failed save leaves the document with its script");
    assert.deepEqual(linkIn(currentDocument()), LINK.location, "the drop is linked by its path");
    assert.deepEqual(bundles, [], "nothing was copied");
    offerBundleAfterDrop("r1", [DROP], null);
    assert.equal(document.getElementById("bundle-modal").hidden, false, "once the save is over, dropping again asks");
    document.getElementById("bundle-decline").click();
  } finally {
    window.__desktopTest.restoreBackend();
    document.getElementById("toast-host").replaceChildren();
  }
});

test("a copy that finishes after the tab opened an unrelated script changes neither script", async () => {
  setAutoSaveEnabled(false);
  const { fake, finishes } = heldBundle();
  try {
    await openFromDesktop(fake, script("Episode 12", ID("2")), "Episode 12.splitpage");
    await dropAndAccept();
    assert.ok(await until(() => finishes.length === 1), "the copy reached main");
    const picked = await fake.saveFileDialog({ suggestedName: "Other.splitpage" });
    await fake.writeFile(picked.id, new TextEncoder().encode(buildSplitpageFile(exportDocumentOf(script("Other", ID("3"))))));
    const other = makeDesktopHandle(picked);
    await openDocument({ kind: "file", file: await other.getFile(), handle: other, options: { skipSnapshot: true, silent: true } });
    assert.equal(currentDocument().title, "Other", "setup: an unrelated script replaced it");
    finishes[0]({ ok: true, name: "take one.mp4" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(linkIn(currentDocument()), LINK.location, "the unrelated script keeps its own link");
  } finally {
    window.__desktopTest.restoreBackend();
    document.getElementById("toast-host").replaceChildren();
  }
});

test("a Save As whose folder already holds a different copy of a linked video fails before writing, and the saved link reopens the right copy", async () => {
  setAutoSaveEnabled(false);
  const fake = window.__desktopTest.makeFakeBackend();
  const bundled = { name: "take.mp4", size: 9, location: { kind: "bundled", name: "take.mp4" } };
  const writes = [];
  let clash = true;
  const backend = Object.assign({}, fake, {
    writeFile: (id, data) => {
      if (clash) { clash = false; return Promise.resolve({ size: 0, bundleRefused: { reason: "clash", folder: "Episode 12 v2 files", name: "take.mp4", copied: 0 } }); }
      writes.push(id);
      return fake.writeFile(id, data);
    }
  });
  window.__desktopTest.setBackend(backend);
  try {
    const doc = script("Episode 12", ID("4"));
    doc.rows[0].imageLinks = [bundled];
    const before = await openFromDesktop(fake, doc, "Episode 12.splitpage");
    await saveDoc({ saveAs: true });
    assert.equal(homeModule.currentHome().handle, before, "the document stays with the script it came from");
    assert.deepEqual(writes, [], "nothing was written");
    assert.ok(document.getElementById("toast-host").textContent.includes(
      "Could not save — “Episode 12 v2 files” already has a different “take.mp4”. Rename or move that file, then save again."),
      document.getElementById("toast-host").textContent);
    await saveDoc({ saveAs: true });
    assert.equal(writes.length, 1, "once the file is moved, saving again works");
    const saved = homeModule.currentHome().handle;
    assert.notEqual(saved, before);
    const reopened = makeDesktopHandle({ id: writes[0], name: saved.name });
    loadTestDocument(script("Placeholder", ID("0")));
    undoOwner().flush();
    confirmSavedNow();
    await openDocument({ kind: "file", file: await reopened.getFile(), handle: reopened, options: { skipSnapshot: true, silent: true } });
    assert.deepEqual(linkIn(currentDocument()), bundled.location, "the saved script links the bundled name");
    videoFiles.openFile(rowSlots(currentDocument().rows[0])[0].links[0]);
    assert.ok(await until(() => (backend._bundledOpens || []).length === 1));
    assert.deepEqual(backend._bundledOpens, ["take.mp4"], "the link reopens by its bundled name, which main resolves beside the saved script");
  } finally {
    window.__desktopTest.restoreBackend();
    document.getElementById("toast-host").replaceChildren();
  }
});

test("a Save As refused after files were copied says how many are already in the new folder, and a refusal before any says nothing more", async () => {
  setAutoSaveEnabled(false);
  const fake = window.__desktopTest.makeFakeBackend();
  const F = "Episode 12 v2 files";
  const refusals = [
    { reason: "failed", folder: F, name: "b.mp4", copied: 1 },
    { reason: "cancelled", folder: F, name: "b.mp4", copied: 2 },
    { reason: "clash", folder: F, name: "take.mp4", copied: 1 },
    { reason: "failed", folder: F, name: "a.mp4", copied: 0 }
  ];
  const backend = Object.assign({}, fake, {
    writeFile: (id, data) => (refusals.length ? Promise.resolve({ size: 0, bundleRefused: refusals.shift() }) : fake.writeFile(id, data))
  });
  window.__desktopTest.setBackend(backend);
  const host = document.getElementById("toast-host");
  try {
    const doc = script("Episode 12", ID("6"));
    doc.rows[0].imageLinks = [{ name: "a.mp4", size: 9, location: { kind: "bundled", name: "a.mp4" } }];
    const before = await openFromDesktop(fake, doc, "Episode 12.splitpage");
    const expected = [
      "Could not save — “b.mp4” could not be copied to “" + F + "”, so the script was not saved there. 1 file was already copied to “" + F + "” and is still there.",
      "Could not save — copying the files to “" + F + "” was stopped, so the script was not saved there. 2 files were already copied to “" + F + "” and are still there.",
      "Could not save — “" + F + "” already has a different “take.mp4”. Rename or move that file, then save again. 1 file was already copied to “" + F + "” and is still there.",
      "Could not save — “a.mp4” could not be copied to “" + F + "”, so the script was not saved there."
    ];
    for (const message of expected) {
      host.replaceChildren();
      await saveDoc({ saveAs: true });
      assert.ok(host.textContent.includes(message), host.textContent);
      assert.equal(homeModule.currentHome().handle, before, "the document stays with the script it came from");
    }
    assert.ok(!host.textContent.includes("already copied"), "a refusal before any copy names none");
  } finally {
    window.__desktopTest.restoreBackend();
    host.replaceChildren();
  }
});

test("main reads the bundled names from the bytes of both project formats as the app writes them, and nothing else", () => {
  const doc = script("Episode 12", ID("5"));
  doc.rows[0].imageLinks = [
    { name: "b.mp4", size: 9, location: { kind: "bundled", name: "b.mp4" } },
    { name: "a.mov", size: 9, location: { kind: "bundled", name: "a.mov" } },
    LINK,
    { href: "https://example.com/clip" }
  ];
  doc.rows[0].audioText = "~~~splitpage\n{\"location\":{\"kind\":\"bundled\",\"name\":\"typed.mp4\"}}\n~~~";
  const captured = exportDocumentOf(doc);
  assert.deepEqual(bundledNamesInProject(buildSplitpageFile(captured)), ["a.mov", "b.mp4"]);
  assert.deepEqual(bundledNamesInProject(buildMarkdownProject(captured)), ["a.mov", "b.mp4"], "a fence typed into the script is not the project block");
  assert.deepEqual(bundledNamesInProject("not a project"), []);
});

const TAKE_PATH = "D:\\Episode 12 files\\take.mp4";

function askingBackend() {
  const fake = window.__desktopTest.makeFakeBackend();
  const plans = [];
  const choices = [];
  const written = [];
  const bodies = [];
  const names = [];
  const write = fake.writeFile;
  fake.writeFile = function (id, data) { written.push(id); bodies.push(new TextDecoder().decode(data)); return write.call(this, id, data); };
  const dialog = fake.saveFileDialog;
  fake.saveFileDialog = function (opts) { return dialog.call(this, names.length ? { ...opts, suggestedName: names.shift() } : opts); };
  fake.planBundleSave = (id, listed) => {
    plans.push({ id, names: listed });
    return Promise.resolve({ ok: true, plan: { from: "Episode 12 files", to: "Episode 12 v2 files", files: 1, bytes: 300 * 1024 * 1024, copyBytes: 300 * 1024 * 1024, linkable: true } });
  };
  fake.chooseBundleSave = (id, choice) => {
    choices.push({ id, choice });
    return Promise.resolve({ ok: true, links: choice === "link" ? [{ name: "take.mp4", path: TAKE_PATH }] : [] });
  };
  window.__desktopTest.setBackend(fake);
  return { fake, plans, choices, written, bodies, names };
}

const bundledScript = (docId) => migrateRows({
  schema: 5, title: "Episode 12", docId,
  rows: [{ id: "r1", visualText: "Wide", audioText: "One.", status: "todo", imageLinks: [{ name: "take.mp4", size: 4, location: { kind: "bundled", name: "take.mp4" } }] }]
});

const pathLinksIn = (text) => {
  const found = [];
  const walk = (v) => { if (v && typeof v === "object") { if (v.location && v.location.kind === "path") found.push(v.location.path); Object.values(v).forEach(walk); } };
  const block = /~{3,}splitpage\n([\s\S]*?)\n~{3,}/.exec(text);
  walk(JSON.parse(block ? block[1] : text));
  return found;
};

test("Don't copy: the document adopts main's links with the save, so in-place saves, a Save As in another format and a restored draft all keep them", async () => {
  setAutoSaveEnabled(false);
  const b = askingBackend();
  const modal = () => document.getElementById("bundle-save-modal");
  try {
    await openFromDesktop(b.fake, bundledScript(ID("a")), "Episode 12.splitpage");
    b.names.push("Episode 12 v2.splitpage");
    const saving = saveDoc({ saveAs: true });
    assert.ok(await until(() => !modal().hidden), "the Save As asks");
    document.getElementById("bundle-save-link").click();
    await saving;
    assert.deepEqual(linkIn(currentDocument()), { kind: "path", path: TAKE_PATH }, "the live document links the original file");
    assert.deepEqual(pathLinksIn(b.bodies[b.bodies.length - 1]), [TAKE_PATH], "the written script links it too");
    assert.deepEqual(bundledNamesInProject(b.bodies[b.bodies.length - 1]), []);
    assert.equal(unsavedChanges(), false, "adopting the links is part of the save, so nothing is left unsaved");

    await saveDoc({});
    assert.deepEqual(pathLinksIn(b.bodies[b.bodies.length - 1]), [TAKE_PATH], "an in-place save writes the same links, with nothing for main to remember");

    const plansBefore = b.plans.length;
    b.names.push("Episode 12 v2.md");
    await saveDoc({ saveAs: true });
    assert.equal(b.plans.length, plansBefore, "nothing bundled is left, so there is nothing to ask");
    const md = b.bodies[b.bodies.length - 1];
    assert.ok(md.includes("~~~splitpage"), "setup: the second Save As wrote Markdown");
    assert.deepEqual(pathLinksIn(md), [TAKE_PATH], "the Markdown script keeps the links");

    const drafts = [];
    const writeDraft = b.fake.writeDraft;
    b.fake.writeDraft = function (payload) { drafts.push(payload); return writeDraft.call(this, payload); };
    const flushed = await flushDraftNow({ keep: true });
    assert.equal(flushed.ok, true, JSON.stringify(flushed));
    assert.equal(drafts.length, 1, "setup: the tab's draft was written");
    const draft = drafts[0].stateJson;
    loadTestDocument(script("Placeholder", ID("0")));
    undoOwner().flush();
    confirmSavedNow();
    await applyTakenDraft({ header: { origin: { kind: "untitled" }, docIdWrittenOut: false }, stateJson: draft });
    assert.deepEqual(linkIn(currentDocument()), { kind: "path", path: TAKE_PATH }, "a draft restored after a crash holds the same links");
    videoFiles.openFile(rowSlots(currentDocument().rows[0])[0].links[0]);
    assert.ok(await until(() => (b.fake._videoPathOpens || []).length === 1));
    assert.deepEqual(b.fake._videoPathOpens, [TAKE_PATH], "and opens the original file");
  } finally {
    window.__desktopTest.restoreBackend();
    document.getElementById("toast-host").replaceChildren();
  }
});

test("every Save As to a new file clears undo history without a word, so no undo or redo brings back a name the new folder lacks", async () => {
  setAutoSaveEnabled(false);
  const OLD = { name: "old.mp4", size: 3, location: { kind: "bundled", name: "old.mp4" } };
  const edit = (change) => { change(currentDocument().rows[0]); liveSession().noteEdit(); undoOwner().flush(); undoOwner().breakCoalescing(); };
  const bundledNow = () => bundledNamesInProject(buildSplitpageFile(exportDocumentOf(currentDocument())));
  const host = document.getElementById("toast-host");
  for (const way of ["link", "copy", "none", "same", "unlinked"]) {
    const b = askingBackend();
    const modal = () => document.getElementById("bundle-save-modal");
    b.fake.planBundleSave = (id, listed) => {
      b.plans.push({ id, names: listed });
      if (way === "same") return Promise.resolve({ ok: true, plan: null });
      return Promise.resolve({ ok: true, plan: { from: "Episode 12 files", to: "Episode 12 v2 files", files: 1, bytes: 4, copyBytes: 4, linkable: true } });
    };
    b.fake.openBundledFile = function (name) { (this._bundledOpens = this._bundledOpens || []).push(name); return Promise.resolve({ ok: true }); };
    try {
      const start = way === "unlinked" ? script("Episode 12", ID("g")) : bundledScript(ID({ link: "b", copy: "c", none: "e", same: "f" }[way]));
      if (way !== "unlinked") start.rows[0].imageLinks.push(OLD);
      await openFromDesktop(b.fake, start, "Episode 12.splitpage");
      host.replaceChildren();
      if (way === "unlinked") edit((row) => { row.audioText = "One, first."; });
      else edit((row) => { row.imageLinks = way === "none" ? [] : [row.imageLinks[0]]; });
      edit((row) => { row.audioText = "One, again."; });
      assert.equal(undoOwner().undo().ok, true, way + ": setup: one edit waits on redo");
      assert.deepEqual(undoOwner().sizes(), { undo: 1, redo: 1 }, way + ": setup: the history holds an edit on each side");
      b.names.push(way === "same" ? "Episode 12.md" : "Episode 12 v2.splitpage");
      const text = currentDocument().rows[0].audioText;
      const saving = saveDoc({ saveAs: true });
      if (way === "link" || way === "copy") {
        assert.ok(await until(() => !modal().hidden), way + ": the Save As asks");
        assert.deepEqual(undoOwner().undo(), { ok: false, empty: true }, way + ": undo waits while the Save As is under way");
        assert.deepEqual(undoOwner().redo(), { ok: false, empty: true });
        assert.equal(currentDocument().rows[0].audioText, text);
        assert.deepEqual(undoOwner().sizes(), { undo: 1, redo: 1 }, way + ": and a held undo spends nothing");
        document.getElementById(way === "link" ? "bundle-save-link" : "bundle-save-copy").click();
      }
      await saving;
      assert.deepEqual(undoOwner().sizes(), { undo: 0, redo: 0 }, way + ": the history from before the Save As is gone");
      assert.equal(/[Uu]ndo/.test(host.textContent), false, way + ": nothing is said about it");
      assert.deepEqual(undoOwner().undo(), { ok: false, empty: true });
      assert.deepEqual(undoOwner().redo(), { ok: false, empty: true });
      assert.equal(currentDocument().rows[0].audioText, text, way + ": and the text stays as saved");
      assert.deepEqual(bundledNow(), way === "copy" || way === "same" ? ["take.mp4"] : [], way + ": only names the new folder has are linked");
      await saveDoc({});
      const body = b.bodies[b.bodies.length - 1];
      assert.equal(body.includes("old.mp4"), false, way + ": the next save never writes the removed name");
      assert.equal(unsavedChanges(), false);
      for (const slot of rowSlots(currentDocument().rows[0])) for (const link of slot.links) videoFiles.openFile(link);
      if (way === "link") {
        assert.ok(await until(() => (b.fake._videoPathOpens || []).length === 1));
        assert.deepEqual(b.fake._videoPathOpens, [TAKE_PATH], "link: the original file opens");
      }
      if (way === "copy") {
        assert.ok(await until(() => (b.fake._bundledOpens || []).length === 1));
        assert.deepEqual(b.fake._bundledOpens, ["take.mp4"], "copy: the copied file opens from the new folder");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((b.fake._bundledOpens || []).includes("old.mp4"), false, way + ": the unrelated old.mp4 in the new folder is never opened");
    } finally {
      window.__desktopTest.restoreBackend();
      host.replaceChildren();
    }
  }
});

test("a Save As whose linked files are missing stops before the prompt and says how many and where, and a refused Don't copy says why", async () => {
  setAutoSaveEnabled(false);
  const b = askingBackend();
  const host = document.getElementById("toast-host");
  const refusals = [
    { reason: "missing", folder: "Episode 12 files", name: "take.mp4", copied: 0, count: 2 },
    { reason: "missing", folder: "Episode 12 files", name: "take.mp4", copied: 0, count: 1 }
  ];
  b.fake.planBundleSave = () => Promise.resolve(refusals.length
    ? { ok: false, code: "MISSING", refused: refusals.shift() }
    : { ok: true, plan: { from: "Episode 12 files", to: "Episode 12 v2 files", files: 1, bytes: 4, copyBytes: 4, linkable: true } });
  b.fake.chooseBundleSave = () => Promise.resolve({ ok: false, code: "UNLINKABLE", refused: { reason: "unlinkable", folder: "Episode 12 files", name: "take.mp4", copied: 0 } });
  try {
    const before = await openFromDesktop(b.fake, bundledScript(ID("b")), "Episode 12.splitpage");
    const writesBefore = b.written.length;
    for (const message of [
      "Could not save — 2 linked files are missing from “Episode 12 files”. Restore them, or remove their links, then save again.",
      "Could not save — 1 linked file is missing from “Episode 12 files”. Restore it, or remove its link, then save again."
    ]) {
      host.replaceChildren();
      await saveDoc({ saveAs: true });
      assert.ok(host.textContent.includes(message), host.textContent);
      assert.equal(document.getElementById("bundle-save-modal").hidden, true, "no prompt");
    }
    host.replaceChildren();
    const saving = saveDoc({ saveAs: true });
    assert.ok(await until(() => !document.getElementById("bundle-save-modal").hidden));
    document.getElementById("bundle-save-link").click();
    await saving;
    assert.ok(host.textContent.includes("Could not save — “take.mp4” in “Episode 12 files” is on a network share, so the new script cannot link to it there. " +
      "Save again and copy the files."), host.textContent);
    assert.equal(b.written.length, writesBefore, "nothing was written");
    assert.equal(homeModule.currentHome().handle, before);
    assert.deepEqual(linkIn(currentDocument()), { kind: "bundled", name: "take.mp4" });
  } finally {
    window.__desktopTest.restoreBackend();
    host.replaceChildren();
  }
});

test("Save As of a script with bundled files asks first: Copy files and Don't copy tell main and write, Cancel writes nothing, a plain save never asks", async () => {
  setAutoSaveEnabled(false);
  const { fake, plans, choices, written } = askingBackend();
  const modal = () => document.getElementById("bundle-save-modal");
  try {
    const before = await openFromDesktop(fake, bundledScript(ID("9")), "Episode 12.splitpage");
    const writesBefore = written.length;
    await saveDoc({});
    assert.equal(plans.length, 0, "a plain save asks nothing");
    assert.equal(written.length, writesBefore + 1);

    let saving = saveDoc({ saveAs: true });
    assert.ok(await until(() => !modal().hidden), "the Save As asks");
    assert.equal(plans[0].names.join(), "take.mp4", "main is asked with the bundled names of the bytes about to be written");
    assert.equal(document.getElementById("bundle-save-warning").hidden, false, "300 MB is over the warning line");
    assert.equal(written.length, writesBefore + 1, "nothing is written while the prompt is open");
    document.getElementById("bundle-save-cancel").click();
    await saving;
    assert.equal(written.length, writesBefore + 1, "Cancel writes nothing");
    assert.equal(homeModule.currentHome().handle, before, "the document stays with its script");
    assert.deepEqual(choices, []);

    saving = saveDoc({ saveAs: true });
    assert.ok(await until(() => !modal().hidden));
    assert.equal(document.activeElement, document.getElementById("bundle-save-copy"));
    document.getElementById("bundle-save-copy").click();
    await saving;
    assert.deepEqual(choices.map((c) => c.choice), ["copy"]);
    assert.equal(choices[0].id, plans[1].id, "the choice is for the file the dialog chose");
    assert.equal(written.length, writesBefore + 2);
    assert.equal(written[written.length - 1], plans[1].id);
    assert.notEqual(homeModule.currentHome().handle, before);
    assert.deepEqual(linkIn(currentDocument()), { kind: "bundled", name: "take.mp4" }, "Copy files keeps the bundled link");

    saving = saveDoc({ saveAs: true });
    assert.ok(await until(() => !modal().hidden));
    document.getElementById("bundle-save-link").click();
    await saving;
    assert.deepEqual(choices.map((c) => c.choice), ["copy", "link"]);
    assert.equal(written.length, writesBefore + 3);
  } finally {
    window.__desktopTest.restoreBackend();
    document.getElementById("toast-host").replaceChildren();
  }
});
