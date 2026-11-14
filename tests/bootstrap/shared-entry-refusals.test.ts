import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bootApp, closeApp } from "../../src/test/_app-boot.mjs";
import { stopApp } from "../../src/bootstrap/app.ts";
import { enterSharedSession, leaveSharedSession, sharedSessionParts } from "../../src/bootstrap/wiring/shared-session.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { currentCapabilities, currentDocument, sharedSession } from "../../src/bootstrap/wiring/session-owner.ts";
import { documentTransitions } from "../../src/bootstrap/wiring/transition-owners.ts";
import { documentIdentityPorts } from "../../src/bootstrap/wiring/ports/document-identity.ts";
import { createDocumentIdentityOwner } from "../../src/application/identity/document-identity.ts";
import type { IdentityChannel } from "../../src/application/identity/ports.ts";
import { documentLocation, setHome } from "../../src/bootstrap/wiring/location-owner.ts";
import { restoreMergeSnapshot } from "../../src/bootstrap/wiring/session-merge.ts";
import { historyOwner } from "../../src/bootstrap/wiring/history.ts";
import { restoreSnapshotFromCard } from "../../src/bootstrap/wiring/history-panel.ts";
import { applyTakenDraft } from "../../src/bootstrap/wiring/drafts.ts";
import { localFilesOwner } from "../../src/bootstrap/wiring/local-files.ts";
import { prompterControls } from "../../src/bootstrap/wiring/prompter.ts";
import { mountRowsRenderFeature, stopRowsRenderFeature } from "../../src/bootstrap/wiring/render.ts";
import { encodeSharedState } from "../../src/adapters/collab/document.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";
import { fromHtml } from "../../src/bootstrap/richtext.ts";
import { SHARED_SESSION_DISABLED } from "../../src/application/session/ports.ts";
import { fakeClock } from "../application/session-fakes.ts";
import { fakeNotices } from "../features/fakes.ts";

const source = { schema: 2, docId: "d" + "1".repeat(32), title: "Entry source", rev: 1, rows: [{ id: "R1", audioText: "Read this shared projection." }] };
let ids = 2;
before(async () => { await bootApp(JSON.stringify(source)); });
after(() => { stopApp(); closeApp(); });

async function share() {
  documentTransitions().open({ from: { raw: structuredClone(source) }, reason: "C8 fixture" });
  const errors: unknown[] = [];
  const standalone = currentCapabilities();
  const ports: SharedSwitchPorts = {
    refusal: () => null, settle: () => {}, detach: () => {},
    bindings: { enter: () => {}, settle: () => null, leave: () => {} },
    common: standalone, standalone, migrate: migrateRows, docId: () => "d" + String(ids++).padStart(32, "0"),
    editor: () => "Editor", structure: { cells: fromHtml }, report: error => { errors.push(error); }, timers: fakeClock(), now: () => 0
  };
  // why: C7 has not replaced Split's standalone undo tracking; these entry tests mount only the shared owners.
  stopRowsRenderFeature();
  assert.deepEqual(await enterSharedSession(ports), { ok: true });
  const parts = sharedSessionParts(); assert.ok(parts);
  assert.deepEqual(errors, []);
  return { parts, close: () => { assert.deepEqual(leaveSharedSession(ports), { ok: true }); assert.deepEqual(errors, []); mountRowsRenderFeature(); } };
}

