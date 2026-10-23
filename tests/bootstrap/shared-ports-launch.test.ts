import "../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";
import { sharedPorts } from "../bootstrap/wiring/shared-ports.ts";
import type { LaunchFacts } from "./desktop-presence.ts";

test("launch facts forward each read to the current desktop and stay absent off desktop", async () => {
  useDesktopForTest(null);
  const shared = sharedPorts();
  const launch: LaunchFacts = shared.launch;
  const absent = (): void => {
    assert.equal(launch.firstTabOfLaunch(), undefined);
    assert.equal(launch.hadPriorSession(), undefined);
    assert.equal(launch.launchIntent(), undefined);
    assert.equal(launch.hasDraftToRestore(), undefined);
    assert.equal(launch.appVersion(), undefined);
    assert.equal(launch.sessionInfo(), undefined);
  };
  try {
    absent();
    for (const first of [true, false]) {
      const reads: string[] = [];
      const intent = { type: first ? "open-file" : "blank" };
      const info = first ? { hosting: true, lanUrls: ["http://studio.local:8080"], pin: "123456" } : null;
      const session = Promise.resolve(info);
      const desktop = {
        get firstTabOfLaunch() { reads.push("firstTabOfLaunch"); return first; },
        get hadPriorSession() { reads.push("hadPriorSession"); return first; },
        get launchIntent() { reads.push("launchIntent"); return intent; },
        get hasDraftToRestore() { reads.push("hasDraftToRestore"); return first; },
        get appVersion() { reads.push("appVersion"); return first ? "4.1.0-test" : ""; },
        getSessionInfo() {
          assert.equal(this, desktop);
          reads.push("getSessionInfo");
          return session;
        }
      };
      useDesktopForTest(desktop);
      assert.equal(sharedPorts(), shared);
      assert.equal(sharedPorts().launch, launch);
      assert.deepEqual(reads, []);
      assert.equal(launch.firstTabOfLaunch(), first);
      assert.equal(launch.hadPriorSession(), first);
      assert.equal(launch.launchIntent(), intent);
      assert.equal(launch.hasDraftToRestore(), first);
      assert.equal(launch.appVersion(), first ? "4.1.0-test" : "");
      assert.equal(launch.sessionInfo(), session);
      assert.equal(await session, info);
      assert.deepEqual(reads, [
        "firstTabOfLaunch", "hadPriorSession", "launchIntent", "hasDraftToRestore", "appVersion", "getSessionInfo"
      ]);
    }
    useDesktopForTest(null);
    absent();
  } finally {
    restoreDesktop();
  }
});

test("launch facts leave session info failures to the caller", async () => {
  const launch = sharedPorts().launch;
  const failure = new Error("session info unavailable");
  try {
    useDesktopForTest({ getSessionInfo: () => { throw failure; } });
    assert.throws(() => launch.sessionInfo(), (error: unknown) => error === failure);
    const rejected = Promise.reject(failure);
    useDesktopForTest({ getSessionInfo: () => rejected });
    assert.equal(launch.sessionInfo(), rejected);
    await assert.rejects(rejected, (error: unknown) => error === failure);
  } finally {
    restoreDesktop();
  }
});
