import assert from "node:assert/strict";

// why: Windows Node may ignore locale environment variables, so supply the default only when omitted.
Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
  construct(formatter, [locale, options]) {
    return new formatter(locale === undefined ? "en-CA" : locale, options);
  }
});

const { formatClock, formatDateClock } = await import("../../shared/clock.ts");
const instant = "2026-09-25T05:52:00Z";

assert.deepEqual({
  twelveHour: formatClock(instant, "12"),
  twentyFourHour: formatClock(instant, "24"),
  date: formatDateClock(instant, null, "12"),
  dateWithYear: formatDateClock(instant, { year: true }, "24")
}, {
  twelveHour: "10:52 p.m.",
  twentyFourHour: "22:52",
  date: "Sep 24, 10:52 p.m.",
  dateWithYear: "Sep 24, 2026, 22:52"
});
