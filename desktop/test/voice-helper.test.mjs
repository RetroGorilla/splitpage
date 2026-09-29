import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createVoiceHelper, parseHelperLine } = require(path.join(here, "..", "voice-helper.js"));
const FAKE = path.join(here, "fake-voice-helper.mjs");

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function makeHelper(mode, extra) {
  const events = [];
  const helper = createVoiceHelper(Object.assign({
    command: () => ({
      file: process.execPath,
      args: [FAKE],
      env: Object.assign({}, process.env, { FAKE_VOICE_MODE: mode || "listen" })
    }),
    onEvent: (tabId, event) => events.push({ tabId, ...event }),
    killAfterMs: 300
  }, extra));
  return { helper, events };
}

async function until(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

test("parseHelperLine keeps the known shapes and rebuilds them field by field", () => {
  assert.deepEqual(parseHelperLine('{"type":"final","text":"hi there"}'), { type: "final", text: "hi there" });
  assert.deepEqual(parseHelperLine('{"type":"interim","text":"hi","html":"<b>"}'), { type: "interim", text: "hi" });
  assert.deepEqual(parseHelperLine('{"type":"start","lang":"en-GB"}'), { type: "start", lang: "en-GB" });
  assert.deepEqual(parseHelperLine('{"type":"start","lang":"<x>"}'), { type: "start" });
  assert.deepEqual(parseHelperLine('{"type":"error","code":"no-recognizer"}'), { type: "error", code: "no-recognizer" });
  assert.deepEqual(parseHelperLine('{"type":"warning","code":"no-signal"}'), { type: "warning", code: "no-signal" });
});

test("parseHelperLine drops anything else", () => {
  for (const line of ["", "nope", "[]", "null", '"final"', '{"type":"exec"}', '{"type":"end"}',
    '{"type":"final"}', '{"type":"final","text":7}', '{"type":"error","code":"<script>"}',
    '{"type":"error","code":"A"}', '{"type":"warning"}']) {
    assert.equal(parseHelperLine(line), null, line);
  }
});

test("parseHelperLine keeps a microphone's name as plain, capped text (#118)", () => {
  assert.deepEqual(parseHelperLine('{"type":"device","name":"Microphone (USB Audio)"}'), { type: "device", name: "Microphone (USB Audio)" });
  assert.deepEqual(parseHelperLine(JSON.stringify({ type: "device", name: "  Mic\u0000\n <b>x</b> ", code: "x" })), { type: "device", name: "Mic <b>x</b>" });
  assert.equal(parseHelperLine(JSON.stringify({ type: "device", name: "m".repeat(500) })).name.length, 120);
  for (const line of ['{"type":"device"}', '{"type":"device","name":7}', JSON.stringify({ type: "device", name: " \u0007 " })]) {
    assert.equal(parseHelperLine(line), null, line);
  }
});

test("parseHelperLine caps text", () => {
  const long = "a".repeat(5000);
  assert.equal(parseHelperLine(JSON.stringify({ type: "final", text: long })).text.length, 2000);
});

test("no command means unavailable, and start refuses", () => {
  const helper = createVoiceHelper({ command: () => null, onEvent: () => {} });
  assert.equal(helper.available(), false);
  assert.deepEqual(helper.start("t1"), { ok: false, code: "UNAVAILABLE" });
  assert.equal(helper.status().running, false);
});

test("a session's events reach its tab, tagged with its session", async () => {
  const { helper, events } = makeHelper("listen");
  const answer = helper.start("t1");
  assert.equal(answer.ok, true);
  assert.equal(typeof answer.session, "number");
  await until(() => events.some((e) => e.type === "final"));
  assert.deepEqual(events.map((e) => e.type), ["start", "interim", "final"]);
  assert.ok(events.every((e) => e.tabId === "t1" && e.session === answer.session));
  assert.equal(events[2].text, "hello world");
  assert.equal(events[0].lang, "en-US");
  assert.equal(helper.status().running, true);
  assert.equal(helper.status().tabId, "t1");
  helper.stop("t1");
  assert.equal(events.at(-1).type, "end");
  assert.equal(events.at(-1).reason, "stopped");
  assert.equal(helper.status().running, false);
});

test("the microphone's name reaches the tab before start (#118)", async () => {
  process.env.FAKE_VOICE_DEVICE = "Microphone (Fake Array)";
  try {
    const { helper, events } = makeHelper("listen");
    const answer = helper.start("t1");
    await until(() => events.some((e) => e.type === "final"));
    assert.deepEqual(events.map((e) => e.type), ["device", "start", "interim", "final"]);
    assert.deepEqual(events[0], { tabId: "t1", session: answer.session, type: "device", name: "Microphone (Fake Array)" });
    helper.stopAll();
  } finally {
    delete process.env.FAKE_VOICE_DEVICE;
  }
});

test("junk from the helper never reaches the page", async () => {
  const { helper, events } = makeHelper("junk");
  helper.start("t1");
  await until(() => events.some((e) => e.type === "final"));
  const finals = events.filter((e) => e.type === "final");
  assert.equal(finals.length, 1);
  assert.deepEqual(Object.keys(finals[0]).sort(), ["session", "tabId", "text", "type"]);
  assert.ok(!events.some((e) => e.type === "exec" || e.type === "error"));
  helper.stopAll();
});

test("a helper that stops by itself ends the session", async () => {
  const { helper, events } = makeHelper("crash");
  helper.start("t1");
  await until(() => events.some((e) => e.type === "end"));
  assert.equal(events.at(-1).reason, "exited");
  assert.equal(helper.status().running, false);
});

test("the no-recognizer error arrives before the end", async () => {
  const { helper, events } = makeHelper("no-recognizer");
  helper.start("t1");
  await until(() => events.some((e) => e.type === "end"));
  assert.deepEqual(events.map((e) => e.type), ["error", "end"]);
  assert.equal(events[0].code, "no-recognizer");
});

test("only the owning tab can stop a session", async () => {
  const { helper, events } = makeHelper("listen");
  helper.start("t1");
  await until(() => events.some((e) => e.type === "start"));
  helper.stop("t2");
  assert.equal(helper.status().running, true);
  helper.stop("t1");
  assert.equal(helper.status().running, false);
});

test("a second tab takes the microphone over; the first is told", async () => {
  const { helper, events } = makeHelper("listen");
  const a = helper.start("t1");
  await until(() => events.some((e) => e.tabId === "t1" && e.type === "final"));
  const b = helper.start("t2");
  assert.ok(b.session > a.session);
  const taken = events.find((e) => e.tabId === "t1" && e.type === "end");
  assert.ok(taken, "t1 told");
  assert.equal(taken.reason, "taken");
  await until(() => events.some((e) => e.tabId === "t2" && e.type === "final"));
  assert.equal(helper.status().tabId, "t2");
  assert.equal(helper.status().started, 2);
  helper.stopAll();
});

test("a tab closing ends its session without an event", async () => {
  const { helper, events } = makeHelper("listen");
  helper.start("t1");
  await until(() => events.some((e) => e.type === "final"));
  const before = events.length;
  helper.forget("t2");
  assert.equal(helper.status().running, true, "another tab's close leaves it");
  helper.forget("t1");
  assert.equal(helper.status().running, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.length, before, "nothing sent to a closed tab");
});

test("a helper that ignores its stdin closing is killed", async () => {
  const { helper, events } = makeHelper("stubborn");
  helper.start("t1");
  await until(() => events.some((e) => e.type === "start"));
  const pid = helper.status().pid;
  helper.stop("t1");
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await until(() => !alive(), 5000);
});

test("a helper that cannot be spawned says so and ends", async () => {
  const events = [];
  const helper = createVoiceHelper({
    command: () => ({ file: path.join(here, "no-such-helper-binary"), args: [] }),
    onEvent: (tabId, event) => events.push({ tabId, ...event })
  });
  const answer = helper.start("t1");
  assert.equal(answer.ok, true, "spawn reports ENOENT asynchronously");
  await until(() => events.some((e) => e.type === "end"));
  assert.deepEqual(events.map((e) => e.type), ["error", "end"]);
  assert.equal(events[0].code, "helper-failed");
});

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
console.log("");
if (failures.length) {
  console.log(`FAILURES (${failures.length} of ${cases.length})`);
  process.exit(1);
}
console.log(`ALL PASS (${cases.length} cases)`);
