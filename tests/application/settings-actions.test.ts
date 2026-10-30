import test from "node:test";
import assert from "node:assert/strict";
import { installSettingsControls, openSettings } from "../../src/application/settings-actions.ts";

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
