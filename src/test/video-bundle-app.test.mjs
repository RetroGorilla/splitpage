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
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
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

test("a copy that finishes after Save As links the new script's document, with the real ownership in play", async () => {
  setAutoSaveEnabled(false);
  const { fake, finishes } = heldBundle();
  try {
    const before = await openFromDesktop(fake, script("Episode 12", ID("1")), "Episode 12.splitpage");
    await dropAndAccept();
    assert.ok(await until(() => finishes.length === 1), "the copy reached main");
    await saveDoc({ saveAs: true });
    assert.notEqual(homeModule.currentHome().handle, before, "the document now lives in the new file");
    finishes[0]({ ok: true, name: "take one.mp4" });
    assert.ok(await until(() => linkIn(currentDocument())?.kind === "bundled"), "the late copy relinks the document Save As moved");
    assert.deepEqual(linkIn(currentDocument()), { kind: "bundled", name: "take one.mp4" });
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
