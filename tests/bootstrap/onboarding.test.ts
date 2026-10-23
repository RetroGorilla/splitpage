import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import { mountOnboardingFeature, stopOnboardingFeature, onboardingActions } from "../../src/bootstrap/wiring/onboarding.ts";
import { startPreferences, preferences } from "../../src/legacy/preferences-bridge.ts";
import { startSidePanels } from "../../src/legacy/panels-bridge.ts";
import { noteFileMenuChoice } from "../../src/js/18-local-files.js";
import { loadTestDocument } from "../../src/test/_document.mjs";

test("wired onboarding replaces its mount, closes on file choices and disables setup after stopping", () => {
  document.body.innerHTML = '<div id="onboarding-modal" hidden><button data-onboard-action="skip"></button></div>';
  const modal = document.getElementById("onboarding-modal");
  assert.ok(modal);
  const stopPreferences = startPreferences();
  loadTestDocument({ rows: [] });
  let closed = 0;
  const stopPanels = startSidePanels({
    registerPanel: () => () => {}, registerPage: () => () => {}, open: () => {}, close: () => {},
    closeAll: () => { closed++; }, sync: () => {}, applyWidth: () => {}
  });
  const registry = createActionRegistry();
  const off = registerAll(registry, onboardingActions());
  try {
    assert.equal(registry.invoke("setup", "menu").kind, "unavailable");
    const first = mountOnboardingFeature();
    assert.equal(registry.invoke("setup", "menu").kind, "ran");
    assert.equal(modal.hidden, false);
    const second = mountOnboardingFeature();
    assert.equal(modal.hidden, true);
    first.openOnboarding();
    assert.equal(modal.hidden, true);
    second.openOnboarding();
    assert.equal(modal.hidden, false);
    noteFileMenuChoice("save");
    assert.equal(modal.hidden, true);
    assert.equal(closed, 2);
    stopOnboardingFeature();
    assert.equal(registry.invoke("setup", "menu").kind, "unavailable");
    second.openOnboarding();
    assert.equal(modal.hidden, true);
    const skip = modal.querySelector("button");
    assert.ok(skip);
    skip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(preferences().onboarding(), null);
  } finally {
    stopOnboardingFeature();
    off();
    stopPanels();
    stopPreferences();
    document.body.innerHTML = "";
  }
});
