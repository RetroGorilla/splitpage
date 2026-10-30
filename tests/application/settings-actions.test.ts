import test from "node:test";
import assert from "node:assert/strict";
import { installSettingsControls, openSettings, settingsAction } from "../../src/application/settings-actions.ts";
import type { SettingsControls } from "../../src/application/settings-actions.ts";
import type { ScreenState } from "../../src/application/screen.ts";

test("opening settings throws while no controls are installed, and forwards input to the installed ones", () => {
  assert.throws(() => openSettings(), /settings controls are not installed/);
  const calls: unknown[] = [];
  const first = installSettingsControls({ openSettings: (input) => { calls.push(["first", input]); } });
  const second = installSettingsControls({ openSettings: (input) => { calls.push(["second", input]); } });
  first();
  const input = { focus: "settings-name" };
  openSettings(input);
  assert.deepEqual(calls, [["second", input]]);
  second();
  assert.throws(() => openSettings(input), /settings controls are not installed/);
  assert.equal(calls.length, 1);
});

const CLEAR: ScreenState = { loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false };

function controls(opened: unknown[]): SettingsControls {
  return { openSettings: (input) => { opened.push(input); } };
}

test("opening settings without an input passes undefined to the installed controls", () => {
  const opened: unknown[] = [];
  const stop = installSettingsControls(controls(opened));
  try {
    openSettings("theme");
    openSettings();
    assert.deepEqual(opened, ["theme", undefined]);
  } finally {
    stop();
  }
});

test("the settings action describes itself for the menus", () => {
  const action = settingsAction(() => null, () => CLEAR);
  assert.equal(action.id, "settings");
  assert.equal(action.label, "Settings");
  assert.equal(action.group, "Help");
  assert.equal(action.icon, "i-settings");
  assert.match(action.words ?? "", /\bsettings\b/);
  assert.match(action.words ?? "", /\bdark\b/);
});

test("the settings action is disabled, with no reason, until controls exist", () => {
  const action = settingsAction(() => null, () => CLEAR);
  assert.deepEqual(action.availability?.("menu"), { enabled: false });
});

test("the settings action is enabled when controls exist and no dialog or tour is up", () => {
  const action = settingsAction(() => controls([]), () => CLEAR);
  assert.deepEqual(action.availability?.("menu"), { enabled: true });
});

test("the settings action refuses while a dialog or the tour is up, and not for other overlays", () => {
  const live = controls([]);
  const at = (screen: Partial<ScreenState>) => settingsAction(() => live, () => ({ ...CLEAR, ...screen })).availability?.("menu");
  assert.deepEqual(at({ dialog: true }), { enabled: false, reason: "Close the open dialog first" });
  assert.deepEqual(at({ tour: true }), { enabled: false, reason: "Finish or skip the tour first" });
  assert.deepEqual(at({ writer: true, shotlist: true, prompter: true, launcher: true, loading: true }), { enabled: true });
});

test("running the settings action opens the current controls with its input", () => {
  const opened: unknown[] = [];
  const action = settingsAction(() => controls(opened), () => CLEAR);
  void action.run("menu", "clock");
  void action.run("shortcut");
  assert.deepEqual(opened, ["clock", undefined]);
});

test("running the settings action with no controls does nothing and does not throw", () => {
  const action = settingsAction(() => null, () => CLEAR);
  assert.doesNotThrow(() => { void action.run("menu", "clock"); });
});

test("the settings action reads the controls and screen afresh on every call", () => {
  let current: SettingsControls | null = null;
  let screen = CLEAR;
  const action = settingsAction(() => current, () => screen);
  assert.equal(action.availability?.("menu").enabled, false);
  current = controls([]);
  assert.equal(action.availability?.("menu").enabled, true);
  screen = { ...CLEAR, dialog: true };
  assert.equal(action.availability?.("menu").enabled, false);
});
