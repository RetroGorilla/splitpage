import { test } from "node:test";
import assert from "node:assert/strict";
import type { Command } from "../../src/application/session/document-session.ts";
import { cellEdit } from "../../src/application/session/change-set.ts";
import { REFRESH_TIMING, createEffectScheduler } from "../../src/application/session/effects.ts";
import { fakeClock, harness, rawScript, runConfined } from "./session-fakes.ts";

function typeInto(rowId: string, text: string): Command {
  return {
    name: "type",
    needs: "edit",
    plan: function () {
      return {
        changes: cellEdit(rowId, "audioText", ["production", "writerStats"]),
        apply: function (live) {
          const row = live.rows.find(function (r) { return r.id === rowId; });
          if (row) row.audioText = text;
        }
      };
    }
  };
}

function typing(h: ReturnType<typeof harness>, keys: number, gap: number): void {
  let text = "";
  for (let i = 0; i < keys; i++) {
    text += "a";
    runConfined(h.session, typeInto("r1", text));
    h.clock.advance(gap);
  }
}

test("INV-06: a burst of typing change sets inside the idle window runs each derivation once, 180 ms after the last key", () => {
  const h = harness();
  h.session.adopt(rawScript("Harbour"));
  typing(h, 6, 100);
  assert.equal(h.session.generation(), 6, "every key was its own accepted edit");
  assert.deepEqual(h.refreshes, [], "nothing derived while the keys keep coming");
  h.clock.advance(79);
  assert.deepEqual(h.refreshes, []);
  h.clock.advance(1);
  assert.deepEqual(h.refreshes, [["production", "writerStats"]], "one refresh for the burst, each derivation once");
  h.clock.advance(5000);
  assert.equal(h.refreshes.length, 1, "and nothing after it");
});

test("INV-06: steady typing still derives at most once a second, as the idle refresh does today", () => {
  const h = harness();
  h.session.adopt(rawScript("Harbour"));
  typing(h, 25, 100);
  assert.equal(h.refreshes.length, 2, "at 1,000 ms and 2,000 ms into a 2,500 ms burst");
  h.clock.advance(79);
  assert.equal(h.refreshes.length, 2);
  h.clock.advance(1);
  assert.equal(h.refreshes.length, 3, "and once, 180 ms after the last key");
  h.refreshes.forEach(function (jobs) { assert.deepEqual(jobs, ["production", "writerStats"]); });
});

test("the scheduler's refresh waits the idle time, never past the cap measured from the first request, and starts a fresh window after it runs", () => {
  const clock = fakeClock();
  const ran: string[][] = [];
  const scheduler = createEffectScheduler({
    dirty: function () {}, draft: function () {}, save: function () {},
    refresh: function (jobs) { ran.push(Array.from(jobs)); }
  }, clock);
  assert.deepEqual(REFRESH_TIMING, { idleMs: 180, maxMs: 1000 });
  scheduler.refresh("broll");
  clock.advance(170);
  scheduler.refresh("untagged");
  scheduler.refresh("broll");
  assert.deepEqual(scheduler.pending().slice().sort(), ["broll", "untagged"]);
  clock.advance(179);
  assert.deepEqual(ran, []);
  clock.advance(1);
  assert.deepEqual(ran, [["broll", "untagged"]]);
  assert.deepEqual(scheduler.pending(), []);
  assert.equal(clock.armed(), 0);
  for (let t = 0; t < 990; t += 90) { scheduler.refresh("production"); clock.advance(90); }
  assert.equal(ran.length, 1, "990 ms of requests 90 ms apart: still waiting");
  scheduler.refresh("production");
  clock.advance(9);
  assert.equal(ran.length, 1);
  clock.advance(1);
  assert.equal(ran.length, 2, "the cap fired the second window 1,000 ms after its first request");
  scheduler.refresh("production");
  assert.equal(clock.armed(), 1, "a request after a run arms one timer");
  clock.advance(180);
  assert.equal(ran.length, 3);
});

test("a request after the cap has passed, while a late timer is still pending, runs at once", () => {
  const clock = fakeClock();
  const ran: string[][] = [];
  const scheduler = createEffectScheduler({
    dirty: function () {}, draft: function () {}, save: function () {},
    refresh: function (jobs) { ran.push(Array.from(jobs)); }
  }, clock);
  scheduler.refresh("production");
  clock.stall(1500);
  scheduler.refresh("broll");
  clock.advance(0);
  assert.deepEqual(ran, [["production", "broll"]]);
});

test("an effect pass runs dirty, draft and save once each, in that order, and hands its derivations to the refresh", () => {
  const clock = fakeClock();
  const log: string[] = [];
  const scheduler = createEffectScheduler({
    dirty: function () { log.push("dirty"); }, draft: function () { log.push("draft"); }, save: function () { log.push("save"); },
    refresh: function (jobs) { log.push("refresh:" + Array.from(jobs).join(",")); }
  }, clock);
  scheduler.pass({ kind: "edit", epoch: 1, generation: 1, changes: cellEdit("r1", "audioText", ["production"]) });
  assert.deepEqual(log, ["dirty", "draft", "save"]);
  clock.advance(180);
  assert.deepEqual(log, ["dirty", "draft", "save", "refresh:production"]);
});
