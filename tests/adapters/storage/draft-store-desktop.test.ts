import { test } from "node:test";
import assert from "node:assert/strict";
import { createDesktopDraftStore } from "../../../src/adapters/storage/draft-store-desktop.ts";
import type { DesktopDraftBridge } from "../../../src/adapters/storage/draft-store-desktop.ts";

test("the desktop draft store is the existing IPC: write and discard go to the bridge as they are", async () => {
  const sent: unknown[] = [];
  const bridge: DesktopDraftBridge = {
    writeDraft: function (payload) { sent.push(["write", payload]); return Promise.resolve({ ok: false, code: "STALE_SEQ" }); },
    discardDraft: function (seq) { sent.push(["discard", seq]); return Promise.resolve({ ok: true }); }
  };
  const store = createDesktopDraftStore({ bridge: () => bridge });
  assert.equal(store.writable(), true);
  assert.equal(store.canDiscard(), true);
  const payload = { seq: 4, stateJson: "{}" };
  assert.deepEqual(await store.write(payload), { ok: false, code: "STALE_SEQ" }, "main's answer comes back unchanged");
  assert.deepEqual(await store.discard(5), { ok: true });
  assert.deepEqual(sent, [["write", payload], ["discard", 5]]);
});

test("the bridge is read at each call, so a page that gains or loses it is seen", () => {
  let bridge: DesktopDraftBridge | null = null;
  const store = createDesktopDraftStore({ bridge: () => bridge });
  assert.equal(store.writable(), false);
  assert.equal(store.canDiscard(), false);
  assert.throws(() => store.write({}), /no desktop bridge/);
  bridge = { writeDraft: () => Promise.resolve({ ok: true }) };
  assert.equal(store.writable(), true);
  assert.equal(store.canDiscard(), false, "a bridge without discardDraft cannot discard");
  assert.throws(() => store.discard(1), /cannot discard/);
});

test("taking a draft, reporting the restore and the pending-draft flag go to the bridge as they are", async () => {
  const done: string[] = [];
  const bridge: DesktopDraftBridge = {
    takeDraft: function (this: DesktopDraftBridge) { return Promise.resolve(this === bridge ? "taken" : "wrong this"); },
    draftRestoreDone: function (outcome) { done.push(outcome); },
    hasDraftToRestore: true
  };
  const store = createDesktopDraftStore({ bridge: () => bridge });
  const take = store.taker();
  assert.ok(take);
  assert.equal(await take(), "taken", "takeDraft is called on the bridge it came from");
  store.restoreDone("applied");
  assert.deepEqual(done, ["applied"]);
  assert.equal(store.hasDraftToRestore(), true);
});

test("without those members, or without a bridge, there is nothing to take, report or restore", () => {
  let bridge: DesktopDraftBridge | null = null;
  const store = createDesktopDraftStore({ bridge: () => bridge });
  assert.equal(store.taker(), null);
  store.restoreDone("applied");
  assert.equal(store.hasDraftToRestore(), false);
  bridge = { writeDraft: () => Promise.resolve({ ok: true }) };
  assert.equal(store.taker(), null);
  store.restoreDone("applied");
  assert.equal(store.hasDraftToRestore(), false);
});