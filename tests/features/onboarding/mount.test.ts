import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startOnboarding } from "../../../src/features/onboarding/onboarding.ts";
import { fakeOnboardingPorts } from "../fakes.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function page() {
  win.document.body.innerHTML = '<button id="outside">Outside</button><div id="onboarding-modal" hidden>' +
    '<button class="modal-close" data-onboard-action="skip">Skip</button>' +
    '<button data-onboard-action="back">Back</button><button data-onboard-action="next">Next</button>' +
    '<button data-onboard-action="finish-tour">Tour</button><button data-onboard-action="open-help">Help</button>' +
    '<div id="onboard-install-body"></div>' +
    '<section class="onboard-step" data-onboard-step="1"></section><section class="onboard-step" data-onboard-step="2" hidden></section>' +
    '<section class="onboard-step" data-onboard-step="3" hidden></section></div>';
}

function stepShown(n: number): boolean {
  return win.document.querySelector('[data-onboard-step="' + n + '"]')?.hasAttribute("hidden") === false;
}

function modal() {
  const el = win.document.getElementById("onboarding-modal");
  assert.ok(el);
  return el;
}

function click(action: string) {
  const el = win.document.querySelector('[data-onboard-action="' + action + '"]');
  assert.ok(el);
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function settled() {
  await new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

test("onboarding mounts with ports, walks its three steps, records completion and starts the tour", async () => {
  page();
  const h = fakeOnboardingPorts();
  const mounted = startOnboarding(h.ports);
  try {
    await settled();
    assert.equal(modal().hidden, false);
    assert.equal(h.panels.closed(), 1);
    assert.equal(stepShown(1), true);
    click("next");
    assert.equal(stepShown(2), true);
    assert.match(win.document.getElementById("onboard-install-body")?.textContent ?? "", /runs wherever its folder is/);
    click("next");
    assert.equal(stepShown(3), true);
    assert.equal(win.document.querySelector('[data-onboard-action="next"]')?.textContent, "Finish");
    click("finish-tour");
    assert.deepEqual(h.recorded, [false]);
    assert.equal(modal().hidden, true);
    assert.deepEqual(h.actions.calls, [{ id: "tour", source: "button" }]);
  } finally {
    mounted.dispose();
  }
});

test("on the desktop the install step says this is the installed app, and the last step finishes without a tour", async () => {
  page();
  const h = fakeOnboardingPorts();
  h.state.desktop = true;
  const mounted = startOnboarding(h.ports);
  try {
    await settled();
    assert.equal(modal().hidden, false);
    click("next");
    assert.match(win.document.getElementById("onboard-install-body")?.textContent ?? "", /already installed as a desktop app/);
    click("back");
    assert.equal(stepShown(1), true);
    click("next");
    click("next");
    click("next");
    assert.deepEqual(h.recorded, [false]);
    assert.equal(modal().hidden, true);
    assert.deepEqual(h.actions.calls, []);
  } finally {
    mounted.dispose();
  }
});

test("automatic onboarding respects the seed, saved file, document home and desktop launch facts", async () => {
  const cases: [string, (h: ReturnType<typeof fakeOnboardingPorts>) => void, boolean][] = [
    ["pristine", () => {}, false],
    ["changed seed", (h) => { h.state.seed = false; }, true],
    ["last file", (h) => { h.state.last = { name: "script" }; }, true],
    ["file home", (h) => { h.state.home = { kind: "file" }; }, true],
    ["desktop pristine", (h) => { h.state.desktop = true; }, false],
    ["restore pending", (h) => { h.state.desktop = true; h.state.pending = true; }, true],
    ["later tab", (h) => { h.state.desktop = true; h.state.firstTab = false; }, true],
    ["prior session", (h) => { h.state.desktop = true; h.state.prior = true; }, true],
    ["file launch", (h) => { h.state.desktop = true; h.state.intent = { type: "file" }; }, true],
    ["draft restore", (h) => { h.state.desktop = true; h.state.draft = true; }, true],
    ["recorded", (h) => { h.ports.preferences.recordOnboarding(false, "earlier"); }, true]
  ];
  for (const [name, configure, hidden] of cases) {
    page();
    const h = fakeOnboardingPorts();
    configure(h);
    const mounted = startOnboarding(h.ports);
    try {
      await settled();
      assert.equal(modal().hidden, hidden, name);
    } finally {
      mounted.dispose();
    }
  }
});

test("disposal removes listeners and the file choice subscription and permits a fresh mount", async () => {
  page();
  const h = fakeOnboardingPorts();
  const first = startOnboarding(h.ports);
  await settled();
  assert.equal(h.choices.size, 1);
  for (const listener of h.choices) listener();
  assert.equal(modal().hidden, true);
  first.openOnboarding();
  assert.equal(modal().hidden, false);
  first.dispose();
  first.dispose();
  assert.equal(h.choices.size, 0);
  click("skip");
  win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  assert.deepEqual(h.recorded, []);
  first.openOnboarding();
  assert.equal(modal().hidden, true);
  const next = startOnboarding(h.ports);
  try {
    await settled();
    assert.equal(h.choices.size, 1);
    assert.equal(modal().hidden, false);
    first.dispose();
    click("skip");
    assert.deepEqual(h.recorded, [true]);
    assert.equal(modal().hidden, true);
  } finally {
    next.dispose();
  }
});

test("a disposed mount cannot auto-open after a last-file read completes", async () => {
  page();
  const h = fakeOnboardingPorts();
  let resolve: (value: unknown) => void = () => {};
  let requested = false;
  const mounted = startOnboarding({ ...h.ports, lastFile: { load: () => new Promise((done) => { requested = true; resolve = done; }) } });
  await settled();
  assert.equal(requested, true);
  mounted.dispose();
  resolve(null);
  await settled();
  assert.equal(modal().hidden, true);
  assert.equal(h.choices.size, 0);
});

test("automatic onboarding waits to decide until startup is ready", async () => {
  page();
  const h = fakeOnboardingPorts();
  let ready = () => {};
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const mounted = startOnboarding({ ...h.ports, startup: { ready: () => waiting } });
  try {
    await settled();
    assert.equal(modal().hidden, true);
    assert.equal(h.panels.closed(), 0);
    ready();
    await settled();
    assert.equal(modal().hidden, false);
    assert.equal(h.panels.closed(), 1);
  } finally { mounted.dispose(); }
});

test("an ineligible onboarding decision settles even while startup remains pending", async () => {
  page();
  const h = fakeOnboardingPorts();
  h.state.seed = false;
  const mounted = startOnboarding({ ...h.ports, startup: { ready: () => new Promise(() => {}) } });
  const probe = (win as unknown as { __onboarding: { autoShowDecided: () => Promise<void> } }).__onboarding;
  let decided = false;
  void probe.autoShowDecided().then(() => { decided = true; });
  try {
    await settled();
    assert.equal(decided, true);
    assert.equal(modal().hidden, true);
    assert.equal(h.panels.closed(), 0);
  } finally { mounted.dispose(); }
});

test("automatic onboarding rechecks eligibility when startup becomes ready", async () => {
  page();
  const h = fakeOnboardingPorts();
  let ready = () => {};
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const mounted = startOnboarding({ ...h.ports, startup: { ready: () => waiting } });
  try {
    await settled();
    h.state.home = { kind: "file", name: "arrived.splitpage" };
    ready();
    await settled();
    assert.equal(modal().hidden, true);
    assert.equal(h.panels.closed(), 0);
  } finally { mounted.dispose(); }
});

test("a mount disposed while startup is pending cannot open after it becomes ready", async () => {
  page();
  const h = fakeOnboardingPorts();
  let ready = () => {};
  const waiting = new Promise<void>(resolve => { ready = resolve; });
  const mounted = startOnboarding({ ...h.ports, startup: { ready: () => waiting } });
  mounted.dispose();
  ready();
  await settled();
  assert.equal(modal().hidden, true);
  assert.equal(h.panels.closed(), 0);
});

