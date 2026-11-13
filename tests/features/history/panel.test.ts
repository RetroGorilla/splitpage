import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHistoryPanel } from "../../../src/features/history/panel.ts";
import type { HistoryPanelControl, HistoryPanelPorts } from "../../../src/features/history/ports.ts";
import type { SnapshotRestoreRequest, SnapshotRestoreResult } from "../../../src/application/session/session-merge-ports.ts";
import type { HistoryOwner } from "../../../src/application/recovery/history-ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeNotices } from "../fakes.ts";

type Listing = Awaited<ReturnType<HistoryOwner["listDocHistory"]>>;

function setup() {
  document.body.innerHTML = '<div id="history-panel" hidden><p id="history-subtitle"></p><div id="history-list"></div><div id="history-older"><span id="history-older-count"></span><div id="history-older-list"></div></div><div id="history-usage"></div></div>';
  const migration = fakeMigration().ports;
  const reader = fakeDocument(migrateRows({ title: "Test", docId: "d-test", rows: [] }, migration));
  const notices = fakeNotices();
  const requests: { id: string; request: SnapshotRestoreRequest | undefined }[] = [];
  let answer: SnapshotRestoreResult = "no-backup";
  let shared = false;
  const listing: Listing = {
    entries: [{ id: "s1", label: "Before merge", title: "Test", by: "Ann", rows: 2, sizeBytes: 1024, at: "2026-01-01T12:00:00Z", atMs: 1767268800000, kind: "snapshot", formatVersion: 1 }],
    older: [], olderExpiresAt: null, backend: "idb", persistent: true, notice: null,
    usage: { totalBytes: 1024, capBytes: 10240, docCount: 1 }
  };
  let load = () => Promise.resolve(listing);
  const ports: HistoryPanelPorts = {
    capability: { history: () => shared ? { allowed: false, reason: "Earlier versions cannot replace a shared session." } : { allowed: true } },
    history: { listDocHistory: () => load() }, document: reader.document,
    merge: { restoreMergeSnapshot: async (id, request) => { requests.push({ id, request }); return answer; } },
    panels: {
      open: () => { (document.getElementById("history-panel") as HTMLElement).hidden = false; },
      close: () => { (document.getElementById("history-panel") as HTMLElement).hidden = true; }
    },
    effects: notices.notices, preferences: { clock: () => "24", editorName: () => "Ann" },
    personColors: { personColor: () => "#123456" }, ids: migration.ids
  };
  const owner: HistoryPanelControl = startHistoryPanel(ports);
  return { owner, reader, notices, requests, listing, answer: (value: SnapshotRestoreResult) => { answer = value; }, share: () => { shared = true; }, load: (value: typeof load) => { load = value; } };
}

test("the history panel renders owner records and only forces a restore after its backup refusal", async () => {
  const f = setup();
  f.owner.openHistoryPanel();
  await f.owner.renderHistory();
  assert.match(document.getElementById("history-subtitle")?.textContent ?? "", /kept in this browser/);
  assert.equal(document.querySelectorAll(".history-card").length, 1);
  assert.match(document.getElementById("history-list")?.textContent ?? "", /Before merge/);
  assert.match(document.getElementById("history-list")?.textContent ?? "", /Ann/);
  assert.match(document.getElementById("history-usage")?.textContent ?? "", /across 1 document/);
  const button = document.querySelector('[data-action="restore-snapshot"]') as HTMLButtonElement;
  assert.equal(await f.owner.restoreSnapshotFromCard(button), "no-backup");
  assert.ok(button.classList.contains("armed"));
  assert.match(button.textContent ?? "", /restore anyway/);
  f.answer("restored");
  assert.equal(await f.owner.restoreSnapshotFromCard(button), "restored");
  assert.deepEqual(f.requests, [
    { id: "s1", request: { older: false, force: false } },
    { id: "s1", request: { older: false, force: true } }
  ]);
  f.owner.toastLastEditor({ lastEditedBy: "Ann" });
  f.owner.toastLastEditor({ lastEditedBy: "Bea" });
  assert.deepEqual(f.notices.shown.map((item) => item.message), ["Opened the latest version — last edited by Bea"]);
  f.owner.dispose();
  assert.throws(() => f.owner.openHistoryPanel(), /not started/);
});

test("a history listing that finishes after disposal cannot repaint a new mount", async () => {
  const f = setup();
  let resolve!: (value: Listing) => void;
  f.load(() => new Promise<Listing>((done) => { resolve = done; }));
  (document.getElementById("history-panel") as HTMLElement).hidden = false;
  const rendering = f.owner.renderHistory();
  f.owner.dispose();
  const remounted = setup();
  resolve(f.listing);
  await rendering;
  assert.equal(document.getElementById("history-list")?.innerHTML, "");
  await remounted.owner.renderHistory();
  assert.equal(document.getElementById("history-list")?.innerHTML, "");
  remounted.owner.dispose();
});

test("damaged history is visible beside intact versions and never reads as no history", async () => {
  const f = setup();
  Object.assign(f.listing, { damaged: 2, olderDamaged: 1 });
  f.owner.openHistoryPanel();
  await f.owner.renderHistory();
  assert.match(document.getElementById("history-list")?.textContent ?? "", /2 damaged snapshots could not be listed/);
  assert.equal(document.querySelectorAll('[data-action="restore-snapshot"]').length, 1);
  assert.match(document.getElementById("history-older-list")?.textContent ?? "", /1 damaged snapshot could not be listed/);
  assert.equal(document.getElementById("history-older")?.hidden, false);
  f.listing.entries = [];
  await f.owner.renderHistory();
  assert.doesNotMatch(document.getElementById("history-list")?.textContent ?? "", /No snapshots/);
  assert.match(document.getElementById("history-list")?.textContent ?? "", /damaged/);
  f.owner.dispose();
});

test("a restore result that arrives after disposal cannot arm or notify from the old panel", async () => {
  const f = setup();
  f.owner.openHistoryPanel();
  await f.owner.renderHistory();
  const button = document.querySelector('[data-action="restore-snapshot"]') as HTMLButtonElement;
  const restoring = f.owner.restoreSnapshotFromCard(button);
  f.owner.dispose();
  assert.equal(await restoring, "no-backup");
  assert.equal(button.classList.contains("armed"), false);
  assert.deepEqual(f.notices.shown, []);
});

test("a restore the shared session refuses shows the reason once and arms nothing", async () => {
  const f = setup();
  f.owner.openHistoryPanel();
  await f.owner.renderHistory();
  const button = document.querySelector('[data-action="restore-snapshot"]') as HTMLButtonElement;
  f.share();
  f.answer("refused");
  assert.equal(await f.owner.restoreSnapshotFromCard(button), "refused");
  assert.equal(button.classList.contains("armed"), false);
  assert.deepEqual(f.notices.shown.map((item) => [item.message, item.kind]), [["Earlier versions cannot replace a shared session.", "warn"]]);
  f.owner.dispose();
});
