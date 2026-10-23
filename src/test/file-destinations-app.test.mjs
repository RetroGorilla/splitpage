import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { flushEdits } = await import("../legacy/undo-bridge.ts");
const saves = await import("../legacy/save-bridge.ts");
const { deliverFile } = await import("../legacy/file-delivery.ts");
const { importHome, setHome } = await import("../legacy/location-bridge.ts");
const { restoreDesktop, useDesktopForTest } = await import("../adapters/desktop/desktop-port.ts");
const { runningOnDesktop, setRunningOnDesktop } = await import("../application/desktop-presence.ts");
const { loadTestDocument } = await import("./_document.mjs");

after(closeApp);

function toasts(kind) {
  return Array.from(document.querySelectorAll("#toast-host .toast." + kind)).map((el) => el.textContent);
}

function clearToasts() {
  document.querySelectorAll("#toast-host .toast").forEach((el) => el.remove());
}

function onDesktop(fake, run) {
  const was = runningOnDesktop();
  setRunningOnDesktop(true);
  useDesktopForTest(fake);
  return Promise.resolve().then(run).finally(() => {
    restoreDesktop();
    setRunningOnDesktop(was);
  });
}

test("a browser delivery downloads the file and shows its saved message", async () => {
  clearToasts();
  const made = [];
  const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = (blob) => { made.push(blob); return "blob:test/1"; };
  URL.revokeObjectURL = () => {};
  try {
    assert.equal(await deliverFile("notes.txt", "hello", { savedMsg: "Saved the notes" }), true);
    assert.equal(made.length, 1);
    assert.equal(await made[0].text(), "hello");
    assert.deepEqual(toasts("ok"), ["Saved the notes"]);
  } finally {
    URL.createObjectURL = orig.create;
    URL.revokeObjectURL = orig.revoke;
  }
});

test("a desktop delivery asks where, writes the bytes there, and says nothing when the dialog is cancelled", async () => {
  clearToasts();
  const writes = [];
  const asked = [];
  await onDesktop({
    saveFileDialog: (options) => { asked.push(options); return Promise.resolve(asked.length === 1 ? null : { id: "picked", name: "plan.csv" }); },
    writeFile: (id, bytes) => { writes.push([id, new TextDecoder().decode(bytes)]); return Promise.resolve({ lastModified: 1 }); }
  }, async () => {
    assert.equal(await deliverFile("plan.csv", "a,b"), false, "a cancelled dialog delivers nothing");
    assert.deepEqual(toasts("ok").concat(toasts("error")), []);
    assert.equal(await deliverFile("plan.csv", new TextEncoder().encode("a,b")), true);
  });
  assert.deepEqual(asked[1], { suggestedName: "plan.csv", filters: [{ name: "CSV file", extensions: ["csv"] }] });
  assert.deepEqual(writes, [["picked", "a,b"]]);
  assert.deepEqual(toasts("ok"), ["Saved plan.csv"]);
});

test("a desktop delivery whose write fails says so and answers false", async () => {
  clearToasts();
  await onDesktop({
    saveFileDialog: () => Promise.resolve({ id: "picked", name: "x.md" }),
    writeFile: () => Promise.reject(new Error("disk full"))
  }, async () => {
    assert.equal(await deliverFile("x.md", "text"), false);
  });
  assert.deepEqual(toasts("error"), ["Could not save the file. Please try again."]);
});

test("a write-back to an import that changed on disk is refused with its conflict, which the dialog shows until it is closed", async () => {
  loadTestDocument(migrateRows({ title: "Imported", docId: "d" + "8".repeat(32), rows: [{ id: "r1", visualText: "", audioText: "One.", status: "todo" }] }));
  flushEdits();
  saves.confirmSavedNow();
  const handle = { name: "imported.md", createWritable: () => { throw new Error("must not write"); }, getFile: () => Promise.resolve({ lastModified: 2000 }) };
  setHome("import", { handle, name: "imported.md", format: "md", lastModified: 1000, inPlace: true });
  const modal = document.getElementById("file-conflict-modal");
  try {
    saves.noteSaveChange();
    const outcome = await saves.requestSave({ kind: "writeback", target: importHome() });
    assert.equal(outcome.kind, "refused");
    assert.deepEqual(outcome.conflict, { fileName: "imported.md", current: { lastModified: 2000 }, kind: "import" });
    assert.deepEqual(saves.fileConflicts().current(), outcome.conflict);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(modal.hidden, false, "the conflict dialog is a view of the refused write-back");
    saves.fileConflicts().close();
    assert.equal(modal.hidden, true);
    assert.equal(saves.fileConflicts().current(), null);
  } finally {
    saves.fileConflicts().close();
    setHome("none");
    saves.confirmSavedNow();
  }
});

test("an autosave refused because the file changed shows no conflict dialog", async () => {
  loadTestDocument(migrateRows({ title: "Project", docId: "d" + "9".repeat(32), rows: [{ id: "r1", visualText: "", audioText: "One.", status: "todo" }] }));
  flushEdits();
  saves.confirmSavedNow();
  const handle = { name: "project.splitpage", createWritable: () => { throw new Error("must not write"); }, getFile: () => Promise.resolve({ lastModified: 2000 }) };
  setHome("file", { handle, name: "project.splitpage", format: "splitpage", lastModified: 1000 });
  try {
    saves.setAutoSaveEnabled(true);
    saves.noteSaveChange();
    const outcome = await saves.requestSave({ kind: "autosave" });
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.conflict, undefined);
    assert.equal(saves.fileConflicts().current(), null);
    assert.equal(document.getElementById("file-conflict-modal").hidden, true);
    assert.match(saves.autoSavePolicy().halted(), /project\.splitpage changed on disk/);
  } finally {
    saves.setAutoSaveEnabled(false);
    saves.resumeAutoSave();
    setHome("none");
    saves.confirmSavedNow();
  }
});
