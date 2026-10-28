import test from "node:test";
import { mountIdentity } from "../../../src/features/settings/mount.ts";
import type { IdentityPorts } from "../../../src/features/settings/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "identity-chip",
    "click"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: IdentityPorts = {
    promptForName: h.log("promptForName")
  };
  const mount = () => [mountIdentity({ window: h.window, ports: p0 })];
  return { ...h, mount, p0 };
}

test("settings: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});
