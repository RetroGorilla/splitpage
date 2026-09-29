import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_KEY,
  clockCycle,
  formatClock,
  formatDateClock,
  readClockPref,
  savedStatusText,
  savedWhenText
} from "../js/00p-prefs.js";

// Local-time dates keep checks independent of machine timezone
const AFTERNOON = new Date(2026, 8, 24, 14, 52);
const MORNING = new Date(2026, 8, 24, 9, 5);
const MIDNIGHT = new Date(2026, 8, 24, 0, 15);

test("12-hour: 2:52 PM, 9:05 AM, 12:15 AM", () => {
  assert.match(formatClock(AFTERNOON, "12"), /\b2:52\b/);
  assert.match(formatClock(AFTERNOON, "12"), /PM|p\.?m\.?/i);
  assert.match(formatClock(MORNING, "12"), /\b9:05\b/);
  assert.match(formatClock(MORNING, "12"), /AM|a\.?m\.?/i);
  assert.match(formatClock(MIDNIGHT, "12"), /\b12:15\b/);
});

test("24-hour: 14:52 and a quarter past midnight as 00:15, never 24:15", () => {
  assert.match(formatClock(AFTERNOON, "24"), /\b14:52\b/);
  assert.doesNotMatch(formatClock(AFTERNOON, "24"), /AM|PM/i);
  assert.match(formatClock(MORNING, "24"), /\b0?9:05\b/);
  assert.match(formatClock(MIDNIGHT, "24"), /\b00:15\b/);
});

test("system: exactly what Intl gives with no hour12 forced", () => {
  const want = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(AFTERNOON);
  assert.equal(formatClock(AFTERNOON, "system"), want);
  assert.deepEqual(clockCycle("system"), {});
});

test("dates with a clock follow the same setting", () => {
  const twelve = formatDateClock(AFTERNOON, null, "12");
  assert.match(twelve, /2:52/);
  assert.match(twelve, /PM/i);
  assert.match(formatDateClock(AFTERNOON, null, "24"), /14:52/);
  assert.match(formatDateClock(AFTERNOON, { year: true }, "24"), /2026/);
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
  assert.match(savedWhenText(saved, later, "12"), /^2:52\s?PM$/i);
  assert.equal(savedWhenText(saved, later, "24"), "14:52");
  assert.equal(savedWhenText(saved, later, "system"), formatClock(AFTERNOON, "system"));
  const nextDay = saved + 12 * 3600000;
  assert.equal(savedWhenText(saved, nextDay, "24"), formatDateClock(AFTERNOON, null, "24"));
  assert.match(savedWhenText(saved, nextDay, "24"), /14:52/);
  assert.notEqual(savedWhenText(saved, nextDay, "24"), "14:52");
});

test("the preference: system unless it says 12 or 24", () => {
  localStorage.removeItem(CLOCK_KEY);
  assert.equal(readClockPref(), "system");
  localStorage.setItem(CLOCK_KEY, "12");
  assert.equal(readClockPref(), "12");
  assert.match(formatClock(AFTERNOON), /PM/i);
  localStorage.setItem(CLOCK_KEY, "24");
  assert.equal(formatClock(AFTERNOON), "14:52");
  localStorage.setItem(CLOCK_KEY, "13");
  assert.equal(readClockPref(), "system");
  localStorage.removeItem(CLOCK_KEY);
});
