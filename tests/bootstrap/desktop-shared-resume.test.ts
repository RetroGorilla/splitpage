import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { DesktopPort } from "../../src/adapters/desktop/desktop-port.ts";
import { enterSavedReference, resumeDesktopReference } from "../../src/bootstrap/wiring/desktop-shared-resume.ts";
import { relayHttpOrigin, relayOriginAllowed, relaySocketUrl, relayUrlAllowed } from "../../src/bootstrap/wiring/relay-address.ts";
import { enterRetainedSharedScript, RETAINED_SHARED_COPY_UNAVAILABLE } from "../../src/bootstrap/wiring/retained-shared-script.ts";
import type { SharedSwitchPorts } from "../../src/bootstrap/wiring/shared-session.ts";
import { SHARED_ENTER_FAILED } from "../../src/bootstrap/wiring/shared-session.ts";

const saved = { deployment: "relay", script: "old", address: "https://relay.example" };

for (const [result, cleared] of [
  ["opened", false],
  ["enter-failed", false],
  ["locked", false],
  ["io", false],
  ["draft-not-kept", false],
  [RETAINED_SHARED_COPY_UNAVAILABLE, true],
  ["cancelled", false]
] as const) {
  test(`starting a desktop with a retained reference (${result})`, async () => {
    const lifetime = new AbortController();
    const calls: unknown[][] = [];
    const reference: NonNullable<DesktopPort["sharedReference"]> = async request => {
      calls.push(request);
      return request.length ? true : saved;
    };
    const outcome = await resumeDesktopReference(reference, async entry => {
      assert.deepEqual(entry, saved);
      if (result === "cancelled") lifetime.abort();
      return result === "opened" ? { ok: true } : { ok: false, reason: result === "cancelled" ? RETAINED_SHARED_COPY_UNAVAILABLE : result };
    }, lifetime.signal);
    assert.equal(outcome?.ok, result === "opened");
    assert.deepEqual(calls, cleared ? [[], [null, saved, "unavailable"]] : [[]]);
  });
}

test("a failed catalogue-based restore releases its tab reference even when the copy is temporarily unavailable", async () => {
  const calls: unknown[][] = [];
  const reference: NonNullable<DesktopPort["sharedReference"]> = async request => {
    calls.push(request);
    return request.length ? true : saved;
  };
  const outcome = await resumeDesktopReference(reference, async () => ({ ok: false, reason: "io" }), new AbortController().signal, true);
  assert.deepEqual(outcome, { ok: false, reason: "io" });
  assert.deepEqual(calls, [[], [null, saved, "unavailable"]]);
});

const buildFlag = globalThis as { SPLITPAGE_TEST_HOOKS?: boolean };

async function countingRelay(t: { after: (fn: () => Promise<void>) => void }) {
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(request.url ?? ""); response.destroy(); });
  server.on("upgrade", (request, socket) => { requests.push("upgrade " + (request.url ?? "")); socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(() => resolve()); }));
  return { requests, address: "http://127.0.0.1:" + (server.address() as AddressInfo).port };
}

function recordingPorts() {
  const touched: PropertyKey[] = [];
  const ports: SharedSwitchPorts = new Proxy(Object.create(null), {
    get(_target, key) { touched.push(key); return undefined; },
    ownKeys() { touched.push("ownKeys"); return []; }
  });
  return { touched, ports };
}

