import { test } from "node:test";
import assert from "node:assert/strict";
import { runningOnDesktop, setRunningOnDesktop } from "../../src/application/desktop-presence.ts";

test("running on desktop starts false and follows what it is told", () => {
  assert.equal(runningOnDesktop(), false);
  setRunningOnDesktop(true);
  assert.equal(runningOnDesktop(), true);
  setRunningOnDesktop(false);
  assert.equal(runningOnDesktop(), false);
});
