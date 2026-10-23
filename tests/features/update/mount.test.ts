import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../../../src/adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../../src/adapters/desktop/desktop-port.ts";
import { updates as updatesPort } from "../../../src/bootstrap/wiring/update.ts";
import type { UpdatePorts, UpdateStatus } from "../../../src/features/update/ports.ts";

test("update ports can be wired before mounting and delegate every call and listener cleanup to the current desktop", async () => {
  const ports: UpdatePorts = { updates: updatesPort };
  const { updates } = ports;
  const status = {
    version: "4.1.0",
    latest: "4.2.0",
    updateAvailable: true,
    canInstall: true,
    checking: false,
    error: null,
    download: { state: "downloading", received: 42, total: 128, error: null },
    releaseUrl: "https://splitpage.test/releases/4.2.0",
    desktopAppUrl: "https://splitpage.test/desktop",
    desktop: true
  } satisfies UpdateStatus;
  const nextStatus = { ...status, version: "4.2.0", latest: null, download: { state: "idle" } } satisfies UpdateStatus;
  const downloadResult = { ok: false, error: "download-failed", message: "Download unavailable" };
  const installResult = { ok: false, error: "quit-cancelled", message: "The app was kept open" };
  const nextDownloadResult = { ok: true };
  const nextInstallResult = { ok: false, error: "not-downloaded" };
  const calls: string[] = [];
  const heard: UpdateStatus[] = [];
  const subscribed: Parameters<DesktopPort["onUpdateStatus"]>[0][] = [];
  const listener = (value: UpdateStatus): void => { heard.push(value); };
  const first: Partial<DesktopPort> = {
    getUpdateStatus: () => { calls.push("first:status"); return Promise.resolve(status); },
    onUpdateStatus: (callback) => { calls.push("first:onStatus"); subscribed.push(callback); },
    downloadUpdate: () => { calls.push("first:download"); return Promise.resolve(downloadResult); },
    installUpdate: () => { calls.push("first:install"); return Promise.resolve(installResult); }
  };
  const second: Partial<DesktopPort> = {
    getUpdateStatus: () => { calls.push("second:status"); return Promise.resolve(nextStatus); },
    onUpdateStatus: (callback) => { calls.push("second:onStatus"); subscribed.push(callback); },
    downloadUpdate: () => { calls.push("second:download"); return Promise.resolve(nextDownloadResult); },
    installUpdate: () => { calls.push("second:install"); return Promise.resolve(nextInstallResult); }
  };
  try {
    for (const desktop of [null, {}]) {
      useDesktopForTest(desktop);
      assert.equal(await updates.status(), null);
      updates.onStatus(listener);
      updates.stopStatus();
      assert.equal(await updates.download(), null);
      assert.equal(await updates.install(), null);
    }
    assert.deepEqual(calls, []);
    useDesktopForTest(first);
    assert.equal(await updates.status(), status);
    updates.onStatus(listener);
    assert.equal(subscribed[0], listener);
    subscribed[0]?.(status);
    assert.deepEqual(heard, [status]);
    assert.equal(await updates.download(), downloadResult);
    assert.equal(await updates.install(), installResult);
    useDesktopForTest(second);
    updates.stopStatus();
    assert.deepEqual(subscribed, [listener, null]);
    assert.equal(await updates.status(), nextStatus);
    updates.onStatus(listener);
    assert.equal(subscribed[2], listener);
    subscribed[2]?.(nextStatus);
    assert.deepEqual(heard, [status, nextStatus]);
    assert.equal(await updates.download(), nextDownloadResult);
    assert.equal(await updates.install(), nextInstallResult);
    updates.stopStatus();
    assert.deepEqual(subscribed, [listener, null, listener, null]);
    assert.deepEqual(calls, [
      "first:status", "first:onStatus", "first:download", "first:install",
      "second:onStatus", "second:status", "second:onStatus", "second:download", "second:install", "second:onStatus"
    ]);
    useDesktopForTest(null);
    assert.equal(await updates.status(), null);
    assert.equal(await updates.download(), null);
    assert.equal(await updates.install(), null);
    updates.onStatus(listener);
    updates.stopStatus();
    assert.equal(subscribed.length, 4);
    const error = new Error("desktop request failed");
    useDesktopForTest({
      getUpdateStatus: () => Promise.reject(error),
      downloadUpdate: () => Promise.reject(error),
      installUpdate: () => Promise.reject(error)
    });
    await assert.rejects(updates.status(), error);
    await assert.rejects(updates.download(), error);
    await assert.rejects(updates.install(), error);
  } finally {
    restoreDesktop();
  }
});
