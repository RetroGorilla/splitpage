import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createPrompterShare, isShareableName } = require(path.join(here, "..", "prompter-share.js"));

const STATIC = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" }
};
const FILES = { "index.html": "<!doctype html><title>app</title>", "icon.svg": "<svg/>", "sw.js": "// worker" };

function makeShare(extra) {
  return createPrompterShare(Object.assign({
    staticAllowlist: STATIC,
    readStatic: async (entry) => Buffer.from(FILES[entry.file], "utf8"),
    cspHeader: async () => "default-src 'self'; frame-ancestors 'none'",
    preferredPort: 0
  }, extra));
}

function request(port, pathname, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: pathname, method: o.method || "GET",
      headers: Object.assign({ host: `127.0.0.1:${port}`, connection: "close" }, o.headers || {})
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function parseShareUrl(url) {
  const u = new URL(url);
  const m = /^#script=([0-9a-f]{64})$/.exec(u.hash);
  return { url: u, port: Number(u.port), token: m ? m[1] : null };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("publish answers a loopback URL that starts in the teleprompter, token in the fragment", async () => {
  const share = makeShare();
  try {
    const { url, port, token } = parseShareUrl(await share.publish("tab1", "My Script.md", "# hello"));
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(port > 0);
    assert.equal(url.pathname, "/");
    assert.equal(url.search, "?teleprompter=1");
    assert.ok(token, "a 64-hex token in #script=");
  } finally { share.closeAll(); }
});

test("the script is served for its token, exactly, uncached, with no CORS", async () => {
  const share = makeShare();
  try {
    const text = "# Café — 日本語 😀\n\nline two";
    const { port, token } = parseShareUrl(await share.publish("tab1", "script.md", text));
    const res = await request(port, "/prompter-script/" + token);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { name: "script.md", text });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  } finally { share.closeAll(); }
});

test("a wrong or malformed token is a 404, not the script", async () => {
  const share = makeShare();
  try {
    const { port, token } = parseShareUrl(await share.publish("tab1", "script.splitpage", "{}"));
    const wrong = (token[0] === "a" ? "b" : "a") + token.slice(1);
    assert.equal((await request(port, "/prompter-script/" + wrong)).status, 404);
    assert.equal((await request(port, "/prompter-script/" + token.slice(0, 32))).status, 404);
    assert.equal((await request(port, "/prompter-script/")).status, 404);
  } finally { share.closeAll(); }
});

test("the app page is served with its CSP; sw.js is not; /api answers the no-server 404", async () => {
  const share = makeShare();
  try {
    const { port } = parseShareUrl(await share.publish("tab1", "script.md", "x"));
    const root = await request(port, "/");
    assert.equal(root.status, 200);
    assert.equal(root.body, FILES["index.html"]);
    assert.match(root.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal((await request(port, "/index.html")).status, 200);
    assert.equal((await request(port, "/icon.svg")).status, 200);
    assert.equal((await request(port, "/sw.js")).status, 404, "no service worker on this origin");
    const api = await request(port, "/api/health");
    assert.equal(api.status, 404);
    assert.deepEqual(JSON.parse(api.body), { error: "no server" });
    assert.equal((await request(port, "/../desktop/main.js")).status, 404);
    assert.equal((await request(port, "/%2e%2e/VERSION")).status, 404);
  } finally { share.closeAll(); }
});

test("a Host that is not this listener is refused (DNS rebinding)", async () => {
  const share = makeShare();
  try {
    const { port, token } = parseShareUrl(await share.publish("tab1", "script.md", "x"));
    const evil = await request(port, "/prompter-script/" + token, { headers: { host: `evil.example:${port}` } });
    assert.equal(evil.status, 403);
    const otherPort = await request(port, "/", { headers: { host: `127.0.0.1:${port + 1}` } });
    assert.equal(otherPort.status, 403);
    const localhost = await request(port, "/prompter-script/" + token, { headers: { host: `localhost:${port}` } });
    assert.equal(localhost.status, 200);
  } finally { share.closeAll(); }
});

test("only GET and HEAD", async () => {
  const share = makeShare();
  try {
    const { port, token } = parseShareUrl(await share.publish("tab1", "script.md", "x"));
    assert.equal((await request(port, "/prompter-script/" + token, { method: "POST" })).status, 405);
    assert.equal((await request(port, "/", { method: "DELETE" })).status, 405);
    const head = await request(port, "/prompter-script/" + token, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
  } finally { share.closeAll(); }
});

test("sharing again from the same tab replaces its old share; other tabs keep theirs", async () => {
  const share = makeShare();
  try {
    const first = parseShareUrl(await share.publish("tab1", "a.md", "first"));
    const other = parseShareUrl(await share.publish("tab2", "b.md", "other"));
    const second = parseShareUrl(await share.publish("tab1", "a.md", "second"));
    assert.equal(first.port, second.port, "one listener");
    assert.notEqual(first.token, second.token);
    assert.equal((await request(first.port, "/prompter-script/" + first.token)).status, 404);
    assert.equal(JSON.parse((await request(second.port, "/prompter-script/" + second.token)).body).text, "second");
    assert.equal(JSON.parse((await request(other.port, "/prompter-script/" + other.token)).body).text, "other");
    assert.deepEqual(share.status().shares.sort(), ["tab1", "tab2"]);
  } finally { share.closeAll(); }
});

test("revoking the last share closes the listener", async () => {
  const share = makeShare();
  const { port } = parseShareUrl(await share.publish("tab1", "a.md", "x"));
  assert.equal(share.status().listening, true);
  assert.equal(share.revoke("tab1"), true);
  assert.equal(share.revoke("tab1"), false);
  assert.deepEqual(share.status(), { listening: false, port: null, shares: [], voiceStreams: 0 });
  await assert.rejects(request(port, "/"), /ECONNREFUSED|ECONNRESET|socket hang up/);
});

test("a share expires after its TTL", async () => {
  let clock = 1000;
  const share = makeShare({ now: () => clock, ttlMs: 60000 });
  try {
    const { port, token } = parseShareUrl(await share.publish("tab1", "a.md", "x"));
    // tab2 published at same instant, so it also expires.
    const keep = parseShareUrl(await share.publish("tab2", "b.md", "y"));
    assert.equal((await request(port, "/prompter-script/" + token)).status, 200);
    clock += 60001;
    const gone = await request(port, "/prompter-script/" + token);
    assert.equal(gone.status, 404);
    assert.deepEqual(JSON.parse(gone.body), { error: "expired" });
    assert.ok(!share.status().shares.includes("tab1"));
    assert.equal((await request(keep.port, "/prompter-script/" + keep.token)).status, 404);
  } finally { share.closeAll(); }
});

test("only project files are shared, and the name is never a path", async () => {
  assert.ok(isShareableName("x.splitpage"));
  assert.ok(isShareableName("x.MD"));
  assert.ok(isShareableName("x.html"));
  assert.ok(!isShareableName("x.docx"));
  assert.ok(!isShareableName("x.csv"));
  assert.ok(!isShareableName(""));
  const share = makeShare();
  try {
    await assert.rejects(share.publish("tab1", "notes.docx", "x"), /not a project file/);
    await assert.rejects(share.publish("", "a.md", "x"), /no owner/);
    const { port, token } = parseShareUrl(await share.publish("tab1", "/home/someone/private/a.md", "x"));
    assert.equal(JSON.parse((await request(port, "/prompter-script/" + token)).body).name, "a.md");
  } finally { share.closeAll(); }
});

test("closeAll drops every share and the listener", async () => {
  const share = makeShare();
  await share.publish("tab1", "a.md", "x");
  await share.publish("tab2", "b.md", "y");
  share.closeAll();
  assert.deepEqual(share.status(), { listening: false, port: null, shares: [], voiceStreams: 0 });
});

function makeVoice(share, answer) {
  const log = [];
  let session = 0;
  let current = null;
  const voice = {
    log,
    start(ownerId) {
      log.push(["start", ownerId]);
      if (answer) return answer;
      current = { ownerId, session: ++session };
      return { ok: true, session: current.session };
    },
    stop(ownerId, s) { log.push(["stop", ownerId, s]); if (current && current.session === s) current = null; },
    emit(event) { if (current) share().pushVoice(current.ownerId, Object.assign({ session: current.session }, event)); },
    get current() { return current; }
  };
  return voice;
}

function openStream(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({
      host: "127.0.0.1", port, path: pathname, method: "GET",
      headers: Object.assign({ host: `127.0.0.1:${port}`, accept: "text/event-stream" }, headers || {})
    }, (res) => {
      let buf = "";
      const ended = new Promise((r) => res.on("close", r));
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)));
        }
      });
      resolve({ status: res.statusCode, headers: res.headers, events, ended, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));
