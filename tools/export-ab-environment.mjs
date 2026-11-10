export const CAPTURED_ISO = "2026-10-13T17:30:00.000Z";

export function pinnedDateTimeFormat(Real) {
  function PinnedDateTimeFormat(locale, opts) {
    const options = Object.assign({}, opts);
    if (options.timeZone === undefined) options.timeZone = "UTC";
    return new Real(locale === undefined ? "en-US" : locale, options);
  }
  PinnedDateTimeFormat.supportedLocalesOf = Real.supportedLocalesOf;
  return PinnedDateTimeFormat;
}

export function clockProblems(side, fixtures) {
  const problems = [];
  for (const f of fixtures) {
    if (!f.clock || typeof f.clock.capturedAt !== "string" || typeof f.clock.now !== "string") {
      problems.push(`${side}: ${f.name} records no capture and wall clock`);
    } else if (f.clock.capturedAt.slice(0, 10) === f.clock.now.slice(0, 10)) {
      problems.push(`${side}: ${f.name} was captured on the day the wall clock reads (${f.clock.now}), so a stray clock read would not show`);
    }
  }
  return problems;
}
