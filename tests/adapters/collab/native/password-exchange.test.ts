import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeLinkPassword } from "../../../../src/adapters/collab/native/password-exchange.ts";

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
