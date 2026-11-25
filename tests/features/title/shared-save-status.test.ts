import { test } from "node:test";
import assert from "node:assert/strict";
import { MERGE_TOO_LARGE_MESSAGE, createCollaborationState, localWriteErrorMessage } from "../../../src/application/collaboration/state.ts";
import type { Home } from "../../../src/application/location/document-location.ts";
import type { PreferenceName } from "../../../src/application/preferences/preferences.ts";
import { mountSaveStatus } from "../../../src/features/title/save-status.ts";
import { createSharedBanners } from "../../../src/features/title/shared-banners.ts";
import { mountFileCopyBanner } from "../../../src/features/collaboration/file-copy-banner.ts";
import { fakeFileCopy, fakeNotices, fakeSaveState } from "../fakes.ts";
import { viewHarness } from "../view-harness.ts";

const FORBIDDEN_SERVER_CLAIM = /saved\s+(to|on)\s+(the\s+)?(server|relay)/i;

function setup() {
  const h = viewHarness();
  const realm = globalThis as unknown as Record<string, unknown>;
  const prevWindow = realm.window;
  const prevDocument = realm.document;
  realm.window = h.window;
  realm.document = h.document;

  const collab = createCollaborationState();
  const save = fakeSaveState({ unsaved: false, busy: false });
  const notices = fakeNotices();
  const actions: string[] = [];

  const status = mountSaveStatus({
    saves: save.saves,
    autoSave: { policy: () => ({ halted: () => "", enabled: () => true }), target: () => "file" },
    place: { home: () => ({ kind: "file", handle: { name: "pilot.splitpage" } }) as Home },
    preferences: { clock: () => "24", nameOf: () => "clock" as PreferenceName },
    notices: notices.notices,
    drafts: { noteChange: () => {} },
    identity: { sync: () => {} },
    collaboration: collab
  });

  const banners = createSharedBanners(h.window, {
    collaboration: collab,
    exportCopy: () => { actions.push("exportCopy"); },
    leave: () => { actions.push("leave"); }
  });

  const stopCollab = collab.onChange(() => {
    status.listeners().collaboration?.();
    banners.sync();
  });

  return {
    ...h,
    collab,
    status,
    banners,
    actions,
    cleanup() {
      stopCollab();
      banners.dispose();
      status.dispose();
      realm.window = prevWindow;
      realm.document = prevDocument;
      h.window.close();
    }
  };
}

test("a file copy banner mounted after the title stays actionable in Writer", async t => {
  Reflect.set(globalThis, "SPLITPAGE_COLLAB_UI", true);
  const h = setup();
  const copy = fakeFileCopy();
  const overwrite = t.mock.fn(async () => {});
  const dispose = mountFileCopyBanner({
    ...copy.reads, overwrite, retry: async () => {}, saveAs: async () => {}, stop: async () => {}
  });
  try {
    h.collab.enter();
    const writer = h.el("writer");
    writer.hidden = false;
    h.banners.sync();
    copy.set({ file: { name: "Pilot.splitpage", docId: "d" + "a".repeat(32), missing: 0 }, problem: "changed" });
    const banner = h.el("file-copy-banner");
    assert.equal(banner.hidden, false);
    assert.equal(banner.closest("#writer-banners")?.parentElement, writer);
    banner.querySelector<HTMLButtonElement>("button:not([hidden])")?.click();
    await Promise.resolve();
    assert.equal(overwrite.mock.callCount(), 1);
    writer.hidden = true;
    h.banners.sync();
    assert.equal(h.el("root").contains(banner), true);
  } finally {
    dispose();
    h.cleanup();
    Reflect.deleteProperty(globalThis, "SPLITPAGE_COLLAB_UI");
  }
});

