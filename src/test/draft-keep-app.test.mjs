import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { unsavedChanges } from "../legacy/save-bridge.ts";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { noteSessionEdit } = await import("../legacy/session-bridge.ts");
const { confirmSavedNow } = await import("../legacy/save-bridge.ts");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { flushDraftNow } = await import("../legacy/recovery-bridge.ts");
const { setHome } = await import("../legacy/location-bridge.ts");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const calls = [];
const fakeDesktop = {
  writeDraft: async (payload) => { calls.push({ op: "write", payload }); return { ok: true, seq: payload.seq }; },
  discardDraft: async (seq) => { calls.push({ op: "discard", seq }); return { ok: true }; },
  setDocumentState: () => {},
  draftRestoreDone: () => {}
};

function script(title) {
  return migrateRows({
    schema: 5, title, docId: "d" + "5".repeat(32),
    rows: [{ id: "r1", visualText: "Wide", audioText: "Kept " + title + ".", status: "todo" }]
  });
}

function desktopHandle(id, name) {
  return { kind: "file", name, _desktopId: id, createWritable() {}, getFile: async () => { throw new Error("ENOENT"); } };
}

async function withDesktop(fn) {
  useDesktopForTest(fakeDesktop);
  try { return await fn(); } finally { restoreDesktop(); }
}

async function openCleanFile(id, title) {
  const name = id + ".splitpage";
  await openDocument({ kind: "file", file: new File([buildSplitpageFile(exportDocumentOf(script(title)))], name, { lastModified: 1 }), handle: desktopHandle(id, name), options: { skipSnapshot: true, silent: true } });
  confirmSavedNow();
  await flushDraftNow();
  calls.length = 0;
}

const writes = () => calls.filter((c) => c.op === "write");

test("a plain flush of a clean desktop file tab writes no draft, as before (#258)", async () => {
  await withDesktop(async () => {
    await openCleanFile("fplain", "Plain");
    assert.equal(unsavedChanges(), false);
    await flushDraftNow();
    assert.equal(writes().length, 0, JSON.stringify(calls.map((c) => c.op)));
  });
});

test("a keep flush of a clean desktop file tab writes its whole document as a file draft (#258)", async () => {
  await withDesktop(async () => {
    await openCleanFile("fkeep", "Moved away");
    const r = await flushDraftNow({ keep: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(writes().length, 1, JSON.stringify(calls.map((c) => c.op)));
    const p = writes()[0].payload;
    assert.equal(p.originKind, "file");
    assert.equal(p.fileId, "fkeep");
    assert.equal(JSON.parse(p.stateJson).rows[0].audioText, "Kept Moved away.");
    assert.equal(unsavedChanges(), false, "keeping a copy does not mark the script unsaved");
  });
});

test("a second keep flush with nothing changed writes nothing more, and a plain flush afterwards tries to discard it as before (#258)", async () => {
  await withDesktop(async () => {
    await openCleanFile("fagain", "Again");
    await flushDraftNow({ keep: true });
    await flushDraftNow({ keep: true });
    assert.equal(writes().length, 1, JSON.stringify(calls.map((c) => c.op)));
    await flushDraftNow();
    assert.deepEqual(calls.map((c) => c.op), ["write", "discard"]);
  });
});

test("a keep flush of a clean script with no file writes nothing (#258)", async () => {
  await withDesktop(async () => {
    await openCleanFile("fnone", "No file");
    setHome("none");
    await flushDraftNow({ keep: true });
    assert.equal(writes().length, 0, JSON.stringify(calls.map((c) => c.op)));
  });
});

test("a keep flush of a dirty file tab writes the draft once, as a plain flush would (#258)", async () => {
  await withDesktop(async () => {
    await openCleanFile("fdirty", "Dirty");
    currentDocument().rows[0].audioText = "Typed and not saved.";
    noteSessionEdit();
    await flushDraftNow({ keep: true });
    assert.equal(writes().length, 1, JSON.stringify(calls.map((c) => c.op)));
    assert.equal(JSON.parse(writes()[0].payload.stateJson).rows[0].audioText, "Typed and not saved.");
    confirmSavedNow();
  });
});
