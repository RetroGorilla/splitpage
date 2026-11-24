import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_COLLABORATION_SNAPSHOT,
  MERGE_TOO_LARGE_MESSAGE,
  PERMANENT_COLLABORATION_REFUSALS,
  accessRemovedMessage,
  createCollaborationState,
  isPermanentCollaborationRefusal,
  localWriteErrorMessage
} from "../../../src/application/collaboration/state.ts";
import { sharedSaveStatus } from "../../../src/application/save/status.ts";

const FORBIDDEN_SERVER_CLAIM = /saved\s+(to|on)\s+(the\s+)?(server|relay)/i;

test("collaboration state starts idle, ignores writes while inactive, and resets cleanly on leave", () => {
  const owner = createCollaborationState();
  const seen: boolean[] = [];
  const stop = owner.onChange(snap => seen.push(snap.active));
  assert.equal(owner.snapshot(), IDLE_COLLABORATION_SNAPSHOT);
  assert.equal(Object.isFrozen(owner.snapshot()), true);
  owner.setLocalPending(true);
  owner.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 2 });
  owner.setPictures({ checking: 1, uploading: 1, downloading: 1 });
  owner.setRefusal("access-removed");
  owner.setMergeTooLarge("too big");
  assert.deepEqual(seen, []);
  assert.equal(owner.snapshot().active, false);

  owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
  assert.equal(owner.snapshot().active, true);
  assert.equal(owner.snapshot().relay.connected, true);
  owner.setLocalPending(true);
  owner.setLocalPending(true);
  owner.leave();
  assert.equal(owner.snapshot(), IDLE_COLLABORATION_SNAPSHOT);
  stop();
});

test("throwing collaboration listeners do not stop subsequent subscribers", () => {
  const owner = createCollaborationState();
  const calls: string[] = [];
  owner.onChange(() => { calls.push("first"); throw new Error("boom"); });
  owner.onChange(snap => { calls.push("second:" + snap.active); });
  owner.enter();
  assert.deepEqual(calls, ["first", "second:true"]);
});

test("sharedSaveStatus matches every row of the save status wording table and never claims saved to server", () => {
  const owner = createCollaborationState();
  owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });

  const checks: { name: string; setup: () => void; label: string; state: string; actionable: boolean; banner: string | null }[] = [
    {
      name: "saved on this device",
      setup: () => {
        owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
      },
      label: "Saved on this device",
      state: "ok",
      actionable: false,
      banner: null
    },
    {
      name: "saving on this device (local write pending)",
      setup: () => {
        owner.enter({ localPending: true, relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
      },
      label: "Saving on this device…",
      state: "busy",
      actionable: false,
      banner: null
    },
    {
      name: "saving on this device (local picture check pending)",
      setup: () => {
        owner.enter({
          relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 },
          pictures: { checking: 1, uploading: 0, downloading: 0 }
        });
      },
      label: "Saving on this device…",
      state: "busy",
      actionable: false,
      banner: null
    },
    {
      name: "syncing pending text changes",
      setup: () => {
        owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 3 } });
      },
      label: "Saved on this device · syncing",
      state: "pending",
      actionable: false,
      banner: null
    },
    {
      name: "syncing before first sync completes",
      setup: () => {
        owner.enter({ relay: { connected: true, firstSyncDone: false, pendingChangeCount: 0 } });
      },
      label: "Saved on this device · syncing",
      state: "pending",
      actionable: false,
      banner: null
    },
    {
      name: "uploading pictures",
      setup: () => {
        owner.enter({
          relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 },
          pictures: { checking: 0, uploading: 2, downloading: 0 }
        });
      },
      label: "Saved on this device · uploading pictures",
      state: "pending",
      actionable: false,
      banner: null
    },
    {
      name: "downloading pictures",
      setup: () => {
        owner.enter({
          relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 },
          pictures: { checking: 0, uploading: 0, downloading: 1 }
        });
      },
      label: "Saved on this device · syncing",
      state: "pending",
      actionable: false,
      banner: null
    },
    {
      name: "offline",
      setup: () => {
        owner.enter({ relay: { connected: false, firstSyncDone: false, pendingChangeCount: 1 } });
      },
      label: "Offline · saved on this device",
      state: "warn",
      actionable: false,
      banner: null
    },
    {
      name: "could not save on this device",
      setup: () => {
        owner.enter({
          localPending: true,
          localWriteError: { reason: "quota", message: localWriteErrorMessage("quota"), code: "quota" },
          relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 }
        });
      },
      label: "Could not save on this device",
      state: "warn",
      actionable: true,
      banner: "save-error"
    },
    {
      name: "too large to sync",
      setup: () => {
        owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
        owner.setMergeTooLarge(MERGE_TOO_LARGE_MESSAGE);
      },
      label: "Too large to sync · local work kept",
      state: "warn",
      actionable: true,
      banner: "merge-too-large"
    },
    {
      name: "access removed",
      setup: () => {
        owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
        owner.setRefusal("access-removed");
      },
      label: "Access removed · local work kept",
      state: "warn",
      actionable: true,
      banner: "access-removed"
    }
  ];

  for (const row of checks) {
    row.setup();
    const view = sharedSaveStatus(owner.snapshot());
    assert.equal(view.label, row.label, row.name);
    assert.equal(view.state, row.state, row.name);
    assert.equal(view.actionable, row.actionable, row.name);
    assert.equal(view.banner, row.banner, row.name);
    assert.equal(FORBIDDEN_SERVER_CLAIM.test(view.label), false, row.name + " label");
    assert.equal(FORBIDDEN_SERVER_CLAIM.test(view.title), false, row.name + " title");
    assert.equal(FORBIDDEN_SERVER_CLAIM.test(view.bannerMessage), false, row.name + " banner");
  }
});

