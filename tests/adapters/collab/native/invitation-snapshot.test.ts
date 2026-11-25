import assert from "node:assert/strict";
import { test } from "node:test";
import { messageYjsSyncStep2 } from "y-protocols/sync";
import { readInvitationSnapshot } from "../../../../src/adapters/collab/native/invitation-snapshot.ts";
import { openRelayFixture, relayFrameType, seedRelaySession } from "./relay-harness.ts";

for (const variant of ["restart", "stall", "cancel"] as const) {
  test("invitation snapshot " + variant, { timeout: 6000 }, async t => {
    const source = seedRelaySession();
    const state = source.encodeState();
    source.close();
    const fixture = await openRelayFixture(t, { async onAuthenticate() {}, async onLoadDocument() { return state; } });
    const bridge = fixture.bridge();
    bridge.configure = link => {
      if (bridge.links.length === 1 || variant !== "restart") {
        link.download = (frame, forward) => { if (relayFrameType(frame) !== messageYjsSyncStep2) forward(); };
      }
    };
    const url = await bridge.listen();
    const cancel = new AbortController();
    const joining = readInvitationSnapshot(url, "script", "", cancel.signal, variant === "stall" ? 150 : 2_000);
    const result = variant === "restart" ? joining : assert.rejects(joining,
      variant === "stall" ? { reason: "script-too-large-for-connection" } : { name: "AbortError" });
    await fixture.signals.until(() => bridge.links[0]?.sent.includes(messageYjsSyncStep2) || undefined);
    if (variant === "restart") {
      bridge.links[0]?.cut();
      assert.deepEqual(await result, state);
    } else {
      if (variant === "cancel") cancel.abort();
      await result;
    }
    assert.equal(bridge.links.length, variant === "cancel" ? 1 : 2);
  });
}
