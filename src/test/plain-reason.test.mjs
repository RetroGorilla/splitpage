/* plainReason() (13-hosted.js): what a failure toast says after the dash.
 * The browser's words for a dropped connection are turned into a sentence a
 * person can act on; reasons that were already written for a person pass
 * through untouched. */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { plainReason } = await import("../js/13-hosted.js");

test("the browser's network errors say what to check", () => {
  const wanted = /^the connection failed — check that you are online/;
  assert.match(plainReason(new TypeError("Failed to fetch")), wanted);
  assert.match(plainReason(new TypeError("Load failed")), wanted);
  assert.match(plainReason(new Error("NetworkError when attempting to fetch resource.")), wanted);
});

test("a timeout and an offline server each get their own sentence", () => {
  const abort = new Error("The operation was aborted.");
  abort.name = "AbortError";
  assert.match(plainReason(abort), /took too long/);
  const offline = new Error("no answer from the server");
  offline.code = "offline";
  assert.match(plainReason(offline), /no answer.*online.*server is running/);
});

test("a reason already written for a person passes through, minus a trailing full stop", () => {
  assert.equal(plainReason(new Error("that name is taken.")), "that name is taken");
  assert.equal(plainReason(new Error("Google refused access — sign in to Google Drive again")),
    "Google refused access — sign in to Google Drive again");
});

test("nothing to say falls back to 'please try again'", () => {
  assert.equal(plainReason(null), "please try again");
  assert.equal(plainReason(new Error("")), "please try again");
  assert.equal(plainReason(undefined), "please try again");
});
