import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { onboardingActions } from "../../../src/features/onboarding/actions.ts";
import type { OnboardingMount } from "../../../src/features/onboarding/ports.ts";
import { fakeScreen } from "../fakes.ts";

test("setup keeps its definition, refuses an absent mount or a dialog and opens the current mount", () => {
  const screen = fakeScreen();
  let current: OnboardingMount | null = null;
  let opened = 0;
  const definitions = onboardingActions(() => current, screen);
  assert.deepEqual(definitions.map(({ id, label, group, icon, words }) => ({ id, label, group, icon, words })), [{
    id: "setup", label: "Set up Splitpage…", group: "Help", icon: "i-sliders", words: "setup settings wizard install"
  }]);
  const registry = createActionRegistry();
  const off = registerAll(registry, definitions);
  try {
    assert.equal(registry.invoke("setup", "menu").kind, "unavailable");
    current = { openOnboarding: () => { opened++; }, dispose: () => {} };
    assert.equal(registry.invoke("setup", "menu").kind, "ran");
    assert.equal(opened, 1);
    screen.state.dialog = true;
    assert.equal(registry.invoke("setup", "menu").kind, "unavailable");
    assert.equal(opened, 1);
    screen.state.dialog = false;
    current = { openOnboarding: () => { opened += 10; }, dispose: () => {} };
    assert.equal(registry.invoke("setup", "menu").kind, "ran");
    assert.equal(opened, 11);
    current = null;
    assert.equal(registry.invoke("setup", "menu").kind, "unavailable");
  } finally {
    off();
  }
});
