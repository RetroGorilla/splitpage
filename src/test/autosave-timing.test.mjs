/* autoSaveIdleFor (14-export.js, #70).

   The whole of #70 is "hosted waits longer than local", and the reason is
   contention: at a 2s idle two people typing at once conflict on nearly
   every save, and each conflict costs a whole-document 409 plus a history
   snapshot against the 50-entry cap. So what is worth pinning is the
   relationship — hosted strictly slower than local, both shorter than the
   max — rather than the three numbers, which are a judgement call and may
   be retuned. The one literal asserted is that local is still 2000, because
   #70 says explicitly that the local and draft paths do not change. */
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
  /* autoSaveTarget() answers "server", "file" or null, and scheduleAutoSave
     returns early on null — but a future third target must not silently
     inherit the hosted wait just by not being "file". */
  assert.equal(autoSaveIdleFor(null), autoSaveTiming.idle);
  assert.equal(autoSaveIdleFor("draft"), autoSaveTiming.idle);
});

test("both idles leave room under the max timer", () => {
  /* If an idle ever reached the max, the max timer would stop being the
     backstop for uninterrupted typing and the two would fire together. */
  assert.ok(autoSaveTiming.hostedIdle < autoSaveTiming.max);
  assert.ok(autoSaveTiming.idle < autoSaveTiming.max);
});

test("the timing object stays live, which the browser suite relies on", () => {
  /* 28-autosave.txt drives real saves by setting A.timing().idle to 30ms.
     Reading through the object rather than closing over a copy is what
     makes that work. */
  const before = autoSaveTiming.hostedIdle;
  autoSaveTiming.hostedIdle = 7;
  assert.equal(autoSaveIdleFor("server"), 7);
  autoSaveTiming.hostedIdle = before;
});
