import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { openOnboarding } = await import("../js/20b-onboarding.js");

after(closeApp);

const wizard = () => document.getElementById("onboarding-modal");
const tourOverlay = () => document.getElementById("tour-overlay");
const toasts = () => Array.from(document.querySelectorAll("#toast-host .toast"), (t) => t.textContent);

function pressTourButton() {
  const button = wizard().querySelector('[data-onboard-action="finish-tour"]');
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

const wizardSetting = () => JSON.parse(localStorage.getItem("splitpage-onboarding"));

afterEach(() => {
  if (!tourOverlay().hidden) document.getElementById("tour-skip").click();
  wizard().hidden = true;
  localStorage.removeItem("splitpage-onboarding");
  for (const extra of document.querySelectorAll(".test-dialog")) extra.remove();
  for (const toast of document.querySelectorAll("#toast-host .toast")) toast.remove();
});

test("the wizard's tour button closes the wizard and starts the tour", () => {
  openOnboarding();
  assert.equal(wizard().hidden, false);
  pressTourButton();
  assert.equal(wizard().hidden, true);
  assert.equal(tourOverlay().hidden, false);
  assert.deepEqual(toasts(), []);
  assert.equal(wizardSetting().done, true);
  assert.equal(wizardSetting().skipped, false);
});

test("the wizard's tour button obeys the tour's availability rule", () => {
  openOnboarding();
  const other = document.createElement("div");
  other.className = "modal-backdrop test-dialog";
  document.body.append(other);
  pressTourButton();
  assert.equal(wizard().hidden, true);
  assert.equal(tourOverlay().hidden, true);
  assert.ok(toasts().includes("Close the open dialog first."), toasts().join("|"));
  assert.equal(wizardSetting().done, true);
  assert.equal(wizardSetting().skipped, false);
});
