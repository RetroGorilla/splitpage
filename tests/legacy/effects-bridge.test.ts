import test from "node:test";
import assert from "node:assert/strict";
import type { EffectPorts, Notice } from "../../src/application/effects/ports.ts";
import {
  copyShareText,
  effectsStarted,
  setMenuItemLabel,
  setMenuItemReason,
  showActionToast,
  showToast,
  startEffects
} from "../../src/legacy/effects-bridge.ts";

function recorder(): { calls: unknown[][]; ports: EffectPorts<Element> } {
  const calls: unknown[][] = [];
  const notice: Notice = { isConnected: true, dismiss: () => {}, removeEventListener: () => {} };
  const ports: EffectPorts<Element> = {
    notices: {
      show: (...args) => { calls.push(["show", ...args]); return notice; },
      showAction: (...args) => { calls.push(["showAction", ...args]); return notice; }
    },
    menuItems: {
      setLabel: (...args) => { calls.push(["setLabel", ...args]); },
      setReason: (...args) => { calls.push(["setReason", ...args]); }
    },
    clipboard: { copyText: (text) => { calls.push(["copyText", text]); return Promise.resolve(true); } }
  };
  return { calls, ports };
}

test("before the ports are started, every effect throws instead of doing nothing", () => {
  assert.equal(effectsStarted(), false);
  assert.throws(() => showToast("x"), /not started yet/);
  assert.throws(() => showActionToast("x", "", "Undo", () => {}), /not started yet/);
  assert.throws(() => setMenuItemLabel(null, "x"), /not started yet/);
  assert.throws(() => setMenuItemReason(null, "x"), /not started yet/);
  assert.throws(() => copyShareText("x"), /not started yet/);
});

test("started ports receive each effect's arguments, and the stop function takes them back", async () => {
  const { calls, ports } = recorder();
  const stop = startEffects(ports);
  try {
    assert.equal(effectsStarted(), true);
    showToast("Saved", "ok", true);
    const onAction = (): void => {};
    showActionToast("Gone", "warn", "Undo", onAction);
    setMenuItemLabel(null, "Open");
    setMenuItemReason(null, "Busy");
    assert.equal(await copyShareText("link"), true);
    assert.deepEqual(calls, [
      ["show", "Saved", "ok", true],
      ["showAction", "Gone", "warn", "Undo", onAction, undefined],
      ["setLabel", null, "Open"],
      ["setReason", null, "Busy"],
      ["copyText", "link"]
    ]);
  } finally {
    stop();
  }
  assert.equal(effectsStarted(), false);
  assert.throws(() => showToast("x"), /not started yet/);
  assert.throws(() => copyShareText("x"), /not started yet/);
  assert.doesNotThrow(() => setMenuItemLabel(null, "late"));
  assert.doesNotThrow(() => setMenuItemReason(null, "late"));
  assert.equal(calls.length, 5, "a menu update that arrives after the stop is dropped");
});

test("a second start is refused until the first is stopped, and an old stop leaves a newer start in place", () => {
  const first = startEffects(recorder().ports);
  assert.throws(() => startEffects(recorder().ports), /already started/);
  first();
  const second = startEffects(recorder().ports);
  try {
    first();
    assert.equal(effectsStarted(), true);
  } finally {
    second();
  }
});
