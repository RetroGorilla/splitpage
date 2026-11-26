import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
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

before(async () => {
  Reflect.set(globalThis, "SPLITPAGE_COLLAB_UI", true);
  localStorage.setItem("splitpage-onboarding", JSON.stringify({ v: 1, done: true, skipped: true }));
  await bootApp();
  const { localFilesOwner } = await import("../../../../src/bootstrap/wiring/local-files.ts");
  await localFilesOwner().tryResumeLastProject();
});
after(() => {
  Reflect.deleteProperty(globalThis, "SPLITPAGE_COLLAB_UI");
  closeApp();
});

for (const [scenario, title] of [
  ["eligible", "a returning guest can re-enter the password after their device credential is pruned"],
  ["changed", "a returning guest can re-enter a changed password using the existing relay exchange"],
  ["reset", "a pruned device cannot re-enter after the guest link is reset"],
  ["retry", "an unavailable relay keeps password recovery retryable until the link check succeeds"]
] as const) {
  test(title, { timeout: 25_000 }, async t => {
    const relay = serverHarness(t);
    const run = relay.launch();
    const state = relay.seed();
    const password = "Guest link password";
    const recoveryPassword = scenario === "changed" ? "Changed guest link password" : password;
    const { scriptId, guest, owner } = await run.createScriptWithCredentials(randomUUID(), state, undefined, password);
    assert.ok(guest && owner);
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
    if (scenario === "changed") {
      const response = await run.owner(`scripts/${scriptId}/password`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: recoveryPassword })
      }, owner.token);
      assert.equal(response.status, 204);
    } else {
      for (let count = 0; count < MAX_DEVICE_CREDENTIALS_PER_SCRIPT; count++) await exchange();
    }

    if (scenario === "reset") {
      const response = await run.owner(`scripts/${scriptId}/reset`, { method: "POST" }, owner.token);
      assert.equal(response.status, 200);
    }
    let checks = 0;
    if (scenario === "retry") {
      const fetchFromRelay = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (input: URL, init?: RequestInit) => {
        if (init?.method === "POST" && init.body === JSON.stringify({ password: null }) && input.pathname.endsWith("/password-exchange")) {
          checks++;
          if (checks === 1) return Promise.resolve(new Response(null, { status: 503 }));
          if (checks === 2) return Promise.reject(new TypeError("Relay unavailable"));
        }
        return fetchFromRelay(input, init);
      });
    }
    const app = (window as unknown as { __sharedTest: {
      enterRetained: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>;
      leave: () => SharedSwitchOutcome | Promise<SharedSwitchOutcome>;
    } }).__sharedTest;
    assert.deepEqual(await app.enterRetained({ deployment, script: scriptId, relayUrl: "ws://127.0.0.1:" + await run.port() }), { ok: true });
    try {
      const reenter = document.querySelector<HTMLButtonElement>("#collab-access-reenter-password");
      if (scenario === "retry") {
        const retry = document.querySelector<HTMLButtonElement>("#collab-access-retry");
        for (const attempt of [1, 2]) {
          while (!collaborationSnapshot().refusal && (!retry || retry.hidden || retry.disabled)) {
            await delay(10, undefined, { signal: t.signal });
          }
          assert.equal(collaborationSnapshot().refusal, null);
          assert.ok(retry);
          assert.equal(checks, attempt);
          assert.equal(reenter?.hidden, true);
          assert.equal(document.getElementById("collab-access-banner")?.hidden, false);
          assert.match(document.getElementById("collab-access-title")?.textContent ?? "", /^Offline/);
          assert.match(document.getElementById("collab-access-text")?.textContent ?? "", /Could not reach the relay/);
          if (attempt === 1) {
            const dismiss = document.querySelector<HTMLButtonElement>("#collab-access-dismiss");
            const save = document.querySelector<HTMLButtonElement>("#btn-save");
            assert.ok(dismiss && save);
            dismiss.click();
            assert.equal(document.getElementById("collab-access-banner")?.hidden, true);
            assert.match(save.textContent ?? "", /^Offline/);
            save.click();
            assert.equal(document.getElementById("collab-access-banner")?.hidden, false);
            assert.equal(document.activeElement, retry);
          }
          retry.click();
        }
      }
      while (!collaborationSnapshot().refusal && collaborationSnapshot().passwordRecoveryCheck !== "retryable") {
        await delay(10, undefined, { signal: t.signal });
      }
      assert.equal(collaborationSnapshot().passwordRecoveryCheck, null);
      if (scenario === "reset") {
        assert.equal(reenter?.hidden, true);
        assert.match(document.getElementById("collab-access-text")?.textContent ?? "", /^Your access to this shared script was removed\./);
        return;
      }
      assert.equal(reenter?.hidden, false);
      assert.match(document.getElementById("collab-access-text")?.textContent ?? "",
        scenario === "changed" ? /The link password changed/ : /Re-enter the link password/);
      reenter?.click();
      const field = document.querySelector<HTMLInputElement>("#link-password-modal input");
      const reconnect = document.querySelector<HTMLButtonElement>("#link-password-modal [type=submit]");
      assert.ok(field && reconnect);
      while (reconnect.disabled) await delay(10, undefined, { signal: t.signal });
      field.value = recoveryPassword;
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
  });
}