test("every permanent refusal produces Access removed and stops showing offline or saved", () => {
  const owner = createCollaborationState();
  for (const reason of PERMANENT_COLLABORATION_REFUSALS) {
    assert.equal(isPermanentCollaborationRefusal(reason), true, reason);
    owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
    owner.setRefusal(reason);
    assert.equal(owner.snapshot().relay.connected, false);
    const view = sharedSaveStatus(owner.snapshot());
    assert.equal(view.label, "Access removed · local work kept");
    assert.equal(view.state, "warn");
    assert.equal(view.actionable, true);
    assert.equal(view.banner, "access-removed");
    assert.equal(view.bannerMessage, accessRemovedMessage(reason));
    assert.equal(FORBIDDEN_SERVER_CLAIM.test(view.bannerMessage), false);
    owner.setRelay({ connected: false, firstSyncDone: false, pendingChangeCount: 0 });
    assert.equal(sharedSaveStatus(owner.snapshot()).label, "Access removed · local work kept");
  }
  assert.equal(isPermanentCollaborationRefusal("rate-limited"), false);
  assert.equal(isPermanentCollaborationRefusal("too-many-connections"), false);
});

test("a merge over the 15 MB limit never shows as offline or saved", () => {
  const owner = createCollaborationState();
  owner.enter({ relay: { connected: true, firstSyncDone: true, pendingChangeCount: 0 } });
  owner.setMergeTooLarge(MERGE_TOO_LARGE_MESSAGE);
  assert.equal(owner.snapshot().relay.connected, false);
  assert.equal(sharedSaveStatus(owner.snapshot()).label, "Too large to sync · local work kept");

  owner.setRelay({ connected: false, firstSyncDone: false, pendingChangeCount: 5 });
  assert.equal(sharedSaveStatus(owner.snapshot()).label, "Too large to sync · local work kept");

  owner.setRelay({ connected: true, firstSyncDone: true, pendingChangeCount: 0 });
  assert.equal(sharedSaveStatus(owner.snapshot()).label, "Too large to sync · local work kept");

  owner.setPictures({ checking: 0, uploading: 2, downloading: 1 });
  assert.equal(sharedSaveStatus(owner.snapshot()).label, "Too large to sync · local work kept");

  owner.setLocalPending(true);
  assert.equal(sharedSaveStatus(owner.snapshot()).label, "Too large to sync · local work kept");
});

test("local write error messages cover all storage failure reasons without server wording", () => {
  for (const reason of ["quota", "closed", "version", "locked", "blocked", "io", "unavailable"]) {
    const text = localWriteErrorMessage(reason);
    assert.ok(text.length > 0);
    assert.equal(/Couldn['’]t/.test(text), false, reason);
    assert.equal(FORBIDDEN_SERVER_CLAIM.test(text), false, reason);
  }
});
