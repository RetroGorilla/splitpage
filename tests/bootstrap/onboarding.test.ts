import "../../src/test/_dom.mjs";
import "../../src/test/_screen-state-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../src/application/actions.ts";
import { mountOnboardingFeature, stopOnboardingFeature, onboardingActions } from "../../src/bootstrap/wiring/onboarding.ts";
import { startPreferences, preferences } from "../../src/bootstrap/wiring/preferences-owner.ts";
import { startSidePanels } from "../../src/bootstrap/wiring/ports/panels.ts";
import { localFileMenuControls, mountLocalFilesFeature, stopLocalFilesFeature } from "../../src/bootstrap/wiring/local-files.ts";
import { loadTestDocument } from "../../src/test/_document.mjs";
import { domStartup } from "../../src/bootstrap/wiring/ports/startup.ts";
import { connectStartup } from "../../src/application/startup-signal.ts";

test("onboarding readiness does not settle between DOM readiness and the app's startup listener", async () => {
  Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
  let decided = false;
  const ready = domStartup.ready();
  assert.ok(ready);
  void ready.then(() => { decided = true; });
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await Promise.resolve();
  await Promise.resolve();
  let stop = () => {};
  try {
    assert.equal(decided, false);
    stop = connectStartup({ ready: async () => {} });
    await ready;
    assert.equal(decided, true);
  } finally {
    stop();
    Reflect.deleteProperty(document, "readyState");
  }
});

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
  mountLocalFilesFeature();
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
    localFileMenuControls().noteFileMenuChoice("save");
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
    stopLocalFilesFeature();
    off();
    stopPanels();
    stopPreferences();
    document.body.innerHTML = "";
  }
});
