import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUTOSAVE_TIMING, HALTED_BY_DEFAULT, createAutoSavePolicy } from "../../src/application/save/autosave.ts";
import type { AutoSaveChange, AutoSavePolicy } from "../../src/application/save/autosave.ts";

interface Timer {
  readonly run: () => void;
  readonly ms: number;
  live: boolean;
}

interface Bench {
  readonly policy: AutoSavePolicy;
  readonly timers: Timer[];
  readonly changes: AutoSaveChange[];
  due: number;
}

function bench(enabled = true): Bench {
  const timers: Timer[] = [];
  const changes: AutoSaveChange[] = [];
  const b = { timers, changes, due: 0 } as unknown as Bench;
  const policy = createAutoSavePolicy({
    timers: {
      start: function (run, ms) {
        const timer: Timer = { run: run, ms: ms, live: true };
        timers.push(timer);
        return timer;
      },
      stop: function (handle) { (handle as Timer).live = false; }
    },
    enabledAtStart: function () { return enabled; },
    due: function () { b.due++; },
    changed: function (what) { changes.push(what); }
  });
  (b as { policy: AutoSavePolicy }).policy = policy;
  return b;
}

function live(b: Bench): number[] {
  return b.timers.filter(function (t) { return t.live; }).map(function (t) { return t.ms; });
}

test("the start-up preference is read once, when first needed, and decides whether autosave is on", () => {
  let reads = 0;
  const policy = createAutoSavePolicy({
    timers: { start: () => 1, stop: () => {} },
    enabledAtStart: () => { reads++; return false; },
    due: () => {},
    changed: () => {}
  });
  assert.equal(reads, 0, "building the policy reads no preference");
  assert.equal(policy.may("file"), false);
  assert.equal(policy.enabled(), false);
  assert.equal(reads, 1, "the preference is read once");
  policy.setEnabled(true);
  assert.equal(policy.enabled(), true);
  assert.equal(reads, 1, "a change replaces the start-up preference without reading it again");
});

test("the start-up preference decides whether autosave is on, and nothing is armed or announced", () => {
  assert.equal(bench(true).policy.enabled(), true);
  const off = bench(false);
  assert.equal(off.policy.enabled(), false);
  assert.equal(off.policy.halted(), "");
  assert.equal(off.policy.pending(), false);
  assert.deepEqual(off.timers, []);
  assert.deepEqual(off.changes, []);
});

test("timing: a hosted document waits longer than a local file, both under the max, and anything not the server gets the local idle", () => {
  const p = bench().policy;
  assert.deepEqual({ ...p.timing }, { idle: 2000, hostedIdle: 5000, max: 15000 });
  assert.ok(p.idleFor("server") > p.idleFor("file"));
  assert.equal(p.idleFor("file"), 2000);
  assert.equal(p.idleFor(null), p.timing.idle);
  assert.ok(p.timing.hostedIdle < p.timing.max);
  assert.ok(p.timing.idle < p.timing.max);
  assert.ok(Object.isFrozen(DEFAULT_AUTOSAVE_TIMING));
});

test("timing: the policy's timing stays live, which the browser suite relies on, and each policy has its own", () => {
  const b = bench();
  b.policy.timing.hostedIdle = 7;
  assert.equal(b.policy.idleFor("server"), 7);
  b.policy.schedule("server");
  assert.deepEqual(live(b), [7, 15000]);
  assert.equal(bench().policy.idleFor("server"), 5000, "a new policy starts from the defaults");
});

test("schedule arms the idle and max timers once each; another schedule re-arms only the idle", () => {
  const b = bench();
  b.policy.schedule("file");
  assert.deepEqual(live(b), [2000, 15000]);
  assert.equal(b.policy.pending(), true);
  assert.equal(b.policy.scheduled(), 1);
  b.policy.schedule("file");
  assert.deepEqual(live(b), [15000, 2000], "the old idle timer is stopped, the max timer kept");
  assert.equal(b.timers.length, 3);
  assert.equal(b.policy.scheduled(), 2, "every arm of the idle timer counts");
  assert.deepEqual(b.changes, [], "arming announces nothing");
});

test("schedule does nothing when autosave is off, halted, or has nowhere to write", () => {
  const off = bench(false);
  off.policy.schedule("file");
  const halted = bench();
  halted.policy.halt("Paused.");
  halted.policy.schedule("server");
  const nowhere = bench();
  nowhere.policy.schedule(null);
  for (const b of [off, halted, nowhere]) {
    assert.equal(b.policy.pending(), false);
    assert.equal(b.policy.scheduled(), 0);
  }
  assert.equal(off.policy.may("file"), false);
  assert.equal(halted.policy.may("file"), false);
  assert.equal(nowhere.policy.may(null), false);
  assert.equal(bench().policy.may("file"), true);
});

test("either timer firing clears both and calls due once", () => {
  for (const which of [0, 1]) {
    const b = bench();
    b.policy.schedule("file");
    const fired = b.timers[which];
    assert.ok(fired);
    fired.run();
    assert.equal(b.due, 1);
    assert.deepEqual(live(b), [], "the other timer is stopped");
    assert.equal(b.policy.pending(), false);
  }
});

test("clear stops both timers without calling due", () => {
  const b = bench();
  b.policy.schedule("server");
  b.policy.clear();
  assert.deepEqual(live(b), []);
  assert.equal(b.policy.pending(), false);
  assert.equal(b.due, 0);
  b.policy.clear();
  assert.equal(b.timers.length, 2, "clearing nothing arms nothing");
});

test("setEnabled announces the change; turning it off stops the timers, turning it on arms none", () => {
  const b = bench();
  b.policy.schedule("file");
  b.policy.setEnabled(false);
  assert.equal(b.policy.enabled(), false);
  assert.deepEqual(live(b), []);
  b.policy.setEnabled(true);
  assert.equal(b.policy.enabled(), true);
  assert.deepEqual(live(b), [], "the caller schedules if there is something to save");
  assert.deepEqual(b.changes, ["enabled", "enabled"]);
});

test("halt stops the timers, keeps its reason or the default, and announces; resume clears it and announces once", () => {
  const b = bench();
  b.policy.schedule("file");
  b.policy.halt("The server said no.");
  assert.equal(b.policy.halted(), "The server said no.");
  assert.deepEqual(live(b), []);
  b.policy.halt("");
  assert.equal(b.policy.halted(), HALTED_BY_DEFAULT);
  assert.equal(b.policy.resume(), true);
  assert.equal(b.policy.halted(), "");
  assert.equal(b.policy.resume(), false, "resuming when nothing is halted changes nothing");
  assert.deepEqual(b.changes, ["halt", "halt", "halt"]);
});

test("stop clears the timers and no schedule after it arms one", () => {
  const b = bench();
  b.policy.schedule("file");
  b.policy.stop();
  assert.deepEqual(live(b), []);
  b.policy.schedule("file");
  assert.equal(b.timers.length, 2);
  assert.equal(b.policy.pending(), false);
});
