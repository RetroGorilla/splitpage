import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";
import { startEffects } from "../legacy/effects-bridge.ts";
import { grantVideoFile, hasSessionVideo, sessionVideoUrl, releaseSessionVideoUrls, openVideoFile } from "../js/06-rows.js";

function notices(t) {
  const heard = [];
  const stop = startEffects({
    notices: { show: (...args) => { heard.push(args); return { remove() {} }; }, showAction: () => ({ remove() {} }) },
    menuItems: { setLabel() {}, setReason() {} },
    clipboard: { copyText: async () => false }
  });
  t.after(stop);
  t.after(restoreDesktop);
  return heard;
}

test("session videos cache object URLs, replace them only for a different file, and keep grants after releasing URLs", (t) => {
  useDesktopForTest(null);
  t.after(restoreDesktop);
  const made = [];
  const revoked = [];
  t.mock.method(URL, "createObjectURL", (file) => { made.push(file); return "blob:video-" + made.length; });
  t.mock.method(URL, "revokeObjectURL", (url) => { revoked.push(url); });
  const link = { name: "cache-characterization.mp4", size: 5 };
  const first = { size: 5 };
  const replacement = { size: 5 };
  assert.equal(hasSessionVideo(link), false);
  grantVideoFile(first, link);
  assert.equal(hasSessionVideo(link), true);
  assert.equal(hasSessionVideo({ ...link, href: "https://example.com/clip" }), false);
  assert.equal(sessionVideoUrl(link), "blob:video-1");
  assert.equal(sessionVideoUrl(link), "blob:video-1");
  grantVideoFile(first, link);
  assert.deepEqual(revoked, []);
  grantVideoFile(replacement, link);
  assert.deepEqual(revoked, ["blob:video-1"]);
  assert.equal(sessionVideoUrl(link), "blob:video-2");
  releaseSessionVideoUrls();
  assert.deepEqual(revoked, ["blob:video-1", "blob:video-2"]);
  assert.equal(hasSessionVideo(link), true);
  assert.equal(sessionVideoUrl(link), "blob:video-3");
  assert.deepEqual(made, [first, replacement, replacement]);
  releaseSessionVideoUrls();
});

test("unavailable object URLs return null and failed revocation does not keep a cached URL", (t) => {
  useDesktopForTest(null);
  t.after(restoreDesktop);
  const link = { name: "unavailable-characterization.mov", size: 4 };
  grantVideoFile({ size: 4 }, link);
  t.mock.method(URL, "createObjectURL", () => { throw new Error("unavailable"); });
  assert.equal(sessionVideoUrl(link), null);
  t.mock.method(URL, "createObjectURL", () => "blob:available");
  assert.equal(sessionVideoUrl(link), "blob:available");
  t.mock.method(URL, "revokeObjectURL", () => { throw new Error("already gone"); });
  releaseSessionVideoUrls();
  assert.equal(hasSessionVideo(link), true);
  t.mock.method(URL, "createObjectURL", () => "blob:replacement");
  assert.equal(sessionVideoUrl(link), "blob:replacement");
  releaseSessionVideoUrls();
});

test("opening a browser-only video names the source computer and remains a sticky warning", (t) => {
  const heard = notices(t);
  useDesktopForTest(null);
  openVideoFile({ name: "browser-characterization.mp4" });
  assert.deepEqual(heard, [["“browser-characterization.mp4” is a video file on the computer it was added from — only its name is kept here. Open it from there, or in the Splitpage desktop app.", "warn", true]]);
});

test("desktop opens only a successfully granted token and forwards the current desktop bridge", async (t) => {
  const heard = notices(t);
  const grants = [];
  const opened = [];
  const file = { size: 9 };
  const link = { name: "desktop-characterization.mp4", size: 9 };
  useDesktopForTest({ grantVideoFile: (value) => { grants.push(value); return Promise.resolve("video-token"); }, openVideoFile: () => { throw new Error("old bridge must not open"); } });
  openVideoFile(link);
  assert.match(heard[0][0], /drop “desktop-characterization.mp4” onto this scene again/);
  assert.deepEqual(heard[0].slice(1), ["warn", true]);
  grantVideoFile(file, link);
  await Promise.resolve();
  useDesktopForTest({ openVideoFile: (token) => { opened.push(token); return Promise.resolve({ ok: true }); } });
  openVideoFile(link);
  await Promise.resolve();
  assert.deepEqual(grants, [file]);
  assert.deepEqual(opened, ["video-token"]);
  assert.equal(heard.length, 1);
});

test("failed and empty desktop grants preserve the browser file without permitting a native open", async (t) => {
  const heard = notices(t);
  const opened = [];
  for (const [index, token] of [null, "", Promise.reject(new Error("denied"))].entries()) {
    const link = { name: `denied-characterization-${index}.mp4`, size: 3 };
    useDesktopForTest({ grantVideoFile: () => token, openVideoFile: (value) => { opened.push(value); return Promise.resolve({ ok: true }); } });
    grantVideoFile({ size: 3 }, link);
    await Promise.resolve();
    assert.equal(hasSessionVideo(link), true);
    openVideoFile(link);
  }
  assert.deepEqual(opened, []);
  assert.equal(heard.length, 3);
  assert.ok(heard.every((args) => args[1] === "warn" && args[2] === true));
});

test("native open failures preserve missing-file and rejected-operation messages", async (t) => {
  const heard = notices(t);
  const link = { name: "gone-characterization.mp4", size: 2 };
  useDesktopForTest({ grantVideoFile: () => "gone-token", openVideoFile: () => Promise.resolve({ ok: false, code: "GONE" }) });
  grantVideoFile({ size: 2 }, link);
  await Promise.resolve();
  openVideoFile(link);
  await Promise.resolve();
  useDesktopForTest({ openVideoFile: () => Promise.reject(new Error("native failure")) });
  openVideoFile(link);
  await Promise.resolve();
  assert.deepEqual(heard, [["Could not open “gone-characterization.mp4” — it is no longer where it was.", "error", undefined], ["Could not open “gone-characterization.mp4”.", "error", undefined]]);
});
