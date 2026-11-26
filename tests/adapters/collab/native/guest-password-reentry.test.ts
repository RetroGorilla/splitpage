import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_DEVICE_CREDENTIALS_PER_SCRIPT } from "../../../../collab-server/storage.ts";
import { createBrowserNativeLocalStore } from "../../../../src/adapters/collab/native/browser-local-store.ts";
import { applyNativePeerUpdate } from "../../../../src/adapters/collab/native/peer-update.ts";
import { collaborationSnapshot } from "../../../../src/bootstrap/wiring/collaboration-owner.ts";
import type { RetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import type { SharedSwitchOutcome } from "../../../../src/bootstrap/wiring/shared-session.ts";
import { bootApp, closeApp } from "../../../../src/test/_app-boot.mjs";
import { STORE_OPTIONS } from "./local-store-fixture.ts";
import { serverHarness } from "./server-harness.ts";

test("a returning guest can re-enter the password after their device credential is pruned", { timeout: 25_000 }, async t => {
  const relay = serverHarness(t);
  const run = relay.launch();
  const state = relay.seed();
  const password = "Guest link password";
  const { scriptId, guest } = await run.createScriptWithCredentials(randomUUID(), state, undefined, password);
  assert.ok(guest);
  const guestLinkToken = guest.token;
  async function exchange() {
    const response = await run.owner(`scripts/${scriptId}/password-exchange`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password })
    }, guestLinkToken);
    assert.equal(response.status, 200);
    return (await response.json() as { token: string }).token;
  }
  const token = await exchange();
  const deployment = "guest-reentry";
  const name = deployment + "/" + scriptId;
  const copy = await createBrowserNativeLocalStore().open(name, STORE_OPTIONS);
  assert.equal(copy.kind, "opened");
  assert.ok(copy.membership);
  try {
    assert.equal(applyNativePeerUpdate(copy.session, state), true);
    assert.equal((await copy.flush()).kind, "stored");
    await copy.membership.join({ role: "guest", token, guestLinkToken });
  } finally {
    copy.session.close();
    await copy.closed;
  }
  for (let count = 0; count < MAX_DEVICE_CREDENTIALS_PER_SCRIPT; count++) await exchange();

  Reflect.set(globalThis, "SPLITPAGE_COLLAB_UI", true);
  try {
    localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
    await bootApp();
    const { localFilesOwner } = await import("../../../../src/bootstrap/wiring/local-files.ts");
    await localFilesOwner().tryResumeLastProject();
    const app = (window as unknown as { __sharedTest: {
      enterRetained: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>;
      leave: () => SharedSwitchOutcome | Promise<SharedSwitchOutcome>;
    } }).__sharedTest;
    assert.deepEqual(await app.enterRetained({ deployment, script: scriptId, relayUrl: "ws://127.0.0.1:" + await run.port() }), { ok: true });
    try {
      while (!collaborationSnapshot().refusal) await delay(10, undefined, { signal: t.signal });
      const reenter = document.querySelector<HTMLButtonElement>("#collab-access-reenter-password");
      assert.equal(reenter?.hidden, false);
      assert.match(document.getElementById("collab-access-text")?.textContent ?? "", /Re-enter the link password/);
      reenter?.click();
      const field = document.querySelector<HTMLInputElement>("#link-password-modal input");
      const reconnect = document.querySelector<HTMLButtonElement>("#link-password-modal [type=submit]");
      assert.ok(field && reconnect);
      while (reconnect.disabled) await delay(10, undefined, { signal: t.signal });
      field.value = password;
      reconnect.click();
      while (!collaborationSnapshot().relay.connected || !collaborationSnapshot().relay.firstSyncDone) {
        await delay(10, undefined, { signal: t.signal });
      }
      assert.equal(collaborationSnapshot().refusal, null);
      assert.equal(document.getElementById("link-password-modal"), null);
      assert.equal(document.getElementById("collab-access-banner")?.hidden, true);
    } finally {
      assert.deepEqual(await app.leave(), { ok: true });
    }
  } finally {
    Reflect.deleteProperty(globalThis, "SPLITPAGE_COLLAB_UI");
    closeApp();
  }
});
