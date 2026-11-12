import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { SHARED_SESSION_DISABLED } from "../../../src/application/session/ports.ts";
import type { Capability, StandaloneCapabilityName } from "../../../src/application/session/ports.ts";

const REASONS = {
  saveDestinations: "Save destinations are not available in a shared session.",
  autosave: "File autosave is not available in a shared session.",
  merge: "Local merge is not available in a shared session.",
  stash: "Stashed work cannot be applied to a shared session.",
  drafts: "Independent drafts are not available in a shared session.",
  history: "Earlier versions cannot replace a shared session.",
  folders: "Local folders cannot be attached to a shared session.",
  bundles: "File bundles are not available in a shared session."
} as const;

test("the shared disable list declares each standalone family and its reason", () => {
  assert.deepEqual(SHARED_SESSION_DISABLED, REASONS);
  assert.equal(Object.isFrozen(SHARED_SESSION_DISABLED), true);
});

for (const name of Object.keys(REASONS) as StandaloneCapabilityName[]) {
  test(name + ": shared refuses with the declared reason and standalone allows without asking the common capabilities", () => {
    const asked: string[] = [];
    const common = {
      edit: (): Capability => { asked.push("edit"); return { allowed: false, reason: "read only" }; },
      comment: (): Capability => { asked.push("comment"); return { allowed: false, reason: "comments off" }; }
    };
    const shared = createSessionCapabilities("shared", common);
    const standalone = createSessionCapabilities("standalone", common);
    assert.deepEqual(shared[name](), { allowed: false, reason: REASONS[name] });
    assert.deepEqual(standalone[name](), { allowed: true });
    assert.deepEqual(asked, []);
    assert.equal(Object.isFrozen(shared), true);
    assert.equal(Object.isFrozen(shared[name]()), true);
  });
}

test("mode capabilities keep the common edit and comment answers live", () => {
  let reason: string | null = null;
  const can = (): Capability => reason ? { allowed: false, reason } : { allowed: true };
  for (const mode of ["standalone", "shared"] as const) {
    const capability = createSessionCapabilities(mode, { edit: can, comment: can });
    reason = null;
    assert.deepEqual(capability.edit(), { allowed: true });
    assert.deepEqual(capability.comment(), { allowed: true });
    reason = "role changed";
    assert.deepEqual(capability.edit(), { allowed: false, reason: "role changed" });
    assert.deepEqual(capability.comment(), { allowed: false, reason: "role changed" });
  }
});

for (const mode of ["standalone", "shared"] as const) {
  test(mode + ": common capability methods keep their receiver and read its current answer", () => {
    const common = {
      enabled: true,
      edit(): Capability { return this.enabled ? { allowed: true } : { allowed: false, reason: "editing disabled" }; },
      comment(): Capability { return this.enabled ? { allowed: true } : { allowed: false, reason: "comments disabled" }; }
    };
    const capability = createSessionCapabilities(mode, common);
    assert.deepEqual(capability.edit(), { allowed: true });
    assert.deepEqual(capability.comment(), { allowed: true });
    common.enabled = false;
    assert.deepEqual(capability.edit(), { allowed: false, reason: "editing disabled" });
    assert.deepEqual(capability.comment(), { allowed: false, reason: "comments disabled" });
    common.edit = () => ({ allowed: false, reason: "edit method replaced" });
    common.comment = () => ({ allowed: false, reason: "comment method replaced" });
    assert.deepEqual(capability.edit(), { allowed: false, reason: "edit method replaced" });
    assert.deepEqual(capability.comment(), { allowed: false, reason: "comment method replaced" });
  });

  test(mode + ": common capability methods on a class prototype are forwarded live", () => {
    class CommonCapability {
      enabled = true;
      edit(): Capability { return this.enabled ? { allowed: true } : { allowed: false, reason: "editing disabled" }; }
      comment(): Capability { return this.enabled ? { allowed: true } : { allowed: false, reason: "comments disabled" }; }
    }
    const common = new CommonCapability();
    const capability = createSessionCapabilities(mode, common);
    assert.deepEqual(capability.edit(), { allowed: true });
    assert.deepEqual(capability.comment(), { allowed: true });
    common.enabled = false;
    assert.deepEqual(capability.edit(), { allowed: false, reason: "editing disabled" });
    assert.deepEqual(capability.comment(), { allowed: false, reason: "comments disabled" });
  });
}
