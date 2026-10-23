"use strict";

function formatTimestampAbsolute(iso, clockMode) {
  try {
    const d = new Date(iso === null ? 0 : iso === undefined ? NaN : iso);
    if (isNaN(d.getTime())) return "";
    return formatDateClock(d, { year: true }, clockMode);
  } catch (e) { return ""; }
}

function clockCycle(mode) {
  if (mode === "12") return { hourCycle: "h12" };
  if (mode === "24") return { hourCycle: "h23" };
  return {};
}

function withCycle(opts, mode) {
  var cycle = clockCycle(mode);
  var out = {};
  Object.keys(opts).forEach(function (k) { out[k] = opts[k]; });
  Object.keys(cycle).forEach(function (k) { out[k] = cycle[k]; });
  return out;
}

function toDate(when) {
  var d = when instanceof Date ? when : new Date(when);
  return isNaN(d.getTime()) ? null : d;
}

function formatClock(when, mode) {
  var d = toDate(when);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(undefined, withCycle({ hour: "numeric", minute: "2-digit" }, mode)).format(d);
  } catch (e) {
    return d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }
}

function formatDateClock(when, opts, mode) {
  var d = toDate(when);
  if (!d) return "";
  var o = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (opts && opts.year) o.year = "numeric";
  try {
    return new Intl.DateTimeFormat(undefined, withCycle(o, mode)).format(d);
  } catch (e) {
    return d.toDateString() + " " + formatClock(d, mode);
  }
}

var SAVED_JUST_NOW_MS = 60000;

function savedStatusText(savedAt, now) {
  return savedAt && now - savedAt < SAVED_JUST_NOW_MS ? "Saved just now" : "All changes saved";
}

function savedWhenText(savedAt, now, mode) {
  if (!savedAt) return "";
  var at = new Date(savedAt);
  return at.toDateString() === new Date(now).toDateString()
    ? formatClock(at, mode) : formatDateClock(at, null, mode);
}

module.exports = {
  SAVED_JUST_NOW_MS,
  clockCycle,
  formatClock,
  formatDateClock,
  formatTimestampAbsolute,
  savedStatusText,
  savedWhenText
};
