import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../../../src/adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../../src/adapters/desktop/desktop-port.ts";
import { updates as updatesPort } from "../../../src/bootstrap/wiring/update.ts";
import type { UpdatePorts, UpdateStatus } from "../../../src/features/update/ports.ts";
import { mountUpdate } from "../../../src/features/update/update.js";
import type { UpdateFeaturePorts } from "../../../src/features/update/ports.ts";
import type { UpdateResult } from "../../../src/features/update/ports.ts";

for (const operation of ["download", "install"] as const) {
  for (const outcome of ["success", "failure", "rejection"] as const) {
    for (const replace of [false, true]) {
      test(`${operation} ${outcome} cannot affect the UI after ${replace ? "replacement" : "disposal"}`, async () => {
        document.body.innerHTML = '<div id="update-bar" hidden><span id="update-bar-text"></span><button id="update-bar-action"></button></div>';
        const callbacks: { resolve?: (result: UpdateResult | null) => void; reject?: (error: Error) => void } = {};
        const pending = new Promise<UpdateResult | null>((resolve, reject) => {
          callbacks.resolve = resolve;
          callbacks.reject = reject;
        });
        const status: UpdateStatus = {
          version: "4.1", latest: "4.2", desktop: true, canInstall: true, updateAvailable: true,
          download: { state: operation === "install" ? "ready" : "idle" }
        };
        const ports: UpdateFeaturePorts = {
          desktop: () => true,
          preferences: { desktopNoticeDismissed: () => false, dismissDesktopNotice: () => {} },
          externalLinks: { available: () => true, open: () => {} },
          updates: {
            status: () => Promise.resolve(status),
            onStatus: () => {}, stopStatus: () => {},
            download: () => pending, install: () => pending
          }
        };
        const first = mountUpdate(ports);
        first.loadUpdateStatus();
        await Promise.resolve();
        const button = document.getElementById("update-bar-action") as HTMLButtonElement;
        assert.equal(button.textContent, operation === "install" ? "Install and restart" : "Download");
        button.click();
        first.dispose();
        let second: ReturnType<typeof mountUpdate> | null = null;
        try {
          if (replace) {
            second = mountUpdate({ ...ports, updates: { ...ports.updates, status: () => Promise.resolve({ ...status, latest: "4.3" }) } });
            second.loadUpdateStatus();
            await Promise.resolve();
          }
          const text = (document.getElementById("update-bar-text") as HTMLElement).textContent;
          const hidden = button.hidden;
          assert.ok(callbacks.resolve);
          assert.ok(callbacks.reject);
          if (outcome === "rejection") callbacks.reject(new Error("stale request"));
          else callbacks.resolve(outcome === "success" ? { ok: true } : { ok: false, message: "stale request" });
          await Promise.resolve();
          await Promise.resolve();
          assert.equal((document.getElementById("update-bar-text") as HTMLElement).textContent, text);
          assert.equal(button.hidden, hidden);
        } finally {
          second?.dispose();
        }
      });
    }
  }
}

test("update mount owns its subscription, About listeners and probe across replacement", async () => {
  document.body.innerHTML = '<meta name="splitpage-version" content="4.1.0"><div id="update-bar" hidden><span id="update-bar-text"></span><button id="update-bar-action"></button></div><div id="about-modal" hidden><span id="about-version"></span><div id="about-body"></div><a id="about-link"></a><button data-about-close></button></div>';
  let receive: ((status: UpdateStatus) => void) | null = null;
  let stopped = 0;
  const ports: UpdateFeaturePorts = {
    desktop: () => true,
    preferences: { desktopNoticeDismissed: () => false, dismissDesktopNotice: () => {} },
    externalLinks: { available: () => true, open: () => {} },
    updates: {
      status: () => Promise.resolve({ version: "4.1.0", latest: "4.2.0", updateAvailable: true, desktop: true, canInstall: true }),
      onStatus: (listener) => { receive = listener; },
      stopStatus: () => { stopped++; },
      download: () => Promise.resolve(null),
      install: () => Promise.resolve(null)
    }
  };
  const first = mountUpdate(ports);
  first.loadUpdateStatus();
  await Promise.resolve();
  assert.equal((document.getElementById("update-bar") as HTMLElement).hidden, false);
  assert.equal((document.getElementById("update-bar-action") as HTMLElement).textContent, "Download");
  first.showAbout();
  assert.equal((document.getElementById("about-modal") as HTMLElement).hidden, false);
  assert.equal((document.getElementById("about-version") as HTMLElement).textContent, "Version 4.1.0");
  const late = receive;
  const second = mountUpdate(ports);
  assert.equal(stopped, 1);
  assert.equal((document.getElementById("about-modal") as HTMLElement).hidden, true);
  assert.equal((document.getElementById("update-bar-action") as HTMLButtonElement).onclick, null);
  (late as unknown as (status: UpdateStatus) => void)({ version: "stale" });
  second.showAbout();
  assert.equal((document.getElementById("about-version") as HTMLElement).textContent, "Version 4.1.0");
  (document.querySelector("[data-about-close]") as HTMLButtonElement).click();
  assert.equal((document.getElementById("about-modal") as HTMLElement).hidden, true);
  second.dispose();
  second.dispose();
  assert.equal(stopped, 1);
  assert.equal("__updateTest" in window, false);
});

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
