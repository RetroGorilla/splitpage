"use strict";

function formatTimestampAbsolute(iso: unknown, clockMode?: string) {
  try {
    const d = new Date(iso === null ? 0 : iso === undefined ? NaN : iso as string | number);
    if (isNaN(d.getTime())) return "";
    return formatDateClock(d, { year: true }, clockMode);
  } catch (e) { return ""; }
}

function clockCycle(mode?: string): Intl.DateTimeFormatOptions {
  if (mode === "12") return { hourCycle: "h12" };
  if (mode === "24") return { hourCycle: "h23" };
  return {};
}

function withCycle(opts: Intl.DateTimeFormatOptions, mode?: string): Intl.DateTimeFormatOptions {
  const cycle = clockCycle(mode);
  const out: Record<string, Intl.DateTimeFormatOptions[keyof Intl.DateTimeFormatOptions]> = {};
  Object.keys(opts).forEach(function (k) { out[k] = opts[k as keyof Intl.DateTimeFormatOptions]; });
  Object.keys(cycle).forEach(function (k) { out[k] = cycle[k as keyof Intl.DateTimeFormatOptions]; });
  return out;
}

function toDate(when: unknown) {
  const d = when instanceof Date ? when : new Date(when as string | number);
  return isNaN(d.getTime()) ? null : d;
}

function formatClock(when: unknown, mode?: string) {
  const d = toDate(when);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(undefined, withCycle({ hour: "numeric", minute: "2-digit" }, mode)).format(d);
  } catch (e) {
    return d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }
}

function formatDateClock(when: unknown, opts?: { year?: boolean } | null, mode?: string) {
  const d = toDate(when);
  if (!d) return "";
  const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (opts && opts.year) o.year = "numeric";
  try {
    return new Intl.DateTimeFormat(undefined, withCycle(o, mode)).format(d);
  } catch (e) {
    return d.toDateString() + " " + formatClock(d, mode);
  }
}

const SAVED_JUST_NOW_MS = 60000;

function savedStatusText(savedAt: number | null | undefined, now: number) {
  return savedAt && now - savedAt < SAVED_JUST_NOW_MS ? "Saved just now" : "All changes saved";
}

function savedWhenText(savedAt: number | null | undefined, now: number, mode?: string) {
  if (!savedAt) return "";
  const at = new Date(savedAt);
  return at.toDateString() === new Date(now).toDateString()
    ? formatClock(at, mode) : formatDateClock(at, null, mode);
}

export {
  SAVED_JUST_NOW_MS,
  clockCycle,
  formatClock,
  formatDateClock,
  formatTimestampAbsolute,
  savedStatusText,
  savedWhenText
};
