import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handPinDialogTo, openPinDialog as openThroughHandOff } from "../legacy/pin-dialog.ts";
import { shortHost } from "../features/common/server-address.ts";

const pinModal = () => document.getElementById("pin-modal");
const pinReason = () => document.getElementById("pin-reason").textContent;

openThroughHandOff({ reason: "before the wiring" });

let beforeStartup = null;
await bootApp(undefined, {
  beforeStart() {
    openThroughHandOff({ reason: "Filled before startup." });
    beforeStartup = { open: !pinModal().hidden, reason: pinReason() };
    pinModal().hidden = true;
  }
});

const hosted = await import("../js/13-hosted.js");
const { openPinDialog } = await import("../js/20e-connect.js");
const realFetch = globalThis.fetch;
const SERVER = "http://pin-handoff.test";

after(closeApp);

afterEach(() => {
  globalThis.fetch = realFetch;
  handPinDialogTo(openPinDialog);
  hosted.closeServerPicker();
  hosted.pointTabAt("");
  pinModal().hidden = true;
});

function answer(status, body) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
}

function spyOnPinDialog() {
  const calls = [];
  handPinDialogTo((request) => { calls.push(request); });
  return calls;
}

test("the wiring hands 20e's join prompt to 13-hosted before startup runs", () => {
  assert.deepEqual(beforeStartup, { open: true, reason: "Filled before startup." });
});

test("a server refusing for a PIN opens the join prompt with the same reason as before", async () => {
  hosted.pointTabAt(SERVER);
  answer(401, { error: "pin-required" });
  const calls = spyOnPinDialog();
  await hosted.openServerPicker();
  assert.deepEqual(calls, [{ reason: "This server asks for its join PIN or key." }]);
});

test("a server that needs a PIN before showing anything opens the join prompt naming the server", async () => {
  hosted.pointTabAt(SERVER);
  answer(200, { ok: true, authRequired: true });
  const calls = spyOnPinDialog();
  await hosted.detectServer();
  assert.deepEqual(calls, [{ reason: shortHost(SERVER) + " asks for a join PIN or key before it will show you anything." }]);
});

test("through the real hand-off the refusal shows 20e's join prompt with that reason", async () => {
  hosted.pointTabAt(SERVER);
  answer(401, { error: "pin-required" });
  await hosted.openServerPicker();
  assert.equal(pinModal().hidden, false);
  assert.equal(pinReason(), "This server asks for its join PIN or key.");
});
