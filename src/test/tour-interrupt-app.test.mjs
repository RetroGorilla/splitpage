import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { openPinDialog } = await import("../js/20e-connect.js");
const { openHelp, startTour, tourShowing } = await import("../js/20c-help.js");
const { appActions } = await import("../legacy/app-actions.ts");

after(closeApp);

const pinModal = () => document.getElementById("pin-modal");
const tourOverlay = () => document.getElementById("tour-overlay");
const stepText = () => document.getElementById("tour-step").textContent;
const toastEls = () => Array.from(document.querySelectorAll("#toast-host .toast:not(.is-leaving)"));
const toasts = () => toastEls().map((t) => t.firstChild.textContent);
const pausedToasts = () => toastEls().filter((t) => t.firstChild.textContent === "The tour was paused.");
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

function tourTo(step) {
  appActions.invoke("tour", "button");
  for (let i = 1; i < step; i++) click(document.getElementById("tour-next"));
  assert.equal(stepText(), "Step " + step + " of 5");
}

function closePrompt() {
  click(pinModal().querySelector('[data-connect-action="pin-cancel"]'));
  assert.equal(pinModal().hidden, true);
}

afterEach(() => {
  if (!tourOverlay().hidden) click(document.getElementById("tour-skip"));
  pinModal().hidden = true;
  for (const extra of document.querySelectorAll(".test-dialog")) extra.remove();
  for (const toast of toastEls()) toast.remove();
  appActions.invoke("tour", "button");
  click(document.getElementById("tour-skip"));
  for (const toast of toastEls()) toast.remove();
});

test("a join prompt that opens mid-tour interrupts it, and closing the prompt offers to resume at the same step", () => {
  tourTo(3);
  openPinDialog({ reason: "This server asks for its join PIN or key." });
  assert.equal(pinModal().hidden, false);
  assert.equal(tourOverlay().hidden, true);
  assert.equal(tourShowing(), false);
  assert.deepEqual(toasts(), []);
  closePrompt();
  assert.equal(tourOverlay().hidden, true);
  assert.deepEqual(toasts(), ["The tour was paused."]);
  const resume = toastEls()[0].querySelector("button");
  assert.equal(resume.textContent, "Resume tour");
  click(resume);
  assert.equal(tourOverlay().hidden, false);
  assert.equal(tourShowing(), true);
  assert.equal(stepText(), "Step 3 of 5");
  assert.deepEqual(toasts(), []);
});

test("the resumed tour carries on from there and finishes normally", () => {
  tourTo(4);
  openPinDialog();
  closePrompt();
  click(toastEls()[0].querySelector("button"));
  assert.equal(stepText(), "Step 4 of 5");
  click(document.getElementById("tour-next"));
  assert.equal(stepText(), "Step 5 of 5");
  click(document.getElementById("tour-next"));
  assert.equal(tourOverlay().hidden, true);
  assert.equal(tourShowing(), false);
});

test("a prompt that opens with no tour running offers nothing", () => {
  openPinDialog();
  closePrompt();
  assert.deepEqual(toasts(), []);
});

test("Resume obeys the tour's availability rule when another dialog is open", () => {
  tourTo(2);
  openPinDialog();
  closePrompt();
  const other = document.createElement("div");
  other.className = "modal-backdrop test-dialog";
  document.body.append(other);
  click(toastEls()[0].querySelector("button"));
  assert.equal(tourOverlay().hidden, true);
  assert.ok(toasts().includes("Close the open dialog first."), toasts().join("|"));
  assert.equal(pausedToasts().length, 1);
  other.remove();
  click(pausedToasts()[0].querySelector("button"));
  assert.equal(tourOverlay().hidden, false);
  assert.equal(stepText(), "Step 2 of 5");
});

test("dismissing the toast leaves the tour ended, and a later prompt does not bring it back", () => {
  tourTo(3);
  openPinDialog();
  closePrompt();
  click(toastEls()[0]);
  assert.equal(tourOverlay().hidden, true);
  for (const toast of toastEls()) toast.remove();
  openPinDialog();
  closePrompt();
  assert.deepEqual(toasts(), []);
  assert.equal(tourShowing(), false);
});

test("a prompt that reopens replaces the earlier offer and keeps the step", () => {
  tourTo(3);
  openPinDialog();
  closePrompt();
  assert.equal(pausedToasts().length, 1);
  openPinDialog();
  assert.equal(pausedToasts().length, 0);
  assert.equal(tourOverlay().hidden, true);
  closePrompt();
  assert.equal(pausedToasts().length, 1);
  click(pausedToasts()[0].querySelector("button"));
  assert.equal(stepText(), "Step 3 of 5");
});

test("invoking the tour action again starts at step 1 and drops the pending offer", () => {
  tourTo(3);
  openPinDialog();
  closePrompt();
  assert.equal(appActions.invoke("tour", "button").kind, "ran");
  assert.equal(stepText(), "Step 1 of 5");
  assert.equal(pausedToasts().length, 0);
  click(document.getElementById("tour-skip"));
  openPinDialog();
  closePrompt();
  assert.deepEqual(toasts(), []);
});

test("a tour already set aside for Help is interrupted too, so it does not come back under the prompt", () => {
  tourTo(2);
  openHelp();
  assert.equal(tourOverlay().hidden, true);
  openPinDialog();
  click(document.getElementById("help-close"));
  assert.equal(document.getElementById("help-modal").hidden, true);
  assert.equal(tourOverlay().hidden, true);
  assert.equal(pinModal().hidden, false);
  closePrompt();
  assert.deepEqual(toasts(), ["The tour was paused."]);
  click(toastEls()[0].querySelector("button"));
  assert.equal(stepText(), "Step 2 of 5");
});

test("a Resume that is refused and then dismissed leaves no step behind for a later tour", () => {
  tourTo(2);
  openPinDialog();
  closePrompt();
  const other = document.createElement("div");
  other.className = "modal-backdrop test-dialog";
  document.body.append(other);
  click(pausedToasts()[0].querySelector("button"));
  assert.equal(tourOverlay().hidden, true);
  assert.equal(pausedToasts().length, 1);
  other.remove();
  click(pausedToasts()[0]);
  assert.equal(pausedToasts().length, 0);
  assert.equal(appActions.invoke("tour", "button").kind, "ran");
  assert.equal(tourOverlay().hidden, false);
  assert.equal(stepText(), "Step 1 of 5");
});

test("a join prompt that interrupts the tour at the tagging step also closes the tagging reference", () => {
  tourTo(2);
  const taggingHelp = document.getElementById("tagging-help");
  assert.equal(taggingHelp.hidden, false);
  openPinDialog();
  assert.equal(pinModal().hidden, false);
  assert.equal(taggingHelp.hidden, true);
});

test("skipping the tour is not an interruption", () => {
  startTour();
  click(document.getElementById("tour-skip"));
  openPinDialog();
  closePrompt();
  assert.deepEqual(toasts(), []);
});
