import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./_preferences-started.mjs";
import {
  clockCycle,
  formatClock,
  formatDateClock,
  savedStatusText,
  savedWhenText
} from "../../shared/clock.ts";
import { preferences } from "../bootstrap/wiring/preferences-owner.ts";

const CLOCK_KEY = "splitpage-clock";

const AFTERNOON = new Date(2026, 8, 24, 14, 52);
const MORNING = new Date(2026, 8, 24, 9, 5);
const MIDNIGHT = new Date(2026, 8, 24, 0, 15);

function expectedClock(when, options = {}) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", ...options }).format(when);
}

test("the clock uses the local language and time zone", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("./_clock-local-defaults.mjs", import.meta.url))], {
    env: { ...process.env, TZ: "America/Los_Angeles" }
  });
});

test("12-hour: local times in the morning, afternoon and after midnight", () => {
  for (const when of [AFTERNOON, MORNING, MIDNIGHT]) {
    assert.equal(formatClock(when, "12"), expectedClock(when, { hourCycle: "h12" }));
  }
});

test("24-hour: local times with midnight at hour zero", () => {
  for (const when of [AFTERNOON, MORNING, MIDNIGHT]) {
    assert.equal(formatClock(when, "24"), expectedClock(when, { hourCycle: "h23" }));
  }
});

test("system: exactly what Intl gives with no hour12 forced", () => {
  assert.equal(formatClock(AFTERNOON, "system"), expectedClock(AFTERNOON));
  assert.deepEqual(clockCycle("system"), {});
});

test("dates with a clock follow the same setting", () => {
  const date = { month: "short", day: "numeric" };
  assert.equal(formatDateClock(AFTERNOON, null, "12"), expectedClock(AFTERNOON, { ...date, hourCycle: "h12" }));
  assert.equal(formatDateClock(AFTERNOON, null, "24"), expectedClock(AFTERNOON, { ...date, hourCycle: "h23" }));
  assert.equal(formatDateClock(AFTERNOON, { year: true }, "24"),
    expectedClock(AFTERNOON, { ...date, year: "numeric", hourCycle: "h23" }));
});

test("garbage in is an empty string, not Invalid Date", () => {
  assert.equal(formatClock("not a date"), "");
  assert.equal(formatClock(""), "");
  assert.equal(formatDateClock(undefined), "");
});

test("the save status (#208): just now for a minute, then all saved — never an age", () => {
  const saved = AFTERNOON.getTime();
  assert.equal(savedStatusText(saved, saved + 20 * 1000), "Saved just now");
  assert.equal(savedStatusText(saved, saved + 59 * 1000), "Saved just now");
  assert.equal(savedStatusText(saved, saved + 60 * 1000), "All changes saved");
  assert.equal(savedStatusText(saved, saved + 43 * 60000), "All changes saved");
  assert.equal(savedStatusText(0, saved), "All changes saved");
  for (const n of [1, 12, 43, 65]) assert.doesNotMatch(savedStatusText(saved, saved + n * 60000), /ago|min/);
});

test("the save status's tooltip time: the clock the same day, a date after midnight", () => {
  const saved = AFTERNOON.getTime();
  assert.equal(savedWhenText(0, saved), "");
  const later = saved + 65 * 60000;
  assert.equal(savedWhenText(saved, later, "12"), expectedClock(AFTERNOON, { hourCycle: "h12" }));
  assert.equal(savedWhenText(saved, later, "24"), expectedClock(AFTERNOON, { hourCycle: "h23" }));
  assert.equal(savedWhenText(saved, later, "system"), expectedClock(AFTERNOON));
  const nextDay = saved + 12 * 3600000;
  assert.equal(savedWhenText(saved, nextDay, "24"),
    expectedClock(AFTERNOON, { month: "short", day: "numeric", hourCycle: "h23" }));
});

test("the preference: system unless it says 12 or 24", () => {
  localStorage.removeItem(CLOCK_KEY);
  assert.equal(preferences().clock(), "system");
  localStorage.setItem(CLOCK_KEY, "12");
  assert.equal(preferences().clock(), "12");
  assert.equal(formatClock(AFTERNOON, preferences().clock()), expectedClock(AFTERNOON, { hourCycle: "h12" }));
  localStorage.setItem(CLOCK_KEY, "24");
  assert.equal(formatClock(AFTERNOON, preferences().clock()), expectedClock(AFTERNOON, { hourCycle: "h23" }));
  localStorage.setItem(CLOCK_KEY, "13");
  assert.equal(preferences().clock(), "system");
  localStorage.removeItem(CLOCK_KEY);
});
