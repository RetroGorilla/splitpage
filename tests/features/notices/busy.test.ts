import "../../../src/test/_dom.mjs";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { beginBusy, endBusy, withBusyBar } from "../../../src/features/notices/busy.ts";

const SHOW_DELAY_MS = 250;

function bars(): Element[] {
  return Array.from(document.querySelectorAll(".busy-bar"));
}

function barIsOn(): boolean {
  return bars().some((bar) => bar.classList.contains("is-on"));
}

function barLabel(): string | null {
  return document.querySelector(".busy-bar-label")?.textContent ?? null;
}

function reset(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    document.querySelectorAll(".busy-bar").forEach((bar) => bar.remove());
  });
}

test("busy bar: stays hidden for a short job and never shows", (t) => {
  reset(t);
  const token = beginBusy("Saving");
  t.mock.timers.tick(SHOW_DELAY_MS - 1);
  assert.equal(bars().length, 0);
  endBusy(token);
  t.mock.timers.tick(SHOW_DELAY_MS * 4);
  assert.equal(barIsOn(), false);
  assert.equal(bars().length, 0);
});

test("busy bar: shows the label once the delay has passed and hides when the job ends", (t) => {
  reset(t);
  const token = beginBusy("Exporting");
  t.mock.timers.tick(SHOW_DELAY_MS);
  assert.equal(bars().length, 1);
  assert.equal(barIsOn(), true);
  assert.equal(barLabel(), "Exporting");
  const bar = bars()[0] as HTMLElement;
  assert.equal(bar.getAttribute("role"), "status");
  assert.equal(bar.getAttribute("aria-live"), "polite");
  endBusy(token);
  assert.equal(barIsOn(), false);
});

test("busy bar: falls back to a default label when none is given", (t) => {
  reset(t);
  const token = beginBusy();
  t.mock.timers.tick(SHOW_DELAY_MS);
  assert.match(barLabel() ?? "", /^Working/);
  endBusy(token);
});

test("busy bar: stays on until every overlapping job has ended", (t) => {
  reset(t);
  const first = beginBusy("First");
  const second = beginBusy("Second");
  t.mock.timers.tick(SHOW_DELAY_MS);
  assert.equal(barLabel(), "First");
  endBusy(first);
  assert.equal(barIsOn(), true);
  endBusy(second);
  assert.equal(barIsOn(), false);
});

test("busy bar: a later job with a label relabels a bar that is already showing", (t) => {
  reset(t);
  const first = beginBusy("First");
  t.mock.timers.tick(SHOW_DELAY_MS);
  const second = beginBusy("Second");
  assert.equal(barLabel(), "Second");
  const third = beginBusy();
  assert.equal(barLabel(), "Second");
  endBusy(first);
  endBusy(second);
  endBusy(third);
  assert.equal(barIsOn(), false);
});

test("busy bar: ending the same token twice, or a missing token, counts once", (t) => {
  reset(t);
  const outer = beginBusy("Outer");
  const inner = beginBusy("Inner");
  t.mock.timers.tick(SHOW_DELAY_MS);
  endBusy(inner);
  endBusy(inner);
  endBusy(undefined);
  endBusy(null);
  assert.equal(barIsOn(), true);
  endBusy(outer);
  assert.equal(barIsOn(), false);
});

test("busy bar: a new job after the bar was shown and hidden shows it again", (t) => {
  reset(t);
  endBusy(beginBusy("One"));
  const token = beginBusy("Two");
  t.mock.timers.tick(SHOW_DELAY_MS);
  assert.equal(barIsOn(), true);
  assert.equal(barLabel(), "Two");
  assert.equal(bars().length, 1);
  endBusy(token);
});

test("busy bar: builds a fresh bar when the old one was removed from the page", (t) => {
  reset(t);
  const first = beginBusy("One");
  t.mock.timers.tick(SHOW_DELAY_MS);
  bars().forEach((bar) => bar.remove());
  endBusy(first);
  const second = beginBusy("Two");
  t.mock.timers.tick(SHOW_DELAY_MS);
  assert.equal(bars().length, 1);
  assert.equal(barLabel(), "Two");
  endBusy(second);
});

test("withBusyBar: returns the result and ends the job", async (t) => {
  reset(t);
  const result = await withBusyBar("Working", async () => {
    t.mock.timers.tick(SHOW_DELAY_MS);
    assert.equal(barIsOn(), true);
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(barIsOn(), false);
});

test("withBusyBar: ends the job and rethrows when the work fails", async (t) => {
  reset(t);
  await assert.rejects(
    withBusyBar("Working", async () => {
      t.mock.timers.tick(SHOW_DELAY_MS);
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(barIsOn(), false);
  const token = beginBusy("After");
  t.mock.timers.tick(SHOW_DELAY_MS);
  assert.equal(barIsOn(), true);
  endBusy(token);
});
