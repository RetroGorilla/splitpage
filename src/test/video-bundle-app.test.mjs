import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { confirmSavedNow, saveDoc, setAutoSaveEnabled } from "../bootstrap/wiring/save-owners.ts";
import * as homeModule from "../bootstrap/wiring/location-owner.ts";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";

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
      "Could not save — copying the videos to “" + F + "” was stopped, so the script was not saved there. 2 files were already copied to “" + F + "” and are still there.",
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