for (const shared of [false, true]) test(`C8: a duplicate identity claim ${shared ? "refuses without false history or written-out changes" : "keeps standalone reassignment"}`, async () => {
  const page = shared ? await share() : null;
  if (!shared) documentTransitions().open({ from: { raw: structuredClone(source) }, reason: "C8 standalone fixture" });
  setHome("file", { name: "copy.splitpage", handle: null, format: "splitpage", lastModified: null, diskBase: null });
  documentLocation().markWrittenOut(true);
  const notices = fakeNotices(), history: unknown[] = [], channel: IdentityChannel = { onmessage: null, postMessage: () => {} };
  const owner = createDocumentIdentityOwner(), ports = documentIdentityPorts();
  const stop = owner.startIdentity({ ...ports, effects: notices.notices, channel: () => channel, now: () => 10,
    history: { copyHistory: async (from, to) => { history.push([from, to]); return { ok: true, copied: 1 }; }, historyDocumentChanged: () => { history.push("changed"); } } });
  try {
    owner.syncDocIdentity(); owner.initDocIdentityChannel(); history.length = 0;
    const before = currentDocument(); assert.ok(before);
    const state = page ? encodeSharedState(page.parts.handle) : null, undo = page?.parts.undo.sizes();
    assert.ok(channel.onmessage);
    channel.onmessage({ data: { type: "claim", nonce: "another-tab", at: 1, docId: before.docId, home: "file:earlier.splitpage", title: "Earlier" } });
    if (page) {
      assert.equal(currentDocument(), before);
      assert.deepEqual(encodeSharedState(page.parts.handle), state);
      assert.deepEqual(page.parts.undo.sizes(), undo);
      assert.equal(documentLocation().writtenOut(), true);
      assert.deepEqual([history, owner.docIdEvents(), notices.shown], [[], [], []]);
    } else {
      assert.notEqual(currentDocument()?.docId, source.docId);
      assert.equal(documentLocation().writtenOut(), false);
      assert.equal(owner.docIdEvents().length, 1);
      assert.equal(history.length, 2);
      assert.equal(notices.shown.length, 1);
      assert.match(notices.shown[0]?.message ?? "", /It now has its own version history/);
    }
  } finally { stop(); page?.close(); setHome("none"); }
});

test("D13: the real history wiring refuses a merge-snapshot restore while shared", async () => {
  const page = await share();
  const history = historyOwner(), kept = { getHistorySnapshot: history.getHistorySnapshot, protectHistorySnapshot: history.protectHistorySnapshot, captureSnapshot: history.captureSnapshot };
  Object.assign(history, { getHistorySnapshot: () => { assert.fail("A shared restore read a snapshot"); },
    protectHistorySnapshot: () => { assert.fail("A shared restore protected a snapshot"); }, captureSnapshot: () => { assert.fail("A shared restore wrote a snapshot"); } });
  try {
    const before = encodeSharedState(page.parts.handle), undo = page.parts.undo.sizes();
    assert.equal(await restoreMergeSnapshot("earlier"), "refused");
    const button = document.createElement("button"); button.dataset.id = "earlier";
    assert.equal(await restoreSnapshotFromCard(button), "refused");
    assert.ok(document.getElementById("toast-host")?.textContent?.includes(SHARED_SESSION_DISABLED.history));
    assert.deepEqual(encodeSharedState(page.parts.handle), before);
    assert.deepEqual(page.parts.undo.sizes(), undo);
    assert.equal(sharedSession(), true);
    assert.equal(sharedSessionParts(), page.parts);
  } finally { Object.assign(history, kept); page.close(); }
});

test("C8: the real draft recovery wiring keeps a refused restore while shared", async () => {
  const page = await share();
  try {
    const before = encodeSharedState(page.parts.handle), undo = page.parts.undo.sizes();
    assert.equal(await applyTakenDraft(null), "kept");
    assert.deepEqual(encodeSharedState(page.parts.handle), before);
    assert.deepEqual(page.parts.undo.sizes(), undo);
    assert.equal(sharedSession(), true);
    assert.equal(sharedSessionParts(), page.parts);
  } finally { page.close(); }
});

test("C8: prompter launch reads the projection and keeps the shared owner", async () => {
  const page = await share();
  try {
    const before = encodeSharedState(page.parts.handle), undo = page.parts.undo.sizes();
    const prompter = prompterControls(); assert.ok(prompter);
    prompter.openPrompter();
    assert.equal(document.getElementById("prompter")?.hidden, false);
    assert.match(document.getElementById("prompter-content")?.textContent ?? "", /Read this shared projection\./);
    assert.equal(sharedSession(), true);
    assert.equal(sharedSessionParts(), page.parts);
    assert.deepEqual(encodeSharedState(page.parts.handle), before);
    assert.deepEqual(page.parts.undo.sizes(), undo);
  } finally { page.close(); }
});

test("rule 74: automatic last-file resume never runs over the shared owner", async () => {
  const page = await share();
  try {
    const before = encodeSharedState(page.parts.handle), undo = page.parts.undo.sizes();
    await localFilesOwner().tryResumeLastProject();
    assert.deepEqual(encodeSharedState(page.parts.handle), before);
    assert.deepEqual(page.parts.undo.sizes(), undo);
    assert.equal(sharedSessionParts(), page.parts);
  } finally { page.close(); }
});
