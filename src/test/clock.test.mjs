/* The one clock formatter (#180, 00p-prefs.js): the system's own format by
 * default, 12- or 24-hour when the person says so, and the header's "Saved
 * …" words after an hour — driven with fixed dates rather than the real
 * clock. The 12-hour and 24-hour checks do not depend on the machine's
 * locale; the "system" one compares against Intl itself.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_KEY,
  clockCycle,
  formatClock,
  formatDateClock,
  readClockPref,
  savedAgoPhrase
} from "../js/00p-prefs.js";

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

test("the save status: just now, minutes, then the clock time", () => {
  const saved = AFTERNOON.getTime();
  assert.equal(savedAgoPhrase(0, saved), "");
  assert.equal(savedAgoPhrase(saved, saved + 20 * 1000), "just now");
  assert.equal(savedAgoPhrase(saved, saved + 12 * 60000), "12 min ago");
  /* an hour later, a faked "now" */
  const later = saved + 65 * 60000;
  assert.match(savedAgoPhrase(saved, later, "12"), /^at 2:52\s?PM$/i);
  assert.equal(savedAgoPhrase(saved, later, "24"), "at 14:52");
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
