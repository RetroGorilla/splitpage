import "../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import type { StartupSignal } from "./startup-signal.ts";
import { sharedPorts } from "../bootstrap/wiring/shared-ports.ts";
import { connectStartup, startupReady } from "../legacy/startup-bridge.ts";

test("the startup signal forwards the current ready result unchanged across connections", () => {
  const startup: StartupSignal = sharedPorts().startup;
  assert.equal(sharedPorts().startup, startup);
  assert.equal(startup.ready(), null);
  for (const promise of [Promise.resolve("first"), Promise.resolve("second")]) {
    let ready: Promise<unknown> | null = null;
    let calls = 0;
    const owner: StartupSignal = {
      ready() {
        assert.equal(this, owner);
        calls++;
        return ready;
      }
    };
    const disconnect = connectStartup(owner);
    try {
      assert.equal(calls, 0);
      assert.equal(startup.ready(), null);
      assert.equal(calls, 1);
      ready = promise;
      assert.equal(startup.ready(), promise);
      assert.equal(startupReady(), promise);
      assert.equal(calls, 3);
      ready = null;
      assert.equal(startup.ready(), null);
      assert.equal(calls, 4);
    } finally {
      disconnect();
    }
    assert.equal(startup.ready(), null);
  }
});

test("the startup signal preserves synchronous errors and rejected promise identity", async () => {
  const startup: StartupSignal = sharedPorts().startup;
  const failure = new Error("startup failed");
  const disconnectThrowing = connectStartup({ ready: () => { throw failure; } });
  try {
    assert.throws(() => startup.ready(), (error: unknown) => error === failure);
  } finally {
    disconnectThrowing();
  }
  const rejected = Promise.reject(failure);
  const disconnectRejecting = connectStartup({ ready: () => rejected });
  try {
    assert.equal(startup.ready(), rejected);
    await assert.rejects(rejected, (error: unknown) => error === failure);
  } finally {
    disconnectRejecting();
  }
});
