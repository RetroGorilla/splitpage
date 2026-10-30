import { test } from "node:test";
import { launch as portLaunch } from "../../src/bootstrap/wiring/ports/desktop.ts";
import assert from "node:assert/strict";
import { presence } from "../../src/bootstrap/wiring/ports/desktop-presence.ts";
import "../../src/test/_dom.mjs";

import { restoreDesktop, useDesktopForTest } from "../../src/adapters/desktop/desktop-port.ts";

test("desktop presence is off with no bridge and follows the current desktop bridge at call time", () => {
  const running = presence.running;
  assert.equal(running(), false);
  try {
    useDesktopForTest({});
    assert.equal(running(), true);
    useDesktopForTest(null);
    assert.equal(running(), false);
  } finally {
    restoreDesktop();
  }
  assert.equal(running(), false);
});

test("launch facts read each current desktop bridge at call time", () => {
  const facts = portLaunch;
  const read = () => [facts.firstTabOfLaunch(), facts.hadPriorSession(), facts.launchIntent(), facts.hasDraftToRestore()];
  try {
    useDesktopForTest(null);
    assert.deepEqual(read(), [undefined, undefined, undefined, undefined]);
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
