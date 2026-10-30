import { test } from "node:test";
import assert from "node:assert/strict";
import "../../../src/test/_dom.mjs";

import { exposeTestHook } from "../../../src/features/common/test-hooks.ts";

const read = (name: string): unknown => (window as unknown as Record<string, unknown>)[name];

function expose(value: unknown): () => void {
  let withdraw: (() => void) | null = null;
  exposeTestHook("__hookHelperTest", () => value, (w) => { withdraw = w; });
  assert.ok(withdraw, "the owner is handed its withdraw function");
  return withdraw;
}

test("a hook is exposed on window, and a stale owner's withdraw leaves the newer hook alone", () => {
  const firstValue = { from: "first" };
  const secondValue = { from: "second" };
  const withdrawFirst = expose(firstValue);
  assert.equal(read("__hookHelperTest"), firstValue);
  const withdrawSecond = expose(secondValue);
  withdrawFirst();
  assert.equal(read("__hookHelperTest"), secondValue);
  withdrawSecond();
  assert.equal("__hookHelperTest" in window, false);
});

test("a stale owner's withdraw leaves a newer registration of the same object alone", () => {
  const shared = { from: "shared" };
  const withdrawStale = expose(shared);
  const withdrawNewer = expose(shared);
  withdrawStale();
  assert.equal(read("__hookHelperTest"), shared, "the newer registration keeps the hook");
  withdrawNewer();
  assert.equal("__hookHelperTest" in window, false);
  assert.equal(Symbol.for("splitpage.testHookOwner.__hookHelperTest") in window, false, "nothing is left behind on window");
});

test("withdrawing leaves a value someone else put under the name", () => {
  const withdraw = expose({ from: "owner" });
  const replaced = { from: "elsewhere" };
  Object.assign(window, { __hookHelperTest: replaced });
  withdraw();
  assert.equal(read("__hookHelperTest"), replaced);
  Reflect.deleteProperty(window, "__hookHelperTest");
});
