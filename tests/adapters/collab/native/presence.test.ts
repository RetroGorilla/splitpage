import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { Doc } from "yjs";
import { bindNativePresence } from "../../../../src/adapters/collab/native/presence.ts";
import type { PresenceCaret, PresencePeer, PresenceProfile } from "../../../../src/application/collaboration/presence.ts";

function presenceHarness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = new Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({ url: "ws://127.0.0.1:1", autoConnect: false });
  const provider = new HocuspocusProvider({ document: doc, websocketProvider, name: "presence" });
  const remoteDoc = new Doc();
  const remote = new Awareness(remoteDoc);
  t.after(() => { provider.destroy(); websocketProvider.destroy(); doc.destroy(); remoteDoc.destroy(); });
  const peerUpdates: (readonly PresencePeer[])[] = [];
  const publish = bindNativePresence(provider, peers => peerUpdates.push(peers));
  const awareness = provider.awareness as Awareness;
  function send(value: unknown) {
    remote.setLocalStateField("splitpagePresence", value);
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), "test");
  }
  return { doc, provider, remote, awareness, peerUpdates, publish, send };
}

const caret: PresenceCaret = {
  anchor: { type: { client: 7, clock: 3 }, item: { client: 7, clock: 9 }, assoc: 0 },
  head: { type: { client: 7, clock: 3 }, item: null, assoc: -1 }
};

test("presence coalesces local changes, accepts validated remote state, and clears on destroy", t => {
  const { doc, provider, remote, awareness, peerUpdates, publish, send } = presenceHarness(t);
  const first = { name: "Ada", color: "#80BDFB", view: "split", beat: "a", side: "audioText", caret: null } satisfies PresenceProfile;
  const last = { ...first, beat: "b", side: "visualText" } satisfies PresenceProfile;
  publish(first);
  publish(last);
  assert.equal(provider.awareness?.getLocalState()?.splitpagePresence, undefined);
  t.mock.timers.tick(200);
  assert.deepEqual(provider.awareness?.getLocalState()?.splitpagePresence, last);
  assert.deepEqual(peerUpdates, []);
  assert.deepEqual([...doc.share], []);

  send({ ...first, color: "red; display:none" });
  assert.deepEqual(peerUpdates.at(-1), []);
  send(first);
  assert.deepEqual(peerUpdates.at(-1), [{ ...first, clientId: remote.clientID }]);
  removeAwarenessStates(remote, [remote.clientID], "test");
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), "test");
  assert.deepEqual(peerUpdates.at(-1), []);
});

test("a caret travels as two relative positions, and a moved caret alone is sent again", t => {
  const { doc, provider, remote, peerUpdates, publish, send } = presenceHarness(t);
  const here = { name: "Ada", color: "#80BDFB", view: "writer", beat: "r1", side: "audioText", caret } satisfies PresenceProfile;
  publish(here);
  t.mock.timers.tick(200);
  assert.deepEqual(provider.awareness?.getLocalState()?.splitpagePresence, here);
  publish({ ...here, caret: structuredClone(caret) });
  t.mock.timers.tick(200);
  const moved = { ...here, caret: { ...caret, head: { ...caret.head, assoc: 0 as const } } };
  publish(moved);
  t.mock.timers.tick(200);
  assert.deepEqual(provider.awareness?.getLocalState()?.splitpagePresence, moved);
  assert.deepEqual([...doc.share], []);

  send(here);
  assert.deepEqual(peerUpdates.at(-1), [{ ...here, clientId: remote.clientID }]);
  send({ name: here.name, color: here.color, view: here.view, beat: here.beat, side: here.side });
  assert.deepEqual(peerUpdates.at(-1), [{ ...here, caret: null, clientId: remote.clientID }]);
});

test("a peer's caret and beat are checked strictly and a malformed one hides that peer", t => {
  const { doc, remote, peerUpdates, send } = presenceHarness(t);
  const here = { name: "Ada", color: "#80BDFB", view: "split", beat: "r1", side: "visualText", caret } satisfies PresenceProfile;
  const point = caret.anchor;
  const malformed: unknown[] = [
    { ...here, beat: null, side: null },
    { ...here, beat: "r1\n" },
    { ...here, beat: "r" + String.fromCharCode(0) + "1" },
    { ...here, beat: "r1" + String.fromCharCode(127) },
    { ...here, caret: "anchor" },
    { ...here, caret: [] },
    { ...here, caret: { anchor: point } },
    { ...here, caret: { anchor: point, head: point, extra: point } },
    { ...here, caret: { anchor: { ...point, tname: "meta" }, head: point } },
    { ...here, caret: { anchor: { type: point.type, assoc: 0 }, head: point } },
    { ...here, caret: { anchor: { ...point, assoc: 1 }, head: point } },
    { ...here, caret: { anchor: { ...point, type: { client: -1, clock: 0 } }, head: point } },
    { ...here, caret: { anchor: { ...point, type: { client: 1, clock: 0.5 } }, head: point } },
    { ...here, caret: { anchor: { ...point, type: { client: 1, clock: 2, extra: 3 } }, head: point } },
    { ...here, caret: { anchor: { ...point, item: { client: 1 } }, head: point } },
    { ...here, caret: { anchor: { ...point, type: null }, head: point } }
  ];
  for (const value of malformed) {
    send(here);
    assert.equal(peerUpdates.at(-1)?.length, 1);
    send(value);
    assert.deepEqual(peerUpdates.at(-1), [], JSON.stringify(value));
  }
  send({ ...here, beat: null, side: null, caret: null });
  assert.deepEqual(peerUpdates.at(-1), [{ ...here, beat: null, side: null, caret: null, clientId: remote.clientID }]);
  assert.deepEqual([...doc.share], []);
});
