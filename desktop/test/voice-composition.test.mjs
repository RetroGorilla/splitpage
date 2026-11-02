import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");
const { createVoiceComposition, VOICE_RELAY_PREFIX } = require(path.join(desktop, "voice-composition.js"));
const { createCloseQuit } = require(path.join(desktop, "close-quit.ts"));
const FAKE = path.join(here, "fake-voice-helper.mjs");
const STATIC = { "/index.html": { file: "index.html", type: "text/html; charset=utf-8" } };

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await tick(); }
  return false;
}

function withFakeHelper(on) {
  if (on) process.env.SPLITPAGE_TEST_VOICE_HELPER = FAKE;
  else delete process.env.SPLITPAGE_TEST_VOICE_HELPER;
}

function makeTabs(ids, sent) {
  const tabs = new Map();
  for (const id of ids) {
    tabs.set(id, {
      id,
      view: { webContents: { isDestroyed: () => false, send: (channel, event) => sent.push({ tab: id, channel, event }) } }
    });
  }
  return tabs;
}

function compose(extra) {
  const sent = [];
  const tabs = makeTabs(["A", "B"], sent);
  const voice = createVoiceComposition(Object.assign({
    isPackaged: false,
    appRoot: fs.mkdtempSync(path.join(os.tmpdir(), "voice-composition-")),
    testMode: true,
    tabs,
    staticAllowlist: STATIC,
    cspHeader: async () => "default-src 'self'"
  }, extra));
  return { voice, sent, tabs };
}

function spyShare(voice) {
  const pushed = [];
  const share = voice.prompterShareInstance();
  const push = share.pushVoice;
  share.pushVoice = (ownerId, event) => { pushed.push({ ownerId, event }); return push(ownerId, event); };
  return { share, pushed };
}

