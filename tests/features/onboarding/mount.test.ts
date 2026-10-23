import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { __init } from "../../../src/features/onboarding/onboarding.js";
import { fakeOnboardingPorts } from "../fakes.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;

function page() {
  win.document.body.innerHTML = '<button id="outside">Outside</button><div id="onboarding-modal" hidden>' +
    '<button class="modal-close" data-onboard-action="skip">Skip</button>' +
    '<button data-onboard-action="back">Back</button><button data-onboard-action="next">Next</button>' +
    '<button data-onboard-action="host-save">Save</button><button data-onboard-action="join-submit">Join</button>' +
    '<button data-onboard-action="finish-tour">Tour</button><button data-onboard-action="open-help">Help</button>' +
    '<div id="onboard-install-body"></div><div id="onboard-host-panel" hidden></div>' +
    '<div id="onboard-join-panel" hidden><input id="onboard-join-name" value="Team">' +
    '<input id="onboard-join-url" value=" http://team.test/ "><input id="onboard-join-pin" value=" 1234 ">' +
    '<input type="checkbox" id="onboard-join-remember" checked></div><p id="onboard-join-error" hidden></p>' +
    '<section class="onboard-step" data-onboard-step="1"></section><section class="onboard-step" data-onboard-step="2" hidden></section>' +
    '<section class="onboard-step" data-onboard-step="3" hidden></section><section class="onboard-step" data-onboard-step="4" hidden></section></div>';
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("onboarding mounts with ports, saves the host command, joins, records completion and starts the tour", async () => {
  page();
  const h = fakeOnboardingPorts();
  const mounted = __init(h.ports);
  try {
    await settled();
    assert.equal(modal().hidden, false);
    assert.equal(h.panels.closed(), 1);
    click("next");
    await settled();
    assert.equal(h.launcherCalls(), 1);
    assert.equal(win.document.getElementById("onboard-install-body")?.textContent?.includes("C:/Splitpage"), true);
    click("host-save");
    assert.deepEqual(h.delivered, [["splitpage-host.cmd", [
      "@echo off", "title Splitpage - host for others", "echo Starting a shared session...",
      "echo Share the address and the PIN it prints with whoever is joining.",
      "echo This is plain HTTP - fine on your own network, not over the internet.",
      "echo Close this window to stop hosting.", "echo.", "start.bat --host --pin", "pause", ""
    ].join("\r\n"), { savedMsg: "Saved the host command." }]]);
    click("join-submit");
    await settled();
    assert.deepEqual(h.joined, [["Team", "http://team.test/", { pin: "1234", remember: true }]]);
    assert.deepEqual(h.notices.shown.map(({ message, kind }) => [message, kind]), [["Joined Team.", "ok"]]);
    assert.equal(win.document.querySelector('[data-onboard-step="4"]')?.hasAttribute("hidden"), false);
    click("finish-tour");
    assert.deepEqual(h.recorded, [false]);
    assert.equal(modal().hidden, true);
    assert.deepEqual(h.actions.calls, [{ id: "tour", source: "button" }]);
  } finally {
    mounted.dispose();
  }
});

test("automatic onboarding respects the seed, saved file, link, document home and desktop launch facts", async () => {
  const cases: [string, (h: ReturnType<typeof fakeOnboardingPorts>) => void, boolean][] = [
    ["pristine", () => {}, false],
    ["changed seed", (h) => { h.state.seed = false; }, true],
    ["last file", (h) => { h.state.last = { name: "script" }; }, true],
    ["link", (h) => { h.state.link = true; }, true],
    ["file home", (h) => { h.state.home = { kind: "file" }; }, true],
    ["server home", (h) => { h.state.home = { kind: "server", id: "doc" }; }, true],
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
    const mounted = __init(h.ports);
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
  const first = __init(h.ports);
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
  const next = __init(h.ports);
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
  const mounted = __init({ ...h.ports, lastFile: { load: () => new Promise((done) => { resolve = done; }) } });
  mounted.dispose();
  resolve(null);
  await settled();
  assert.equal(modal().hidden, true);
  assert.equal(h.choices.size, 0);
});
