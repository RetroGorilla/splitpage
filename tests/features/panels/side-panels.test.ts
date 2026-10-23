import test from "node:test";
import assert from "node:assert/strict";
import { createSidePanels } from "../../../src/features/panels/side-panels.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

const ids = ["comments-panel", "production-panel", "broll-panel"];

function setup() {
  const window = jsdomWindow() as unknown as Window;
  const document = window.document;
  document.body.innerHTML = ids.map((id) => `<aside id="${id}" hidden></aside>`).join("") +
    '<button id="btn-comments"></button><button id="btn-production"></button><div id="start-page"></div>';
  const calls: string[] = [];
  const panels = createSidePanels(document, {
    ids,
    buttons: [["comments-panel", "btn-comments"], ["production-panel", "btn-production"]],
    readWidth: (id) => (id === "broll-panel" ? 520 : 488),
    holdPlace: () => { calls.push("hold"); },
    opening: (open) => { calls.push(open ? "opening" : "closing"); }
  });
  const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  const pressed = (id: string): string | null => el(id).getAttribute("aria-pressed");
  return { window, document, panels, calls, el, pressed };
}

test("opening a panel hides the others without their close hooks, applies its width and marks its button", () => {
  const h = setup();
  h.panels.registerPanel("comments-panel", () => { h.calls.push("comments closed"); });
  h.panels.open("comments-panel");
  assert.deepEqual(h.calls, ["hold", "opening"]);
  assert.equal(h.el("comments-panel").hidden, false);
  assert.equal(h.document.body.classList.contains("panel-open"), true);
  assert.equal(h.pressed("btn-comments"), "true");
  assert.equal(h.pressed("btn-production"), "false");
  h.calls.length = 0;
  h.panels.open("broll-panel");
  assert.deepEqual(h.calls, ["hold"], "switching panels runs no close hook and keeps the page open");
  assert.equal(h.el("comments-panel").hidden, true);
  assert.equal(h.el("broll-panel").style.getPropertyValue("--panel-width"), "520px");
  assert.equal(h.document.body.style.getPropertyValue("--open-panel-width"), "520px");
  assert.equal(h.pressed("btn-comments"), "false");
  h.window.close();
});

test("closing a panel hides it, runs its registered hook, and syncs once it is hidden", () => {
  const h = setup();
  h.panels.registerPanel("broll-panel", () => {
    h.calls.push("broll closed while " + (h.el("broll-panel").hidden ? "hidden" : "shown"));
  });
  h.panels.open("broll-panel");
  h.calls.length = 0;
  h.panels.close("broll-panel");
  assert.deepEqual(h.calls, ["broll closed while hidden", "closing"]);
  assert.equal(h.document.body.classList.contains("panel-open"), false);
  h.calls.length = 0;
  h.panels.close("comments-panel");
  assert.deepEqual(h.calls, [], "a panel with no hook closes by hiding");
  h.window.close();
});

test("closing the side panels closes only the shown one, through its hook", () => {
  const h = setup();
  h.panels.registerPanel("comments-panel", () => { h.calls.push("comments closed"); });
  h.panels.registerPanel("broll-panel", () => { h.calls.push("broll closed"); });
  h.panels.open("broll-panel");
  h.calls.length = 0;
  h.panels.closeAll();
  assert.deepEqual(h.calls, ["broll closed", "closing"]);
  assert.ok(ids.every((id) => h.el(id).hidden));
  h.calls.length = 0;
  h.panels.closeAll();
  assert.deepEqual(h.calls, [], "with nothing open, nothing runs");
  h.window.close();
});

test("a registered page closes through its own close, and the side panels leave it alone", () => {
  const h = setup();
  const off = h.panels.registerPage("start-page", () => { h.calls.push("start page closed"); });
  h.panels.open("comments-panel");
  h.calls.length = 0;
  h.panels.closeAll();
  assert.deepEqual(h.calls, ["closing"]);
  h.panels.close("start-page");
  assert.deepEqual(h.calls, ["closing", "start page closed"]);
  off();
  assert.throws(() => h.panels.close("start-page"), /start-page is not a side panel or a registered page/);
  h.window.close();
});

test("registrations are one per id and release only themselves", () => {
  const h = setup();
  const first = h.panels.registerPanel("broll-panel", () => { h.calls.push("first"); });
  assert.throws(() => h.panels.registerPanel("broll-panel", () => {}), /broll-panel is already registered/);
  first();
  const second = h.panels.registerPanel("broll-panel", () => { h.calls.push("second"); });
  first();
  h.panels.open("broll-panel");
  h.panels.close("broll-panel");
  assert.deepEqual(h.calls.filter((c) => c === "first" || c === "second"), ["second"]);
  second();
  assert.throws(() => h.panels.open("missing-panel"), /there is no side panel missing-panel/);
  h.window.close();
});
