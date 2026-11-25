import assert from "node:assert/strict";
import { test } from "node:test";
import { createPresenceState } from "../../../src/application/collaboration/presence.ts";
import type { PresenceProfile } from "../../../src/application/collaboration/presence.ts";

const profile: PresenceProfile = { name: "Ada", color: "#80BDFB", view: "split", beat: "r1", side: "audioText", caret: null };
const peer = { clientId: 42, ...profile };

test("a replacement binding receives the local profile and ignores replies and disposal from the previous binding", () => {
  const store = createPresenceState();
  const sent: PresenceProfile[] = [];
  const send = (next: PresenceProfile) => { sent.push(next); };
  const changes: number[] = [];
  const unsubscribe = store.onChange(() => changes.push(store.peers().length));
  store.setLocal(profile);
  const first = store.bind(send);
  first.receive([peer]);
  const second = store.bind(send);
  first.dispose();
  first.receive([peer]);
  assert.deepEqual(store.peers(), []);
  assert.deepEqual(sent, [profile, profile]);

  second.receive([peer]);
  const next = { ...profile, beat: "r2" };
  store.setLocal(next);
  assert.deepEqual(sent, [profile, profile, next]);
  assert.deepEqual(store.peers(), [peer]);
  second.dispose();
  second.receive([peer]);
  assert.deepEqual(store.peers(), []);
  assert.deepEqual(changes, [1, 0, 1, 0]);

  unsubscribe();
  const third = store.bind(send);
  assert.deepEqual(sent, [profile, profile, next]);
  third.receive([peer]);
  assert.deepEqual(changes, [1, 0, 1, 0]);
});
