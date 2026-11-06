import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createVoiceHelper, parseHelperLine, parseMicrophonesLine } = require(path.join(here, "..", "voice-helper.ts"));
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

test("a scoped stop cleans up its listener without stopping a newer session or another tab", async () => {
  const { helper, events } = makeHelper("listen");
  try {
    const first = helper.start("t1");
    helper.stop("t1", first.session);
    assert.equal(helper.status().running, false);
    const newer = helper.start("t1");
    await until(() => events.some((e) => e.session === newer.session && e.type === "start"));
    helper.stop("t1", first.session);
    assert.equal(helper.status().running, true);
    assert.equal(helper.status().session, newer.session);
    helper.stop("t2", newer.session);
    assert.equal(helper.status().running, true);
    helper.stop("t1", newer.session);
    assert.equal(helper.status().running, false);
  } finally { helper.stopAll(); }
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

const MIC_ONE = "{0.0.1.00000000}.{11111111-1111-4111-8111-111111111111}";
const MIC_TWO = "{0.0.1.00000000}.{22222222-2222-4222-8222-222222222222}";
const FAKE_MICS = JSON.stringify([{ id: MIC_ONE, name: "Microphone (One)" }, { id: MIC_TWO, name: "Microphone (Two)" }]);

async function withMicrophones(fn) {
  process.env.FAKE_VOICE_MICROPHONES = FAKE_MICS;
  try { return await fn(); } finally { delete process.env.FAKE_VOICE_MICROPHONES; }
}

test("parseHelperLine keeps a fallback with nothing else on it, and a lost microphone as an error code", () => {
  assert.deepEqual(parseHelperLine('{"type":"fallback"}'), { type: "fallback" });
  assert.deepEqual(parseHelperLine('{"type":"fallback","name":"x","code":"y"}'), { type: "fallback" });
  assert.deepEqual(parseHelperLine('{"type":"error","code":"device-lost"}'), { type: "error", code: "device-lost" });
});

test("parseMicrophonesLine keeps only capture endpoint ids with a name, capped and de-duplicated", () => {
  assert.deepEqual(parseMicrophonesLine(JSON.stringify({ type: "microphones", list: [{ id: MIC_ONE, name: " Microphone (One)\u0000 " }] })),
    [{ id: MIC_ONE, name: "Microphone (One)" }]);
  assert.deepEqual(parseMicrophonesLine(JSON.stringify({ type: "microphones", list: [] })), []);
  const junk = [{ id: "x; calc.exe", name: "Bad" }, { id: "{0.0.0.00000000}.{11111111-1111-4111-8111-111111111111}", name: "Speakers" },
    { id: MIC_ONE, name: 7 }, { id: MIC_ONE, name: "  " }, null, "x", { id: MIC_TWO, name: "Two" }, { id: MIC_TWO.toUpperCase(), name: "Two again" }];
  assert.deepEqual(parseMicrophonesLine(JSON.stringify({ type: "microphones", list: junk })), [{ id: MIC_TWO, name: "Two" }]);
  assert.equal(parseMicrophonesLine(JSON.stringify({ type: "microphones", list: [{ id: MIC_ONE, name: "m".repeat(500) }] }))[0].name.length, 120);
  const many = Array.from({ length: 100 }, (_, i) => ({ id: "{0.0.1.00000000}.{" + String(i).padStart(8, "0") + "-1111-4111-8111-111111111111}", name: "Mic " + i }));
  assert.equal(parseMicrophonesLine(JSON.stringify({ type: "microphones", list: many })).length, 64);
  for (const line of ["", "nope", "[]", '{"type":"microphones"}', '{"type":"microphones","list":{}}', '{"type":"device","list":[]}']) {
    assert.equal(parseMicrophonesLine(line), null, line);
  }
});

test("microphones() asks the helper with -List and returns what it lists", async () => {
  await withMicrophones(async () => {
    const { helper } = makeHelper("listen");
    assert.deepEqual(await helper.microphones(), { ok: true, microphones: [{ id: MIC_ONE, name: "Microphone (One)" }, { id: MIC_TWO, name: "Microphone (Two)" }] });
    assert.equal(helper.status().running, false, "listing starts no listening session");
  });
});

test("microphones() drops junk entries, and asks only once while a list is under way", async () => {
  await withMicrophones(async () => {
    let spawns = 0;
    const { helper } = makeHelper("list-junk", { spawn: (...args) => { spawns++; return spawn(...args); } });
    const [a, b] = await Promise.all([helper.microphones(), helper.microphones()]);
    assert.equal(spawns, 1);
    assert.deepEqual(a, b);
    assert.deepEqual(a.microphones.map((m) => m.id), [MIC_ONE, MIC_TWO]);
    await helper.microphones();
    assert.equal(spawns, 2, "a later call asks again, so a plugged-in microphone shows");
  });
});

test("microphones() gives up on a helper that never answers, and kills it", async () => {
  let child = null;
  const { helper } = makeHelper("list-silent", { listTimeoutMs: 300, spawn: (...args) => (child = spawn(...args)) });
  assert.deepEqual(await helper.microphones(), { ok: false, code: "LIST_FAILED" });
  const alive = () => { try { process.kill(child.pid, 0); return true; } catch { return false; } };
  await until(() => !alive(), 5000);
});

test("microphones() without a helper is unavailable", async () => {
  const helper = createVoiceHelper({ command: () => null, onEvent: () => {} });
  assert.deepEqual(await helper.microphones(), { ok: false, code: "UNAVAILABLE" });
});

test("start passes the chosen microphone to the helper as -Device, and the helper's name for it reaches the tab", async () => {
  await withMicrophones(async () => {
    const { helper, events } = makeHelper("listen");
    const answer = helper.start("t1", MIC_TWO);
    assert.equal(answer.ok, true);
    await until(() => events.some((e) => e.type === "final"));
    assert.deepEqual(events.map((e) => e.type), ["device", "start", "interim", "final"]);
    assert.equal(events[0].name, "Microphone (Two)");
    helper.stopAll();
  });
});

test("start without a microphone passes no -Device, as before", async () => {
  let args = null;
  const { helper, events } = makeHelper("listen", { spawn: (file, given, opts) => { args = given; return spawn(file, given, opts); } });
  helper.start("t1");
  await until(() => events.some((e) => e.type === "final"));
  assert.deepEqual(args, [FAKE]);
  helper.stopAll();
});

test("a chosen microphone the helper cannot find comes back as a fallback before start", async () => {
  await withMicrophones(async () => {
    process.env.FAKE_VOICE_DEVICE = "Microphone (Default)";
    try {
      const { helper, events } = makeHelper("listen");
      helper.start("t1", "{0.0.1.00000000}.{33333333-3333-4333-8333-333333333333}");
      await until(() => events.some((e) => e.type === "final"));
      assert.deepEqual(events.map((e) => e.type), ["fallback", "device", "start", "interim", "final"]);
      assert.equal(events[1].name, "Microphone (Default)");
      helper.stopAll();
    } finally {
      delete process.env.FAKE_VOICE_DEVICE;
    }
  });
});

test("start refuses anything that is not a capture endpoint id, and spawns nothing", async () => {
  let spawns = 0;
  const { helper } = makeHelper("listen", { spawn: (...args) => { spawns++; return spawn(...args); } });
  for (const bad of ["", "-List", "x; calc.exe", MIC_ONE + " -List", "{0.0.0.00000000}.{11111111-1111-4111-8111-111111111111}", 7]) {
    assert.deepEqual(helper.start("t1", bad), { ok: false, code: "BAD_MICROPHONE" }, String(bad));
  }
  assert.equal(spawns, 0);
});

test("a chosen microphone that goes away ends the session after a device-lost error", async () => {
  await withMicrophones(async () => {
    const { helper, events } = makeHelper("lost");
    helper.start("t1", MIC_ONE);
    await until(() => events.some((e) => e.type === "end"));
    assert.deepEqual(events.map((e) => e.type), ["device", "start", "error", "end"]);
    assert.equal(events[2].code, "device-lost");
    assert.equal(events[3].reason, "exited");
  });
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
