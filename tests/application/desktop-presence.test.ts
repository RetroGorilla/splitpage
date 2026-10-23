import { test } from "node:test";
import assert from "node:assert/strict";
import { runningOnDesktop, setRunningOnDesktop } from "../../src/application/desktop-presence.ts";
import "../../src/test/_dom.mjs";
import { sharedPorts } from "../../src/bootstrap/wiring/shared-ports.ts";
import { restoreDesktop, useDesktopForTest } from "../../src/adapters/desktop/desktop-port.ts";

test("running on desktop starts false and follows what it is told", () => {
  assert.equal(runningOnDesktop(), false);
  setRunningOnDesktop(true);
  assert.equal(runningOnDesktop(), true);
  setRunningOnDesktop(false);
  assert.equal(runningOnDesktop(), false);
});

test("launch facts read each current desktop bridge at call time", () => {
  const facts = sharedPorts().launchFacts;
  const read = () => [facts.firstTabOfLaunch(), facts.hadPriorSession(), facts.launchIntent(), facts.hasDraftToRestore()];
  try {
    useDesktopForTest(null);
    assert.deepEqual(read(), [false, false, null, false]);
    const intent = { type: "blank" };
    useDesktopForTest({ firstTabOfLaunch: true, hadPriorSession: false, launchIntent: intent, hasDraftToRestore: false });
    assert.deepEqual(read(), [true, false, { type: "blank" }, false]);
    assert.equal(facts.launchIntent(), intent);
    useDesktopForTest({ firstTabOfLaunch: false, hadPriorSession: true, launchIntent: { type: "file" }, hasDraftToRestore: true });
    assert.deepEqual(read(), [false, true, { type: "file" }, true]);
  } finally {
    restoreDesktop();
  }
});
