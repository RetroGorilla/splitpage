import "../../src/test/_dom.mjs";
import { launch as portLaunch } from "../../src/bootstrap/wiring/ports/desktop.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../../src/adapters/desktop/desktop-port.ts";

import type { LaunchFacts } from "../../src/application/desktop-presence.ts";

test("launch facts forward each read to the current desktop and stay absent off desktop", () => {
  useDesktopForTest(null);
  const launch: LaunchFacts = portLaunch;
  const absent = (): void => {
    assert.equal(launch.firstTabOfLaunch(), undefined);
    assert.equal(launch.hadPriorSession(), undefined);
    assert.equal(launch.launchIntent(), undefined);
    assert.equal(launch.hasDraftToRestore(), undefined);
    assert.equal(launch.appVersion(), undefined);
  };
  try {
    absent();
    for (const first of [true, false]) {
      const reads: string[] = [];
      const intent = { type: first ? "open-file" : "blank" };
      const desktop = {
        get firstTabOfLaunch() { reads.push("firstTabOfLaunch"); return first; },
        get hadPriorSession() { reads.push("hadPriorSession"); return first; },
        get launchIntent() { reads.push("launchIntent"); return intent; },
        get hasDraftToRestore() { reads.push("hasDraftToRestore"); return first; },
        get appVersion() { reads.push("appVersion"); return first ? "4.1.0-test" : ""; }
      };
      useDesktopForTest(desktop);
      assert.equal(portLaunch, launch);
      assert.deepEqual(reads, []);
      assert.equal(launch.firstTabOfLaunch(), first);
      assert.equal(launch.hadPriorSession(), first);
      assert.equal(launch.launchIntent(), intent);
      assert.equal(launch.hasDraftToRestore(), first);
      assert.equal(launch.appVersion(), first ? "4.1.0-test" : "");
      assert.deepEqual(reads, [
        "firstTabOfLaunch", "hadPriorSession", "launchIntent", "hasDraftToRestore", "appVersion"
      ]);
    }
    useDesktopForTest(null);
    absent();
  } finally {
    restoreDesktop();
  }
});
