import assert from "node:assert/strict";
import { test } from "node:test";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { Doc } from "yjs";
import { bindNativePresence } from "../../../../src/adapters/collab/native/presence.ts";
import type { PresencePeer, PresenceProfile } from "../../../../src/application/collaboration/presence.ts";

test("presence coalesces local changes, accepts validated remote state, and clears on destroy", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = new Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({ url: "ws://127.0.0.1:1", autoConnect: false });
  const provider = new HocuspocusProvider({ document: doc, websocketProvider, name: "presence" });
  const remoteDoc = new Doc();
  const remote = new Awareness(remoteDoc);
  t.after(() => { provider.destroy(); websocketProvider.destroy(); doc.destroy(); remoteDoc.destroy(); });

  const peerUpdates: (readonly PresencePeer[])[] = [];
  const publish = bindNativePresence(provider, peers => peerUpdates.push(peers));
  const first = { name: "Ada", color: "#80BDFB", view: "split", beat: "a", side: "audioText" } satisfies PresenceProfile;
  const last = { ...first, beat: "b", side: "visualText" } satisfies PresenceProfile;
  publish(first);
  publish(last);
  assert.equal(provider.awareness?.getLocalState()?.splitpagePresence, undefined);
  t.mock.timers.tick(200);
  assert.deepEqual(provider.awareness?.getLocalState()?.splitpagePresence, last);
  assert.deepEqual(peerUpdates, []);
  assert.deepEqual([...doc.share], []);

  const awareness = provider.awareness as Awareness;
  function send(value: unknown) {
    remote.setLocalStateField("splitpagePresence", value);
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), "test");
  }

  send({ ...first, color: "red; display:none" });
  assert.deepEqual(peerUpdates.at(-1), []);
  send(first);
  assert.deepEqual(peerUpdates.at(-1), [{ ...first, clientId: remote.clientID }]);
  removeAwarenessStates(remote, [remote.clientID], "test");
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), "test");
  assert.deepEqual(peerUpdates.at(-1), []);
});
