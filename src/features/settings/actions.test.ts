import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../application/actions.ts";
import type { ScreenState } from "../../application/screen.ts";
import { settingsActions } from "./actions.ts";
import type { SettingsControls } from "./ports.ts";

test("settings forwards input only while mounted and available, and unregisters", () => {
  const registry = createActionRegistry();
  const screen: Record<keyof ScreenState, boolean> = { loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false };
  let current: SettingsControls | null = null;
  const calls: unknown[] = [];
  const stop = registerAll(registry, settingsActions(() => current, { screen: () => screen }));
  assert.equal(registry.invoke("settings", "menu").kind, "unavailable");
  current = { openSettings: (input) => { calls.push(input); } };
  const input = { focus: "settings-collab-server" };
  assert.equal(registry.invoke("settings", "button", input).kind, "ran");
  assert.equal(calls[0], input);
  assert.equal(registry.invoke("settings", "menu").kind, "ran");
  assert.equal(calls[1], undefined);
  for (const blocker of ["dialog", "tour"] as const) {
    screen[blocker] = true;
    assert.equal(registry.invoke("settings", "menu").kind, "unavailable");
    screen[blocker] = false;
  }
  assert.equal(calls.length, 2);
  current = null;
  assert.equal(registry.invoke("settings", "menu").kind, "unavailable");
  stop();
  assert.equal(registry.view("settings"), undefined);
});