test("a release build refuses a saved loopback relay reference and sends it no requests", async t => {
  buildFlag.SPLITPAGE_TEST_HOOKS = false;
  t.after(() => { delete buildFlag.SPLITPAGE_TEST_HOOKS; });
  const relay = await countingRelay(t);
  const loopback = { deployment: "relay", script: "old", address: relay.address };
  const calls: unknown[][] = [];
  const reference: NonNullable<DesktopPort["sharedReference"]> = async request => {
    calls.push(request);
    return request.length ? true : loopback;
  };
  const restore = recordingPorts();
  const lifetime = new AbortController();
  const outcome = await resumeDesktopReference(reference,
    entry => enterSavedReference(entry, retained => enterRetainedSharedScript(restore.ports, retained), async () => lifetime.signal),
    lifetime.signal);
  assert.deepEqual(outcome, { ok: false, reason: RETAINED_SHARED_COPY_UNAVAILABLE });
  assert.deepEqual(restore.touched, []);
  assert.deepEqual(calls, [[], [null, loopback, "unavailable"]]);
  const socket = "ws" + relay.address.slice("http".length) + "/";
  const entry = recordingPorts();
  const retained = await enterRetainedSharedScript(entry.ports, {
    deployment: "relay", script: "old", relayUrl: socket, invitation: { token: "a".repeat(43) }
  });
  assert.deepEqual(retained, { ok: false, reason: SHARED_ENTER_FAILED });
  assert.deepEqual(entry.touched, []);
  for (const refused of [relay.address, "http://127.0.0.1:80", "http://127.0.0.1"]) {
    assert.equal(relayOriginAllowed(refused), false, refused);
    assert.equal(relaySocketUrl(refused), null, refused);
  }
  for (const refused of [socket, "ws://127.0.0.1:80/", "ws://127.0.0.1/"]) assert.equal(relayHttpOrigin(refused), null, refused);
  assert.equal(relaySocketUrl("https://relay.example"), "wss://relay.example/");
  assert.equal(relayHttpOrigin("wss://relay.example/"), "https://relay.example");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(relay.requests, []);
});

test("a test build reopens a saved loopback relay reference over ws", async t => {
  buildFlag.SPLITPAGE_TEST_HOOKS = true;
  t.after(() => { delete buildFlag.SPLITPAGE_TEST_HOOKS; });
  const signal = new AbortController().signal;
  for (const [address, relayUrl] of [["http://127.0.0.1:8765", "ws://127.0.0.1:8765/"], ["http://127.0.0.1", "ws://127.0.0.1/"]] as const) {
    const entered: unknown[] = [];
    const outcome = await enterSavedReference({ deployment: "relay", script: "old", address }, async retained => {
      entered.push(retained);
      return { ok: true };
    }, async () => signal);
    assert.deepEqual(outcome, { ok: true }, address);
    assert.deepEqual(entered, [{ deployment: "relay", script: "old", relayUrl, signal }], address);
  }
  for (const refused of ["http://relay.example:8765", "http://localhost:8765", "http://[::1]:8765", "ftp://127.0.0.1:8765",
    "http://user@127.0.0.1:8765"]) {
    assert.equal(relaySocketUrl(refused), null, refused);
  }
  assert.equal(relayOriginAllowed("http://127.0.0.1"), false);
});

test("a test build keeps a loopback relay on port 80, which URL parsing writes without the port", async t => {
  buildFlag.SPLITPAGE_TEST_HOOKS = true;
  t.after(() => { delete buildFlag.SPLITPAGE_TEST_HOOKS; });
  assert.equal(relayOriginAllowed("http://127.0.0.1:80"), true);
  assert.equal(relayUrlAllowed(new URL("http://127.0.0.1:80")), true);
  assert.equal(relaySocketUrl("http://127.0.0.1:80"), "ws://127.0.0.1/");
  assert.equal(relayHttpOrigin("ws://127.0.0.1:80/"), "http://127.0.0.1");
  assert.equal(relayHttpOrigin("ws://127.0.0.1/"), "http://127.0.0.1");
  const entered: unknown[] = [];
  const signal = new AbortController().signal;
  const outcome = await enterSavedReference({ deployment: "relay", script: "old", address: new URL("http://127.0.0.1:80").origin },
    async retained => { entered.push(retained); return { ok: true }; }, async () => signal);
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(entered, [{ deployment: "relay", script: "old", relayUrl: "ws://127.0.0.1/", signal }]);
  const entry = recordingPorts();
  await enterRetainedSharedScript(entry.ports, { deployment: "relay", script: "old", relayUrl: "ws://127.0.0.1:80/" });
  assert.ok(entry.touched.length > 0, "the port 80 relay passed the address check");
});
