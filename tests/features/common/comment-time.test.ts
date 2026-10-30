import test from "node:test";
import assert from "node:assert/strict";
import { formatClock, formatDateClock } from "../../../shared/clock.js";
import { formatTimestamp } from "../../../src/features/common/comment-time.js";

test("formatTimestamp: shows only the clock time for a moment today", () => {
  const now = new Date();
  assert.equal(formatTimestamp(now.toISOString()), formatClock(now));
  assert.equal(formatTimestamp(now.toISOString(), "24"), formatClock(now, "24"));
  assert.equal(formatTimestamp(now.toISOString(), "12"), formatClock(now, "12"));
});

test("formatTimestamp: shows the date and clock time for an earlier day", () => {
  const iso = "2001-03-04T15:30:00.000Z";
  const d = new Date(iso);
  assert.equal(formatTimestamp(iso), formatDateClock(d, null, undefined));
  assert.equal(formatTimestamp(iso, "24"), formatDateClock(d, null, "24"));
  assert.notEqual(formatTimestamp(iso), formatClock(d));
});

test("formatTimestamp: returns an empty string for values that are not dates", () => {
  assert.equal(formatTimestamp("not a date"), "");
  assert.equal(formatTimestamp(undefined), "");
  assert.equal(formatTimestamp({ toString() { throw new Error("boom"); } }), "");
});
