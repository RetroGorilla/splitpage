declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

// why: build.mjs defines the flag, so a release bundle folds the helper to an empty function and drops every call;
// source run without the bundler (the unit tests) leaves it undefined and keeps the hooks.
const TEST_HOOKS: boolean = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS;

export function exposeTestHook(name: string, make: () => unknown, hold: (withdraw: () => void) => void): void {
  if (!TEST_HOOKS) return;
  const value = make();
  Object.assign(window, { [name]: value });
  hold(() => {
    const global = window as unknown as Record<string, unknown>;
    if (global[name] === value) Reflect.deleteProperty(global, name);
  });
}
