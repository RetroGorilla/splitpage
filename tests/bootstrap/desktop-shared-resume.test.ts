import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopPort } from "../../src/adapters/desktop/desktop-port.ts";
import { resumeDesktopReference } from "../../src/bootstrap/wiring/desktop-shared-resume.ts";

import { RETAINED_SHARED_COPY_UNAVAILABLE } from "../../src/bootstrap/wiring/retained-shared-script.ts";

const saved = { deployment: "relay", script: "old", address: "https://relay.example" };

for (const [result, cleared] of [
  ["opened", false],
  ["enter-failed", false],
  ["locked", false],
  ["io", false],
  ["draft-not-kept", false],
  [RETAINED_SHARED_COPY_UNAVAILABLE, true],
  ["cancelled", false]
] as const) {
  test(`starting a desktop with a retained reference (${result})`, async () => {
    const lifetime = new AbortController();
    const calls: unknown[][] = [];
    const reference: NonNullable<DesktopPort["sharedReference"]> = async request => {
      calls.push(request);
      return request.length ? true : saved;
    };
    const outcome = await resumeDesktopReference(reference, async entry => {
      assert.deepEqual(entry, saved);
      if (result === "cancelled") lifetime.abort();
      return result === "opened" ? { ok: true } : { ok: false, reason: result === "cancelled" ? RETAINED_SHARED_COPY_UNAVAILABLE : result };
    }, lifetime.signal);
    assert.equal(outcome?.ok, result === "opened");
    assert.deepEqual(calls, cleared ? [[], [null, saved]] : [[]]);
  });
}
