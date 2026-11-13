import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityPortCallers } from "./capability-caller-scan.ts";

const DRAFTS = {
  "application/recovery/ports.ts#DesktopDraftStore.write": { "application/recovery/drafts.ts": 1 },
  "application/recovery/ports.ts#DesktopDraftStore.discard": { "application/recovery/drafts.ts": 1 },
  "application/recovery/ports.ts#DesktopDraftStore.taker": { "application/recovery/drafts.ts": 1, "bootstrap/wiring/drafts.ts": 1 },
  "application/recovery/ports.ts#DesktopDraftStore.restoreDone": { "application/recovery/drafts.ts": 1 },
  "application/recovery/drafts.ts#startDrafts": { "bootstrap/wiring/drafts.ts": 1 },
  "application/recovery/drafts-ports.ts#DraftsMount.flush": { "bootstrap/wiring/drafts.ts": 4 },
  "application/recovery/drafts-ports.ts#DraftsMount.noteChange": {
    "application/save/session-effects.ts": 1, "bootstrap/wiring/drafts.ts": 1, "features/title/save-status.ts": 1
  },
  "application/recovery/drafts-ports.ts#DraftsMount.taker": { "bootstrap/wiring/drafts.ts": 1 },
  "application/recovery/drafts-ports.ts#DraftsMount.applyTaken": { "bootstrap/wiring/drafts.ts": 1 },
  "application/recovery/drafts-ports.ts#DraftsPorts.transitions": { "application/recovery/drafts.ts": 1 },
  "application/recovery/drafts-ports.ts#DraftsPorts.identity.copyHistory": { "application/recovery/drafts.ts": 1 },
  "bootstrap/wiring/recovery-owners.ts#desktopDrafts": { "bootstrap/wiring/drafts.ts": 1 },
  "bootstrap/wiring/recovery-owners.ts#flushDraftNow": { "bootstrap/wiring/desktop.ts": 1 },
  "bootstrap/wiring/drafts.ts#draftTaker": { "bootstrap/wiring/startup.ts": 1 },
  "bootstrap/wiring/drafts.ts#applyTakenDraft": { "bootstrap/wiring/startup.ts": 1 }
};

const HISTORY = {
  "application/recovery/history-ports.ts#HistoryOwner.captureSnapshot": {
    "application/recovery/history.ts": 1, "application/session/session-merge.ts": 3, "bootstrap/wiring/ports/session-merge.ts": 1
  },
  "application/recovery/history-ports.ts#HistoryOwner.copyHistory": {
    "application/identity/document-identity.ts": 2, "application/recovery/history.ts": 1, "bootstrap/wiring/ports/document-identity.ts": 1
  },
  "application/recovery/history-ports.ts#HistoryOwner.historyDocumentChanged": {
    "application/identity/document-identity.ts": 2, "application/recovery/history.ts": 1, "bootstrap/wiring/ports/document-identity.ts": 1
  },
  "application/recovery/history-ports.ts#HistoryOwner.importHistoryBundle": {
    "adapters/storage/history-owner-testing.ts": 1, "application/recovery/history.ts": 1, "bootstrap/wiring/settings.ts": 1
  },
  "application/recovery/history-ports.ts#HistoryOwner.startHistoryMigration": {
    "adapters/storage/history-owner-testing.ts": 1, "application/recovery/history.ts": 1, "bootstrap/wiring/startup.ts": 1
  },
  "application/recovery/history-ports.ts#HistoryResolvedBackend.put": { "application/recovery/history.ts": 2 },
  "application/recovery/history-ports.ts#HistoryResolvedBackend.copy": { "application/recovery/history.ts": 1 },
  "application/recovery/history-ports.ts#HistoryResolvedBackend.touch": { "application/recovery/history.ts": 2 },
  "application/recovery/history-ports.ts#HistoryResolvedBackend.importOlder": { "application/recovery/history.ts": 2 },
  "application/recovery/history-ports.ts#HistoryDesktopPort.historyPut": { "adapters/desktop/fake-desktop.ts": 1, "adapters/storage/history-backends.ts": 3 },
  "application/recovery/history-ports.ts#HistoryDesktopPort.historyCopy": { "adapters/desktop/fake-desktop.ts": 1, "adapters/storage/history-backends.ts": 1 },
  "application/recovery/history-ports.ts#HistoryDesktopPort.historyTouch": { "adapters/desktop/fake-desktop.ts": 1, "adapters/storage/history-backends.ts": 1 },
  "application/session/session-merge-ports.ts#SessionMergeOwner.restoreMergeSnapshot": {
    "bootstrap/wiring/history-panel.ts": 1, "bootstrap/wiring/session-merge.ts": 1, "features/history/panel.ts": 2
  },
  "bootstrap/wiring/session-merge.ts#restoreMergeSnapshot": { "bootstrap/wiring/editor.ts": 1 },
  "features/history/ports.ts#HistoryPanelControl.restoreSnapshotFromCard": { "bootstrap/wiring/history-panel.ts": 1 },
  "bootstrap/wiring/history-panel.ts#restoreSnapshotFromCard": { "bootstrap/wiring/views.ts": 1 },
  "features/gallery/mount.ts#HistoryGalleryPorts.restore": { "features/gallery/mount.ts": 1 }
};

let inventory: ReturnType<typeof capabilityPortCallers> | null = null;

function current() {
  inventory ??= capabilityPortCallers([...Object.keys(DRAFTS), ...Object.keys(HISTORY)], undefined, { references: true });
  return inventory;
}

for (const [family, expected] of [["drafts", DRAFTS], ["history", HISTORY]] as const) {
  test(family + " writers and restore paths stay at the audited capability boundaries", () => {
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, current()[key]])), expected);
  });
}
