import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureSchedule } from "../../src/application/recovery/capture-schedule.ts";
import type { CaptureSchedule, CaptureTiming } from "../../src/application/recovery/capture-schedule.ts";

const TIMING: CaptureTiming = { idle: 1500, max: 5000, slow: 15000, backoffMin: 5000, backoffMax: 60000 };

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly run: () => void;
}

function world(): { schedule: CaptureSchedule; captures: number[]; advance: (ms: number) => void; armed: () => number } {
  let now = 0;
  let next = 1;
  let timers: Pending[] = [];
  const captures: number[] = [];
  const schedule = createCaptureSchedule({
    timing: function () { return TIMING; },
    timers: {
      set: function (run: () => void, ms: number): unknown {
        const id = next++;
        timers.push({ id: id, at: now + ms, run: run });
        return id;
      },
      clear: function (handle: unknown): void {
        timers = timers.filter(function (t) { return t.id !== handle; });
      }
    },
    capture: function () { captures.push(now); }
  });
  function advance(ms: number): void {
    const until = now + ms;
    for (;;) {
      const due = timers.filter(function (t) { return t.at <= until; }).sort(function (a, b) { return a.at - b.at || a.id - b.id; })[0];
      if (!due) break;
      timers = timers.filter(function (t) { return t !== due; });
      now = due.at;
      due.run();
    }
    now = until;
  }
  return { schedule: schedule, captures: captures, advance: advance, armed: function () { return timers.length; } };
}

test("a change captures after 1.5 s of quiet, and no later than 5 s after the first change", () => {
  const w = world();
  w.schedule.noteChange();
  w.advance(1499);
  assert.deepEqual(w.captures, []);
  w.advance(1);
  assert.deepEqual(w.captures, [1500]);
  w.schedule.dropPending();
  const typing = world();
  for (let at = 0; at < 6000; at += 1000) {
    typing.schedule.noteChange();
    typing.advance(1000);
  }
  assert.equal(typing.captures[0], 5000, "steady typing is captured at the 5 s maximum");
});

test("a slow document waits 15 s for both", () => {
  const w = world();
  w.schedule.setSlow(true);
  w.schedule.noteChange();
  w.advance(14999);
  assert.deepEqual(w.captures, []);
  w.advance(1);
  assert.deepEqual(w.captures, [15000]);
});

test("refusals back off 5, 10, 20, 40 and at most 60 seconds, and a landed write starts over", () => {
  const w = world();
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(function () { return w.schedule.refused(); }), [5000, 10000, 20000, 40000, 60000, 60000]);
  w.schedule.landed();
  assert.equal(w.schedule.refused(), 5000);
});

test("the retry captures once its backoff has passed, and a change noted meanwhile arms nothing", () => {
  const w = world();
  w.schedule.refused();
  w.schedule.noteChange();
  assert.equal(w.armed(), 1, "only the retry is armed");
  assert.equal(w.schedule.backingOff(), true);
  w.advance(4999);
  assert.deepEqual(w.captures, []);
  w.advance(1);
  assert.deepEqual(w.captures, [5000]);
  assert.equal(w.schedule.pending(), true, "the change waits for the retry's capture to take it");
});

test("B4b: a change noted while a retry's write is in flight does not bring the next retry forward", () => {
  const w = world();
  w.schedule.refused();
  w.advance(5000);
  assert.deepEqual(w.captures, [5000], "the retry went out");
  w.schedule.noteChange();
  w.advance(100);
  assert.equal(w.schedule.refused(), 10000, "the retry failed, so the next wait is 10 s");
  w.advance(9999);
  assert.deepEqual(w.captures, [5000], "nothing went out before the backoff ended");
  w.advance(1);
  assert.deepEqual(w.captures, [5000, 15100]);
});

test("resume arms a capture only for a pending change and never during a backoff", () => {
  const w = world();
  w.schedule.resume();
  assert.equal(w.armed(), 0, "nothing pending, nothing armed");
  w.schedule.keepPending();
  w.schedule.resume();
  w.advance(1500);
  assert.deepEqual(w.captures, [1500]);
  w.schedule.refused();
  w.schedule.resume();
  assert.equal(w.armed(), 1, "only the retry");
});

test("cancelling clears the quiet timers and the retry, and keeps the change pending", () => {
  const w = world();
  w.schedule.noteChange();
  w.schedule.refused();
  w.schedule.cancel();
  w.schedule.cancelRetry();
  assert.equal(w.armed(), 0);
  assert.equal(w.schedule.backingOff(), false);
  assert.equal(w.schedule.pending(), true);
});
