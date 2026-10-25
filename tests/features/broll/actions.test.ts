import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../../src/application/actions.ts";
import { brollPanelActions } from "../../../src/features/broll/actions.ts";
import type { BrollPanelState } from "../../../src/features/broll/ports.ts";
import { fakeScreen } from "../fakes.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
(globalThis as unknown as Record<string, unknown>).document = win.document;

test("B-roll actions refuse while unmounted, retain loading availability, and follow the current mount", () => {
  win.document.body.innerHTML = '<button id="btn-broll"></button><div id="broll-panel" hidden></div>';
  const screen = fakeScreen();
  let current: BrollPanelState | null = null;
  const calls: string[] = [];
  const registry = createActionRegistry();
  const off = registerAll(registry, brollPanelActions(() => current, { screen: screen.screen, panels: { close: (id) => { calls.push("close:" + id); } } }));
  try {
    assert.equal(registry.invoke("panel-broll", "button").kind, "unavailable");
    assert.equal(calls.length, 0);
    current = { openBrollPanel: () => { calls.push("first"); }, dispose: () => {} };
    screen.state.loading = true;
    assert.equal(registry.invoke("panel-broll", "button").kind, "ran");
    current = { openBrollPanel: () => { calls.push("second"); }, dispose: () => {} };
    assert.equal(registry.invoke("panel-broll", "button").kind, "ran");
    screen.state.dialog = true;
    assert.equal(registry.invoke("panel-broll", "button").kind, "unavailable");
    current = null;
    screen.state.dialog = false;
    assert.equal(registry.invoke("panel-broll", "menu").kind, "unavailable");
    assert.deepEqual(calls, ["first", "second"]);
  } finally { off(); }
});
