/* desktop/test/prompter-share.test.mjs: unit tests for desktop/prompter-share.js,
 * the loopback listener behind the teleprompter's "Open in browser" (#86).
 *
 * Node built-ins only, no Electron: prompter-share.js is plain CommonJS, so
 * it is loaded for real and driven over real HTTP on 127.0.0.1. What this
 * cannot cover is main.js choosing WHAT to share from a tab's record and
 * handing the URL to the OS — that is desktop/test/smoke.mjs's
 * "teleprompter: open in browser" group.
 *
 * Prints ALL PASS and exits 0, or lists the failures and exits 1.
 *
 * Run: node desktop/test/prompter-share.test.mjs
 */
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

/* A raw request, so the Host header is whatever the case says it is. */
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
  assert.deepEqual(share.status(), { listening: false, port: null, shares: [] });
  await assert.rejects(request(port, "/"), /ECONNREFUSED|ECONNRESET|socket hang up/);
});

test("a share expires after its TTL", async () => {
  let clock = 1000;
  const share = makeShare({ now: () => clock, ttlMs: 60000 });
  try {
    const { port, token } = parseShareUrl(await share.publish("tab1", "a.md", "x"));
    const keep = parseShareUrl(await share.publish("tab2", "b.md", "y"));
    assert.equal((await request(port, "/prompter-script/" + token)).status, 200);
    clock += 60001;
    const gone = await request(port, "/prompter-script/" + token);
    assert.equal(gone.status, 404);
    assert.deepEqual(JSON.parse(gone.body), { error: "expired" });
    assert.ok(!share.status().shares.includes("tab1"));
    /* tab2 was published at the same moment, so it is past its TTL too. */
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
  assert.deepEqual(share.status(), { listening: false, port: null, shares: [] });
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
