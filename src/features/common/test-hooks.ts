declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

// why: build.mjs defines the flag, so a release bundle folds both helpers to empty functions and drops every call;
// source run without the bundler (the unit tests) leaves it undefined and keeps the hooks.
const TEST_HOOKS: boolean = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS;

interface Exposed {
  readonly owner: object;
  readonly value: unknown;
}

const exposed = new Map<string, Exposed>();

export function exposeTestHook(name: string, owner: object, make: () => unknown): void {
  if (!TEST_HOOKS) return;
  const value = make();
  exposed.set(name, { owner, value });
  Object.assign(window, { [name]: value });
}

export function withdrawTestHook(name: string, owner: object): void {
  if (!TEST_HOOKS) return;
  const entry = exposed.get(name);
  if (!entry || entry.owner !== owner) return;
  exposed.delete(name);
  const global = window as unknown as Record<string, unknown>;
  if (global[name] === entry.value) Reflect.deleteProperty(global, name);
}