function openStream(port, pathname) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({
      host: "127.0.0.1", port, path: pathname, method: "GET",
      headers: { host: `127.0.0.1:${port}`, accept: "text/event-stream" }
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)));
        }
      });
      resolve({ status: res.statusCode, events, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

function fakeApp() {
  const handlers = new Map();
  return {
    on: (name, fn) => { handlers.set(name, fn); },
    emit: (name, ...args) => handlers.get(name)(...args)
  };
}

test("making the composition and forgetting a tab create neither the helper nor the share", () => {
  withFakeHelper(true);
  const { voice } = compose();
  assert.equal(voice.voiceHelper(), null);
  assert.equal(voice.prompterShare(), null);
  voice.forgetTab("A");
  assert.equal(voice.voiceHelper(), null, "forgetting a tab does not create the helper");
  assert.equal(voice.prompterShare(), null, "forgetting a tab does not create the share");
});

test("status and availability create the helper lazily and never start a listener", () => {
  withFakeHelper(true);
  const { voice } = compose();
  assert.equal(voice.prompterRelaysVoice(), true);
  const helper = voice.voiceHelper();
  assert.ok(helper, "availability created the helper");
  assert.equal(voice.voiceHelperInstance(), helper, "one helper for the composition");
  const st = helper.status();
  assert.equal(st.running, false);
  assert.equal(st.started, 0);
  assert.equal(st.pid, null);
  assert.equal(voice.prompterShare(), null, "availability does not create the share");
});

test("in test mode without a fake helper, voice is unavailable and start refuses", () => {
  withFakeHelper(false);
  const { voice } = compose();
  assert.equal(voice.prompterRelaysVoice(), false);
  assert.deepEqual(voice.voiceHelperInstance().start("A"), { ok: false, code: "UNAVAILABLE" });
  assert.equal(voice.voiceHelperInstance().status().started, 0);
});

test("an ordinary tab's events reach only that tab, on splitpage:voice-event", async () => {
  withFakeHelper(true);
  const { voice, sent } = compose();
  const { share, pushed } = spyShare(voice);
  const helper = voice.voiceHelperInstance();
  try {
    const answer = helper.start("A");
    assert.equal(answer.ok, true);
    assert.ok(await until(() => sent.some((s) => s.event.type === "final")), JSON.stringify(sent));
    assert.deepEqual([...new Set(sent.map((s) => s.tab))], ["A"]);
    assert.deepEqual([...new Set(sent.map((s) => s.channel))], ["splitpage:voice-event"]);
    assert.deepEqual(sent.map((s) => s.event.type), ["start", "interim", "final"]);
    assert.ok(sent.every((s) => s.event.session === answer.session));
    assert.equal(pushed.length, 0, "an ordinary session never reaches the share");
  } finally { helper.stopAll(); share.closeAll(); }
});

test("a relay session's events reach only the share, under the tab's own id", async () => {
  withFakeHelper(true);
  const { voice, sent } = compose();
  const { share, pushed } = spyShare(voice);
  const helper = voice.voiceHelperInstance();
  try {
    assert.equal(VOICE_RELAY_PREFIX, "relay:");
    assert.equal(helper.start("relay:A").ok, true);
    assert.ok(await until(() => pushed.some((p) => p.event.type === "final")), JSON.stringify(pushed));
    assert.deepEqual([...new Set(pushed.map((p) => p.ownerId))], ["A"]);
    assert.equal(sent.length, 0, "a relay session never reaches a tab");
  } finally { helper.stopAll(); share.closeAll(); }
});

test("the browser copy's stream starts relay:<tab>, carries its events and stops that session on close", async () => {
  withFakeHelper(true);
  const { voice, sent } = compose();
  const share = voice.prompterShareInstance();
  try {
    const url = await share.publish("A", "a.md", "x", { voice: voice.prompterRelaysVoice() });
    const m = /[#&]voice=(\d+)-([0-9a-f]{64})$/.exec(url);
    assert.ok(m, url);
    const stream = await openStream(Number(m[1]), "/prompter-voice/" + m[2]);
    assert.equal(stream.status, 200);
    const helper = voice.voiceHelper();
    assert.ok(await until(() => helper && helper.status().running), "the stream started the listener");
    assert.equal(helper.status().tabId, "relay:A");
    assert.ok(await until(() => stream.events.some((e) => e.type === "final")), JSON.stringify(stream.events));
    assert.equal(sent.length, 0);
    stream.close();
    assert.ok(await until(() => !helper.status().running), "closing the stream stopped the session");
  } finally {
    if (voice.voiceHelper()) voice.voiceHelper().stopAll();
    share.closeAll();
  }
});

test("closing a tab revokes its share, then forgets the tab and its relay, silently", async () => {
  withFakeHelper(true);
  const { voice, sent } = compose();
  const { share, pushed } = spyShare(voice);
  const helper = voice.voiceHelperInstance();
  const log = [];
  const revoke = share.revoke;
  const forget = helper.forget;
  share.revoke = (id) => { log.push("revoke " + id); return revoke(id); };
  helper.forget = (id) => { log.push("forget " + id); return forget(id); };
  try {
    helper.start("relay:A");
    assert.ok(await until(() => pushed.some((p) => p.event.type === "final")));
    voice.forgetTab("B");
    assert.equal(helper.status().running, true, "another tab closing leaves A's relay running");
    log.length = 0;
    const before = pushed.length;
    voice.forgetTab("A");
    assert.deepEqual(log, ["revoke A", "forget A", "forget relay:A"]);
    assert.equal(helper.status().running, false);
    await tick(100);
    assert.equal(pushed.length, before, "no end event for a closed tab's relay");

    helper.start("A");
    assert.ok(await until(() => sent.some((s) => s.event.type === "final")));
    const sentBefore = sent.length;
    voice.forgetTab("A");
    assert.equal(helper.status().running, false);
    await tick(100);
    assert.equal(sent.length, sentBefore, "no end event for a closed tab");
  } finally { helper.stopAll(); share.closeAll(); }
});

test("quitting, through close-quit's will-quit, closes the share and then stops the helper", async () => {
  withFakeHelper(true);
  const { voice } = compose();
  const app = fakeApp();
  const { registerQuitHandlers } = createCloseQuit({
    app, testMode: true, prompterShare: voice.prompterShare, voiceHelper: voice.voiceHelper, draftStore: () => null
  });
  registerQuitHandlers();
  const share = voice.prompterShareInstance();
  const helper = voice.voiceHelperInstance();
  const log = [];
  const closeAll = share.closeAll;
  const stopAll = helper.stopAll;
  share.closeAll = () => { log.push("closeAll"); return closeAll(); };
  helper.stopAll = () => { log.push("stopAll"); return stopAll(); };
  try {
    helper.start("A");
    assert.ok(await until(() => helper.status().running));
    app.emit("will-quit");
    assert.deepEqual(log, ["closeAll", "stopAll"]);
    assert.equal(helper.status().running, false);
  } finally { stopAll(); closeAll(); }
});

test("quitting before voice was ever used creates neither the helper nor the share", () => {
  withFakeHelper(true);
  const { voice } = compose();
  const app = fakeApp();
  createCloseQuit({
    app, testMode: true, prompterShare: voice.prompterShare, voiceHelper: voice.voiceHelper, draftStore: () => null
  }).registerQuitHandlers();
  app.emit("will-quit");
  assert.equal(voice.voiceHelper(), null);
  assert.equal(voice.prompterShare(), null);
});

test("outside test mode: the PowerShell listener in development, resources/splitpage/voice when packaged", async () => {
  withFakeHelper(true);
  if (process.platform !== "win32") {
    assert.equal(compose({ testMode: false }).voice.prompterRelaysVoice(), false, "no listener off Windows");
    return;
  }
  const dev = compose({ testMode: false });
  assert.equal(dev.voice.prompterRelaysVoice(), fs.existsSync(path.join(desktop, "voice", "listen.ps1")), "development uses desktop/voice/listen.ps1");
  const emptyRoot = compose({ testMode: false, isPackaged: true });
  assert.equal(emptyRoot.voice.prompterRelaysVoice(), false, "packaged looks under the app root, not desktop/");

  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voice-packaged-"));
  const script = path.join(appRoot, "voice", "listen.ps1");
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(script, '@{ type = "final"; text = $PSCommandPath } | ConvertTo-Json -Compress\n');
  const packaged = compose({ testMode: false, isPackaged: true, appRoot });
  assert.equal(packaged.voice.prompterRelaysVoice(), true);
  const helper = packaged.voice.voiceHelperInstance();
  try {
    assert.equal(helper.start("A").ok, true);
    assert.ok(await until(() => packaged.sent.some((s) => s.event.type === "final"), 20000), JSON.stringify(packaged.sent));
    assert.equal(packaged.sent.find((s) => s.event.type === "final").event.text, script);
  } finally { helper.stopAll(); }
});

const saved = process.env.SPLITPAGE_TEST_VOICE_HELPER;
const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log("ok   - " + c.name);
  } catch (err) {
    failures.push(c.name);
    console.log("FAIL - " + c.name + "\n       " + (err && err.stack || err));
  }
}
if (saved === undefined) delete process.env.SPLITPAGE_TEST_VOICE_HELPER;
else process.env.SPLITPAGE_TEST_VOICE_HELPER = saved;
console.log("");
if (failures.length) {
  console.log(`FAILURES (${failures.length} of ${cases.length})`);
  process.exit(1);
}
console.log(`ALL PASS (${cases.length} cases)`);