async function until(fn, ms) {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await tick(10); }
  return false;
}

function parseVoice(url) {
  const m = /[#&]voice=(\d+)-([0-9a-f]{64})$/.exec(url);
  return m ? { port: Number(m[1]), token: m[2] } : null;
}

test("with a listener, a share carries a voice token of its own in the fragment", async () => {
  const ref = {};
  const voice = makeVoice(() => ref.share);
  const share = ref.share = makeShare({ voice });
  try {
    const url = await share.publish("tab1", "a.md", "x", { voice: true });
    const { token } = parseShareUrl(url.replace(/&voice=.*$/, ""));
    const v = parseVoice(url);
    assert.ok(token && v, url);
    assert.notEqual(v.token, token, "the relay token is not the script token");
    assert.equal(v.port, share.status().port);
    const plain = await share.publish("tab2", "b.md", "y");
    assert.equal(parseVoice(plain), null, "no voice unless asked for");
    const noVoice = makeShare();
    try { assert.equal(parseVoice(await noVoice.publish("tab1", "a.md", "x", { voice: true })), null, "no voice without a listener"); }
    finally { noVoice.closeAll(); }
  } finally { share.closeAll(); }
});

test("opening the stream starts the listener; its events arrive as data lines; closing it stops that session", async () => {
  const ref = {};
  const voice = makeVoice(() => ref.share);
  const share = ref.share = makeShare({ voice });
  try {
    const v = parseVoice(await share.publish("tab1", "a.md", "x", { voice: true }));
    const s = await openStream(v.port, "/prompter-voice/" + v.token);
    assert.equal(s.status, 200);
    assert.match(s.headers["content-type"], /^text\/event-stream/);
    assert.equal(s.headers["cache-control"], "no-store");
    assert.equal(s.headers["access-control-allow-origin"], undefined, "no CORS for an origin nobody named");
    assert.ok(await until(() => voice.log.length === 1));
    assert.deepEqual(voice.log[0], ["start", "tab1"]);
    assert.equal(share.status().voiceStreams, 1);
    voice.emit({ type: "start", lang: "en-US" });
    voice.emit({ type: "final", text: "hello world" });
    voice.emit({ type: "device", name: "USB mic" });
    share.pushVoice("tab1", { type: "final", session: 999, text: "stale" });
    assert.ok(await until(() => s.events.length === 3), JSON.stringify(s.events));
    assert.deepEqual(s.events.map((e) => e.type), ["start", "final", "device"]);
    assert.equal(s.events[1].text, "hello world");
    assert.equal(s.events[2].name, "USB mic", "an event type this file does not know passes through");
    s.close();
    assert.ok(await until(() => voice.log.length === 2));
    assert.deepEqual(voice.log[1], ["stop", "tab1", 1]);
    assert.ok(await until(() => share.status().voiceStreams === 0));
  } finally { share.closeAll(); }
});

test("an end event from the helper closes the stream without a stop", async () => {
  const ref = {};
  const voice = makeVoice(() => ref.share);
  const share = ref.share = makeShare({ voice });
  try {
    const v = parseVoice(await share.publish("tab1", "a.md", "x", { voice: true }));
    const s = await openStream(v.port, "/prompter-voice/" + v.token);
    assert.ok(await until(() => voice.current));
    voice.emit({ type: "end", reason: "taken" });
    await s.ended;
    assert.deepEqual(s.events.map((e) => e.type + ":" + (e.reason || "")), ["end:taken"]);
    assert.equal(voice.log.filter((l) => l[0] === "stop").length, 0);
  } finally { share.closeAll(); }
});

test("a refused start is an error then an end, and the stream closes", async () => {
  const ref = {};
  const voice = makeVoice(() => ref.share, { ok: false, code: "UNAVAILABLE" });
  const share = ref.share = makeShare({ voice });
  try {
    const v = parseVoice(await share.publish("tab1", "a.md", "x", { voice: true }));
    const s = await openStream(v.port, "/prompter-voice/" + v.token);
    await s.ended;
    assert.deepEqual(s.events, [{ type: "error", code: "unavailable" }, { type: "end", reason: "exited" }]);
  } finally { share.closeAll(); }
});

test("sharing again, or revoking, ends the old relay; a wrong or old token is 404", async () => {
  const ref = {};
  const voice = makeVoice(() => ref.share);
  const share = ref.share = makeShare({ voice });
  try {
    const v1 = parseVoice(await share.publish("tab1", "a.md", "x", { voice: true }));
    assert.equal((await request(v1.port, "/prompter-voice/" + "0".repeat(64))).status, 404);
    const s1 = await openStream(v1.port, "/prompter-voice/" + v1.token);
    assert.ok(await until(() => voice.current));
    const v2 = parseVoice(await share.publish("tab1", "a.md", "x2", { voice: true }));
    await s1.ended;
    assert.equal(s1.events[s1.events.length - 1].reason, "revoked");
    assert.deepEqual(voice.log[voice.log.length - 1], ["stop", "tab1", 1]);
    assert.equal((await request(v1.port, "/prompter-voice/" + v1.token)).status, 404);
    const s2 = await openStream(v2.port, "/prompter-voice/" + v2.token);
    assert.ok(await until(() => voice.current && voice.current.session === 2));
    share.revoke("tab1");
    await s2.ended;
    assert.equal(s2.events[s2.events.length - 1].reason, "revoked");
    assert.deepEqual(voice.log[voice.log.length - 1], ["stop", "tab1", 2]);
  } finally { share.closeAll(); }
});

test("a relay-only share serves no script, and lets the document server's origin read it", async () => {
  const ref = {};
  const voice = makeVoice(() => ref.share);
  const share = ref.share = makeShare({ voice, corsOrigins: () => ["http://127.0.0.1:8791"] });
  try {
    const param = await share.publishVoice("tab9");
    const v = parseVoice("#" + param);
    assert.ok(v, param);
    const s = await openStream(v.port, "/prompter-voice/" + v.token, { origin: "http://127.0.0.1:8791" });
    assert.equal(s.headers["access-control-allow-origin"], "http://127.0.0.1:8791");
    s.close();
    const other = await openStream(v.port, "/prompter-voice/" + v.token, { origin: "http://evil.example" });
    assert.equal(other.headers["access-control-allow-origin"], undefined);
    other.close();
    const forged = await request(v.port, "/prompter-voice/" + v.token, { headers: { host: "rebind.example:" + v.port } });
    assert.equal(forged.status, 403);
  } finally { share.closeAll(); }
});

test("a relay in use outlives the share's TTL; an idle one does not", async () => {
  const ref = {};
  const voice = makeVoice(() => ref.share);
  const share = ref.share = makeShare({ voice, ttlMs: 150 });
  try {
    const v = parseVoice(await share.publish("tab1", "a.md", "x", { voice: true }));
    const s = await openStream(v.port, "/prompter-voice/" + v.token);
    assert.ok(await until(() => voice.current));
    await tick(400);
    assert.ok(share.status().shares.includes("tab1"), "kept while the stream is open");
    s.close();
    assert.ok(await until(() => !share.status().shares.includes("tab1"), 2000), "dropped once it is not");
  } finally { share.closeAll(); }
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
