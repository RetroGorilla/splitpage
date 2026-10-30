import { test } from "node:test";
import assert from "node:assert/strict";
import "../../../src/test/_dom.mjs";

import { exposeTestHook, withdrawTestHook } from "../../../src/features/common/test-hooks.ts";

const read = (name: string): unknown => (window as unknown as Record<string, unknown>)[name];

test("a hook is exposed on window, and only its own owner withdraws it", () => {
  const first = {};
  const second = {};
  const firstValue = { from: "first" };
  const secondValue = { from: "second" };
  exposeTestHook("__hookHelperTest", first, () => firstValue);
  assert.equal(read("__hookHelperTest"), firstValue);
  exposeTestHook("__hookHelperTest", second, () => secondValue);
  withdrawTestHook("__hookHelperTest", first);
  assert.equal(read("__hookHelperTest"), secondValue, "a stale owner leaves the newer hook alone");
  withdrawTestHook("__hookHelperTest", second);
  assert.equal("__hookHelperTest" in window, false);
});

test("withdrawing leaves a value someone else put under the name", () => {
  const owner = {};
  exposeTestHook("__hookHelperTest", owner, () => ({ from: "owner" }));
  const replaced = { from: "elsewhere" };
  Object.assign(window, { __hookHelperTest: replaced });
  withdrawTestHook("__hookHelperTest", owner);
  assert.equal(read("__hookHelperTest"), replaced);
  Reflect.deleteProperty(window, "__hookHelperTest");
});
