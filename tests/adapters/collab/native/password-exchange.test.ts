import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLinkPasswordRecovery, exchangeLinkPassword } from "../../../../src/adapters/collab/native/password-exchange.ts";

const linkToken = "a".repeat(43);

for (const [status, body, outcome] of [
  [428, null, "eligible"], [200, { token: linkToken }, "eligible"],
  [200, { token: "b".repeat(43) }, "retryable"], [200, null, "retryable"],
  [403, null, "denied"], [404, null, "denied"],
  [405, null, "retryable"], [429, null, "retryable"], [503, null, "retryable"]
] as const) {
  test(`recovery check maps HTTP ${status} to ${outcome}`, async t => {
    const respond: typeof globalThis.fetch = async () =>
      body ? Response.json(body, { status }) : new Response(null, { status });
    const fetch = t.mock.method(globalThis, "fetch", respond);
    assert.equal(await checkLinkPasswordRecovery("https://relay.example", "script", linkToken, t.signal), outcome);
    const request = fetch.mock.calls[0]?.arguments[1];
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.body, JSON.stringify({ password: null }));
    assert.equal(new Headers(request.headers).get("Authorization"), "Bearer " + linkToken);
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
  [404, null, "access-removed"],
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
