import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { autoSaveIdleFor, autoSaveTiming } from "../js/14-export.js";

test("a hosted document waits longer before autosaving than a local file", () => {
  assert.ok(autoSaveIdleFor("server") > autoSaveIdleFor("file"));
});

test("the local file path is unchanged at 2s", () => {
  assert.equal(autoSaveIdleFor("file"), 2000);
});

test("anything that is not the server gets the local timing", () => {
  assert.equal(autoSaveIdleFor(null), autoSaveTiming.idle);
  assert.equal(autoSaveIdleFor("draft"), autoSaveTiming.idle);
});

test("both idles leave room under the max timer", () => {
  assert.ok(autoSaveTiming.hostedIdle < autoSaveTiming.max);
  assert.ok(autoSaveTiming.idle < autoSaveTiming.max);
});

test("the timing object stays live, which the browser suite relies on", () => {
  const before = autoSaveTiming.hostedIdle;
  autoSaveTiming.hostedIdle = 7;
  assert.equal(autoSaveIdleFor("server"), 7);
  autoSaveTiming.hostedIdle = before;
});
