import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { bootEntrySwitchFixture, stopEntrySwitchFixture, entrySwitchFixture } from "./shared-entry-switch-support.ts";
import { enterSharedSession } from "../../src/bootstrap/wiring/shared-session.ts";
import { currentDocument, runCommand } from "../../src/bootstrap/wiring/session-owner.ts";
import { confirmSavedNow, unsavedChanges, autoSavePolicy } from "../../src/bootstrap/wiring/save-owners.ts";
import { setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { documentTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { applyMerge } from "../../src/bootstrap/wiring/document-merge.ts";
import { historyOwner } from "../../src/bootstrap/wiring/history.ts";
import { flushDraftNow } from "../../src/bootstrap/wiring/recovery-owners.ts";
import { draftsTesting } from "../../src/bootstrap/wiring/drafts.ts";
import { useDesktopForTest, restoreDesktop } from "../../src/adapters/desktop/desktop-port.ts";
import { createAutoSavePolicy } from "../../src/application/save/autosave.ts";
import { capabilities } from "../../src/bootstrap/wiring/ports/capabilities.ts";
import { titleCommand } from "../../src/application/commands/title.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fakeClock } from "../application/session-fakes.ts";

before(bootEntrySwitchFixture);
after(stopEntrySwitchFixture);

test("C8 an admitted asynchronous merge keeps dirty accounting when enter later refuses", async () => {
  const f = entrySwitchFixture(), history = historyOwner(), capture = history.captureSnapshot;
  const base = migrateRows(structuredClone(currentDocument()));
  const theirs = migrateRows({ ...structuredClone(base), rows: [{ ...base.rows[0], audioText: "Landed merge" }] });
  confirmSavedNow();
  const banner = document.getElementById("merge-banner"); assert.ok(banner); banner.hidden = true;
  Object.assign(history, { captureSnapshot: () => ({ id: "snapshot", docId: base.docId, done: Promise.resolve({ stored: true }) }) });
  let checks = 0;
  try {
    const merging = applyMerge({ base, mine: base, theirs, undoPoint: base, awaitUndoPoint: true });
    const entering = enterSharedSession({ ...f.ports, refusal: () => ++checks === 1 ? null : "later-refusal" });
    await merging;
    assert.deepEqual(await entering, { ok: false, reason: "later-refusal" });
    assert.equal(currentDocument()?.rows[0]?.audioText, "Landed merge");
    assert.equal(unsavedChanges(), true);
    assert.equal(banner.hidden, false);
  } finally { Object.assign(history, { captureSnapshot: capture }); f.close(); }
});

test("C8 an edit admitted during settlement leaves an autosave timer when settlement fails", async () => {
  const f = entrySwitchFixture();
  setHome("file", { name: "Captured.splitpage", format: "splitpage", handle: {} });
  confirmSavedNow(); autoSavePolicy().setEnabled(true);
  try {
    assert.deepEqual(await enterSharedSession({ ...f.ports, settle: () => {
      assert.equal(runCommand(titleCommand("Typed during settlement")).kind, "applied");
      throw new Error("settlement failed");
    } }), { ok: false, reason: "enter-failed" });
    assert.equal(unsavedChanges(), true);
    assert.equal(autoSavePolicy().enabled(), true);
    assert.equal(autoSavePolicy().pending(), true);
  } finally { autoSavePolicy().clear(); setHome("none"); f.close(); }
});

test("C8 an autosave due during settlement is not silently lost on release", async () => {
  const f = entrySwitchFixture(), clock = fakeClock(); let writes = 0;
  const policy = createAutoSavePolicy({ capability: capabilities, timers: clock, enabledAtStart: () => true,
    due: () => { void Promise.resolve().then(() => { writes++; }); }, changed: () => {} });
  policy.schedule("file");
  try {
    assert.deepEqual(await enterSharedSession({ ...f.ports, settle: () => {
      clock.advance(2000); throw new Error("settlement failed");
    } }), { ok: false, reason: "enter-failed" });
    await Promise.resolve();
    assert.equal(writes, 1);
    assert.equal(clock.armed(), 0);
  } finally { policy.stop(); f.close(); }
});

test("C8 settlement draft notification and flush write the admitted edit after failed enter", async () => {
  const f = entrySwitchFixture(); let writes = 0, sequence = 0, flushing: Promise<unknown> = Promise.resolve(), pending = false;
  useDesktopForTest({ setDocumentState: () => {}, writeDraft: async () => { writes++; return { ok: true, seq: ++sequence, bytes: 1 }; } });
  try {
    assert.equal(runCommand(titleCommand("Unsaved draft")).kind, "applied");
    const status = draftsTesting()?.status as () => { pending: boolean };
    await flushDraftNow(); writes = 0;
    assert.equal(status().pending, false);
    assert.deepEqual(await enterSharedSession({ ...f.ports, settle: () => {
      assert.equal(runCommand(titleCommand("Draft during settlement")).kind, "applied");
      pending = status().pending;
      flushing = flushDraftNow(); throw new Error("settlement failed");
    } }), { ok: false, reason: "enter-failed" });
    assert.deepEqual(await flushing, { ok: true, seq: 2, bytes: 1 });
    assert.equal(pending, true);
    assert.equal(writes, 1);
  } finally { restoreDesktop(); f.close(); }
});

for (const kind of ["open", "startNew"] as const) test("C8 admitted leave-first " + kind + " keeps history under its continuation hold", async () => {
  const f = entrySwitchFixture();
  try {
    assert.deepEqual(await f.enter(), { ok: true });
    const arrived = documentTransitions()[kind]({ from: { raw: { title: "Next", rows: [{ id: "N", audioText: "Next words" }] } }, reason: "next script", keep: "Before next script" });
    assert.equal(arrived.kept, true);
    assert.equal(currentDocument()?.title, "Next");
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});