test("shared save status mirrors every state on #btn-save, #save-status, and #writer-collab-status", () => {
  const h = setup();
  try {
    const btn = h.document.getElementById("btn-save") as HTMLButtonElement;
    const line = h.el("save-status");
    const wrBtn = h.document.getElementById("writer-collab-status") as HTMLButtonElement;

    h.status.refresh();
    assert.equal(wrBtn.hidden, true);
    assert.equal(btn.hasAttribute("data-shared"), false);

    const cases: { run: () => void; label: string; state: string; actionable: boolean }[] = [
      {
        run: () => h.collab.enter({ localPending: true, relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } }),
        label: "Saving on this device…", state: "busy", actionable: false
      },
      {
        run: () => h.collab.setLocalPending(false),
        label: "Saved on this device", state: "ok", actionable: false
      },
      {
        run: () => h.collab.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 2 }),
        label: "Saved on this device · syncing", state: "pending", actionable: false
      },
      {
        run: () => {
          h.collab.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
          h.collab.setPictures({ checking: 0, uploading: 1, downloading: 0 });
        },
        label: "Saved on this device · uploading pictures", state: "pending", actionable: false
      },
      {
        run: () => {
          h.collab.setPictures({ checking: 0, uploading: 0, downloading: 0 });
          h.collab.setRelay({ connected: false, firstSyncDone: false, pendingChangeCount: 0 });
        },
        label: "Offline · saved on this device", state: "warn", actionable: false
      },
      {
        run: () => h.collab.setLocalWriteError({ reason: "quota", message: localWriteErrorMessage("quota"), code: "quota" }),
        label: "Could not save on this device", state: "warn", actionable: true
      },
      {
        run: () => {
          h.collab.setLocalWriteError(null);
          h.collab.setMergeTooLarge(MERGE_TOO_LARGE_MESSAGE);
        },
        label: "Too large to sync · local work kept", state: "warn", actionable: true
      },
      {
        run: () => {
          h.collab.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
          h.collab.setRefusal("access-removed");
        },
        label: "Access removed · local work kept", state: "warn", actionable: true
      }
    ];

    for (const c of cases) {
      c.run();
      assert.equal(btn.textContent, c.label);
      assert.equal(btn.getAttribute("data-status"), c.label);
      assert.equal(btn.getAttribute("data-state"), c.state);
      assert.equal(btn.getAttribute("data-actionable"), String(c.actionable));
      assert.equal(btn.getAttribute("data-shared"), "true");
      assert.equal(btn.disabled, !c.actionable);
      assert.equal(line.textContent, c.label);
      assert.equal(line.className, "save-status is-" + c.state);
      assert.equal(wrBtn.hidden, false);
      assert.equal(wrBtn.querySelector(".writer-collab-label")?.textContent, c.label);
      assert.equal(wrBtn.getAttribute("data-state"), c.state);
      assert.equal(wrBtn.getAttribute("data-actionable"), String(c.actionable));
      assert.equal(wrBtn.disabled, !c.actionable);
      assert.equal(FORBIDDEN_SERVER_CLAIM.test(btn.textContent ?? ""), false);
      assert.equal(FORBIDDEN_SERVER_CLAIM.test(btn.title), false);
    }

    h.collab.leave();
    assert.equal(wrBtn.hidden, true);
    assert.equal(btn.hasAttribute("data-shared"), false);
  } finally {
    h.cleanup();
  }
});

test("save failure, access removed, and merge-too-large banners open, dismiss, re-open, and stay visible inside Writer", () => {
  const h = setup();
  try {
    const writer = h.el("writer");
    const writerScroll = h.el("writer-scroll");
    const saveErrorBanner = h.el("save-error-banner");
    const accessBanner = h.el("collab-access-banner");
    const sizeBanner = h.el("collab-size-banner");
    const wrStatus = h.el("writer-collab-status");

    h.collab.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });

    writer.hidden = false;
    h.banners.sync();
    h.collab.setLocalWriteError({ reason: "quota", message: localWriteErrorMessage("quota"), code: "quota" });
    assert.equal(saveErrorBanner.hidden, false);
    assert.equal(writer.contains(saveErrorBanner), true);
    assert.equal(saveErrorBanner.closest("#writer-banners")?.nextElementSibling, writerScroll);
    assert.match(h.el("save-error-text").textContent ?? "", /storage space/i);

    saveErrorBanner.hidden = true;
    h.fire(wrStatus, "click");
    assert.equal(saveErrorBanner.hidden, false);
    assert.equal(writer.contains(saveErrorBanner), true);

    h.collab.setLocalWriteError(null);
    assert.equal(saveErrorBanner.hidden, true);

    h.collab.setRefusal("invitation-revoked");
    assert.equal(accessBanner.hidden, false);
    assert.equal(writer.contains(accessBanner), true);
    h.fire(h.el("collab-access-dismiss"), "click");
    assert.equal(accessBanner.hidden, true);
    h.banners.openRecovery();
    assert.equal(accessBanner.hidden, false);
    h.fire(h.el("collab-access-export"), "click");
    h.fire(h.el("collab-access-leave"), "click");
    assert.deepEqual(h.actions, ["exportCopy", "leave"]);

    h.actions.length = 0;
    h.collab.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
    assert.equal(accessBanner.hidden, true);
    h.collab.setMergeTooLarge(MERGE_TOO_LARGE_MESSAGE);
    assert.equal(sizeBanner.hidden, false);
    assert.equal(writer.contains(sizeBanner), true);
    assert.equal(h.el("collab-size-text").textContent, MERGE_TOO_LARGE_MESSAGE);
    h.fire(h.el("collab-size-export"), "click");
    h.fire(h.el("collab-size-leave"), "click");
    assert.deepEqual(h.actions, ["exportCopy", "leave"]);

    writer.hidden = true;
    h.banners.sync();
    assert.equal(writer.contains(sizeBanner), false);
    assert.equal(h.el("root").contains(sizeBanner), true);

    h.collab.leave();
    assert.equal(sizeBanner.hidden, true);
    assert.equal(accessBanner.hidden, true);
    assert.equal(saveErrorBanner.hidden, true);
  } finally {
    h.cleanup();
  }
});

test("entering shared mode hides any stale standalone save-error banner and derived view deduplicates unchanged repaints", () => {
  const h = setup();
  try {
    const saveErrorBanner = h.el("save-error-banner");
    const btn = h.document.getElementById("btn-save") as HTMLButtonElement;
    saveErrorBanner.hidden = false;
    h.el("save-error-text").textContent = "Stale standalone failure";

    h.collab.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 1 } });
    assert.equal(saveErrorBanner.hidden, true);
    assert.equal(btn.textContent, "Saved on this device · syncing");

    let mutations = 0;
    const origSetAttribute = btn.setAttribute.bind(btn);
    btn.setAttribute = (...args: [string, string]) => { mutations++; origSetAttribute(...args); };
    h.collab.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 2 });
    h.collab.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 3 });
    assert.equal(mutations, 0);
  } finally {
    h.cleanup();
  }
});
