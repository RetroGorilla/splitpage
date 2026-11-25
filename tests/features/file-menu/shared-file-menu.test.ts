import test from "node:test";
import assert from "node:assert/strict";
import { MERGE_TOO_LARGE_MESSAGE, createCollaborationState, localWriteErrorMessage } from "../../../src/application/collaboration/state.ts";
import { startFileMenu } from "../../../src/features/file-menu/file-menu.ts";
import type { FileMenuDropdownPorts } from "../../../src/features/file-menu/ports.ts";
import type { RecentFileData } from "../../../src/application/files/recent-files.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeNotices } from "../fakes.ts";
import { viewHarness } from "../view-harness.ts";

function setup() {
  const h = viewHarness();
  const realm = globalThis as unknown as Record<string, unknown>;
  const prevWindow = realm.window;
  const prevDocument = realm.document;
  realm.window = h.window;
  realm.document = h.document;

  const collab = createCollaborationState();
  const doc = migrateRows({ title: "Pilot Episode", docId: "d" + "a".repeat(32), rows: [{ id: "r1" }] }, fakeMigration().ports);
  const state = {
    document: doc,
    desktop: true
  };
  const ports: FileMenuDropdownPorts = {
    entry: { before: () => null },
    openingActivity: { track: work => work() },
    document: { current: () => state.document },
    place: { home: () => ({ kind: "none" }) },
    desktop: () => state.desktop,
    recents: {
      available: () => false,
      list: async () => [],
      routeOpen: async () => ({ where: "this-tab" }),
      read: async () => ({ id: "f1", name: "x.splitpage" }) as RecentFileData
    },
    recentHandle: () => ({ getFile: async () => new h.window.File([""], "x.splitpage") }),
    opening: { open: async () => true },
    transitions: { startNew: (arrival) => ({ document: "document" in arrival.from ? arrival.from.document : doc, forkedFrom: null, kept: false }) },
    history: { keep: () => null },
    notices: fakeNotices().notices,
    saves: { busy: () => false, unsaved: () => false },
    saving: { confirmSavedNow: () => {} },
    preferences: { defaultWpm: () => 180, clock: () => "24" },
    panels: { close: () => {} },
    resetProductionPanel: () => {},
    ids: { id: () => "r-new" },
    prepareDocument: (raw) => migrateRows(raw, fakeMigration().ports),
    syncIdentity: () => {},
    longDemo: { state: { title: "Demo", rows: [] } },
    collaboration: collab,
    collaborationItem: {
      group: "Collaborate",
      standalone: { id: "share-script", label: "Share this script…", available: () => true },
      shared: [{ id: "sharing-and-people", label: "Sharing & people…" }, { id: "leave-shared-script", label: "Leave shared script" }]
    }
  };
  const menu = startFileMenu(ports);
  return {
    ...h,
    collab,
    menu,
    cleanup() {
      menu.dispose();
      realm.window = prevWindow;
      realm.document = prevDocument;
      h.window.close();
    }
  };
}

test("File menu shows the shared card status and hides Autosave and Create bundle in shared mode", () => {
  const h = setup();
  try {
    const autosave = h.el("menu-autosave");
    const createBundle = h.document.querySelector<HTMLElement>('#file-menu [data-file-action="create-bundle"]');
    assert.ok(createBundle);

    const exists = (id: string) => !!h.document.querySelector(`#file-menu [data-file-action="${id}"]`);
    h.menu.toggleFileMenu(true);
    assert.equal(exists("share-script"), true);
    assert.equal(exists("sharing-and-people"), false);
    assert.equal(autosave.hidden, false);
    assert.equal(createBundle.hidden, false);
    assert.equal(h.el("fm-card-name").textContent, "Not saved yet");

    h.collab.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
    h.menu.refreshOpenFileMenu();
    assert.equal(exists("share-script"), false);
    assert.equal(exists("sharing-and-people"), true);
    assert.equal(exists("leave-shared-script"), true);
    assert.equal(autosave.hidden, true);
    assert.equal(createBundle.hidden, true);
    assert.equal(h.el("fm-card-name").textContent, "Pilot Episode");
    assert.equal(h.el("fm-card-meta").textContent, "Saved on this device · Shared script");

    h.collab.setPictures({ checking: 0, uploading: 1, downloading: 0 });
    h.menu.refreshOpenFileMenu();
    assert.equal(h.el("fm-card-meta").textContent, "Saved on this device · uploading pictures · Shared script");

    h.collab.setLocalWriteError({ reason: "quota", message: localWriteErrorMessage("quota") });
    h.menu.refreshOpenFileMenu();
    assert.equal(h.el("fm-card-meta").textContent, "Could not save on this device · Shared script");
    assert.ok(h.el("fm-card-meta").querySelector(".is-unsaved"));

    h.collab.setLocalWriteError(null);
    h.collab.setMergeTooLarge(MERGE_TOO_LARGE_MESSAGE);
    h.menu.refreshOpenFileMenu();
    assert.equal(h.el("fm-card-meta").textContent, "Too large to sync · local work kept · Shared script");

    h.collab.leave();
    h.menu.refreshOpenFileMenu();
    assert.equal(exists("leave-shared-script"), false);
    assert.equal(exists("share-script"), true);
    assert.equal(autosave.hidden, false);
    assert.equal(createBundle.hidden, false);
    assert.equal(h.el("fm-card-name").textContent, "Not saved yet");
  } finally {
    h.cleanup();
  }
});
