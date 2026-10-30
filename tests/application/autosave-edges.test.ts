import { test } from "node:test";
import assert from "node:assert/strict";
import { HALTED_BY_DEFAULT, createAutoSavePolicy } from "../../src/application/save/autosave.ts";
import type { AutoSavePolicy } from "../../src/application/save/autosave.ts";

interface Rig {
  policy: AutoSavePolicy;
  started: number[];
  stopped: unknown[];
}

function rig(enabledAtStart: () => boolean = function () { return true; }): Rig {
  const started: number[] = [];
  const stopped: unknown[] = [];
  const policy = createAutoSavePolicy({
    timers: {
      start: function (_run: () => void, ms: number) { started.push(ms); return started.length; },
      stop: function (handle: unknown) { stopped.push(handle); }
    },
    enabledAtStart: enabledAtStart,
    due: function () {},
    changed: function () {}
  });
  return { policy: policy, started: started, stopped: stopped };
}

test("the paused wording shown when a save halts autosave without a reason", () => {
  assert.equal(HALTED_BY_DEFAULT, "Autosave is paused — press Save to try again.");
});

test("enabled is a real boolean whatever the start-up answer or the setter is given", () => {
  assert.equal(rig(function () { return 1 as unknown as boolean; }).policy.enabled(), true);
  assert.equal(rig(function () { return 0 as unknown as boolean; }).policy.enabled(), false);
  const { policy } = rig();
  policy.setEnabled("yes" as unknown as boolean);
  assert.equal(policy.enabled(), true);
  policy.setEnabled(0 as unknown as boolean);
  assert.equal(policy.enabled(), false);
});

test("turning autosave on while a save is already pending leaves the pending timers running", () => {
  const { policy, started, stopped } = rig();
  policy.schedule("file");
  assert.deepEqual(started, [2000, 15000]);
  policy.setEnabled(true);
  assert.equal(policy.pending(), true);
  assert.deepEqual(stopped, []);
  policy.setEnabled(false);
  assert.equal(policy.pending(), false);
  assert.deepEqual(stopped, [1, 2]);
});
