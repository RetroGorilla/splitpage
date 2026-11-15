declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

// why: build.mjs defines the flag, so a release bundle folds this to an empty function and drops every call;
// a test build writes marks only while a measurement switched them on, so other test runs keep their timing.
const TEST_HOOKS: boolean = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS;

export function markSharedTiming(name: string): void {
  if (TEST_HOOKS && (globalThis as Record<PropertyKey, unknown>)[Symbol.for("splitpage.timingMarks")] === true) performance.mark(name);
}
