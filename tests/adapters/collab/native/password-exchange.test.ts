import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLinkPasswordRecovery, exchangeLinkPassword } from "../../../../src/adapters/collab/native/password-exchange.ts";

for (const [status, outcome] of [
  [204, "eligible"], [403, "denied"], [404, "denied"],
  [405, "retryable"], [429, "retryable"], [503, "retryable"]
] as const) {
  test(`recovery check maps HTTP ${status} to ${outcome}`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
    assert.equal(await checkLinkPasswordRecovery("https://relay.example", "script", "link", t.signal), outcome);
  });
}

for (const error of [new TypeError("Relay unreachable"), new DOMException("Timed out", "TimeoutError")]) {
  test(`recovery check is retryable after ${error.name}`, async t => {
    t.mock.method(globalThis, "fetch", async () => { throw error; });
    assert.equal(await checkLinkPasswordRecovery("https://relay.example", "script", "link", t.signal), "retryable");
  });
}

for (const [status, body, reason] of [
  [428, null, "password-required"],
  [401, null, "wrong-password"],
  [403, null, "access-removed"],
  [409, null, "password-changed"],
  [429, null, "password-rate-limited"],
  [429, { reason: "device-limit" }, "device-limit"]
] as const) {
  test(`password exchange maps HTTP ${status} to ${reason}`, async t => {
    t.mock.method(globalThis, "fetch", async () => body ? Response.json(body, { status }) : new Response(null, { status }));
    const result = await exchangeLinkPassword("https://relay.example", "script", "link", "password", t.signal);
    assert.deepEqual(result, { kind: "failed", reason });
  });
}
