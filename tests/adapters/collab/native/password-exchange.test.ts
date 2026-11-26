import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLinkPasswordRecovery, exchangeLinkPassword } from "../../../../src/adapters/collab/native/password-exchange.ts";

const linkToken = "a".repeat(43);

for (const [status, body, outcome] of [
  [428, null, { kind: "eligible", passwordRequired: true }],
  [200, { token: linkToken }, { kind: "eligible", passwordRequired: false }],
  [200, { token: "b".repeat(43) }, { kind: "retryable" }], [200, null, { kind: "retryable" }],
  [403, null, { kind: "denied" }], [404, null, { kind: "denied" }],
  [405, null, { kind: "retryable" }], [429, null, { kind: "retryable" }], [503, null, { kind: "retryable" }]
] as const) {
  test(`recovery check maps HTTP ${status} to ${outcome.kind}`, async t => {
    const respond: typeof globalThis.fetch = async () =>
      body ? Response.json(body, { status }) : new Response(null, { status });
    const fetch = t.mock.method(globalThis, "fetch", respond);
    assert.deepEqual(await checkLinkPasswordRecovery("https://relay.example", "script", linkToken, t.signal), outcome);
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
    assert.deepEqual(await checkLinkPasswordRecovery("https://relay.example", "script", "link", t.signal), { kind: "retryable" });
  });
}

test("a null-password exchange can be retried after HTTP 429 without reporting failed password attempts", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 429 }));
  const result = await exchangeLinkPassword("https://relay.example", "script", linkToken, null, t.signal);
  assert.deepEqual(result, { kind: "failed", reason: "relay-unreachable" });
});

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
