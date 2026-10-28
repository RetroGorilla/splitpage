import { spawn } from "node:child_process";
import { createServer, connect as netConnect } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server", "server.js");

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(staticDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STATIC_DIR: staticDir }
  });
  let log = "";
  let exitCode = null;
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });
  child.once("exit", (code) => { exitCode = code; });
  const base = "http://127.0.0.1:" + port + "/";
  for (let i = 0; i < 80 && exitCode === null; i++) {
    try {
      const res = await fetch(base, { method: "HEAD" });
      if (res.status) break;
    } catch { }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    port,
    stop() { child.kill(); },
    get exitCode() { return exitCode; },
    get log() { return log; }
  };
}

function rawRequest(port, text) {
  return new Promise((resolve) => {
    const sock = netConnect(port, "127.0.0.1");
    let got = "";
    const timer = setTimeout(() => sock.destroy(), 5000);
    sock.on("connect", () => sock.write(text));
    sock.on("data", (c) => { got += c; });
    sock.on("error", () => { });
    sock.on("close", () => { clearTimeout(timer); resolve(got); });
  });
}

function statusOf(answer) {
  const m = /^HTTP\/1\.1 (\d+) /.exec(answer);
  return m ? Number(m[1]) : 0;
}

const root = mkdtempSync(join(tmpdir(), "splitpage-static-"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>");
writeFileSync(join(root, "app.js"), "console.log(1);");
writeFileSync(join(root, "sw.js"), "self.x = 1;");
writeFileSync(join(root, "icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
writeFileSync(join(root, "blob.bin"), "abc");
mkdirSync(join(root, ".git"));
writeFileSync(join(root, ".git", "config"), "[remote \"origin\"]\n");
writeFileSync(join(root, ".env"), "SECRET=1\n");
mkdirSync(join(root, "sub"));
writeFileSync(join(root, "sub", "page.txt"), "hello");

const outside = mkdtempSync(join(tmpdir(), "splitpage-outside-"));
writeFileSync(join(outside, "secret.txt"), "outside");

const s = await startServer(root);
try {
  const base = s.base;

  const index = await fetch(base);
  eq("/ serves the app", index.status, 200);
  eq("...as HTML", index.headers.get("content-type"), "text/html; charset=utf-8");
  eq("...which must be revalidated", index.headers.get("cache-control"), "no-cache");
  eq("...and may only be framed by itself", index.headers.get("content-security-policy"), "frame-ancestors 'self'");
  eq("...with the page body", await index.text(), "<!doctype html><title>t</title>");

  const js = await fetch(base + "app.js");
  eq("an asset is served", js.status, 200);
  eq("...with its type", js.headers.get("content-type"), "text/javascript; charset=utf-8");
  eq("...cached for an hour", js.headers.get("cache-control"), "public, max-age=3600");
  eq("...without the framing policy", js.headers.get("content-security-policy"), null);
  eq("an svg has its type", (await fetch(base + "icon.svg")).headers.get("content-type"), "image/svg+xml");
  eq("an unknown extension is a byte stream", (await fetch(base + "blob.bin")).headers.get("content-type"), "application/octet-stream");
  eq("a file in a folder is served", await (await fetch(base + "sub/page.txt")).text(), "hello");
  eq("the service worker is never cached", (await fetch(base + "sw.js")).headers.get("cache-control"), "no-cache");

  const head = await fetch(base + "app.js", { method: "HEAD" });
  eq("HEAD is answered", head.status, 200);
  eq("...with the length", head.headers.get("content-length"), String("console.log(1);".length));
  eq("...and no body", (await head.text()).length, 0);

  eq("a missing file is 404", (await fetch(base + "nope.js")).status, 404);
  eq("a folder is 404", (await fetch(base + "sub")).status, 404);
  eq("static files never carry CORS headers", (await fetch(base + "index.html", { headers: { Origin: "http://example.test" } })).headers.get("access-control-allow-origin"), null);

  eq("POST is 405", (await fetch(base + "index.html", { method: "POST", body: "x" })).status, 405);
  eq("PUT is 405", (await fetch(base + "index.html", { method: "PUT", body: "x" })).status, 405);
  eq("DELETE is 405", (await fetch(base + "index.html", { method: "DELETE" })).status, 405);

  for (const path of ["api/health", "api/docs", "api/join", "api/me", "api/share", "api/presence", "api/blobs/missing", "api/launcher/info"]) {
    eq("/" + path + " is a plain 404, not an API", (await fetch(base + path)).status, 404);
  }
  const apiBody = await fetch(base + "api/health");
  eq("...as text, not JSON", apiBody.headers.get("content-type"), "text/plain; charset=utf-8");
  eq("a POST to /api/docs is refused", (await fetch(base + "api/docs", { method: "POST", body: "{}" })).status, 405);

  eq("nothing whose name starts with a dot: .git/config", (await fetch(base + ".git/config")).status, 404);
  eq("...nor .env", (await fetch(base + ".env")).status, 404);
  eq("...nor percent-encoded", (await fetch(base + "%2Eenv")).status, 404);
  eq("...nor a dot folder", (await fetch(base + ".git/")).status, 404);

  eq("a percent-encoded .. is refused", statusOf(await rawRequest(s.port, "GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")) >= 400, true);
  const traversal = await rawRequest(s.port, "GET /..%2f" + outside.split(/[\\/]/).pop() + "/secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  check("a ..%2f path to a file outside the root is not served", !traversal.includes("outside") && statusOf(traversal) >= 400, JSON.stringify(traversal.slice(0, 80)));
  const raw = await rawRequest(s.port, "GET /../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  check("a raw /../ path is not served", !raw.includes("splitpage") || statusOf(raw) >= 400, JSON.stringify(raw.slice(0, 80)));
  eq("a bad percent escape is 400", statusOf(await rawRequest(s.port, "GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")), 400);
  eq("a request line of // is 400", statusOf(await rawRequest(s.port, "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")), 400);
  for (const target of ["http://[", "//["]) {
    const answer = await rawRequest(s.port, "GET " + target + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    eq("a request target the URL constructor rejects (" + target + ") is answered 400", statusOf(answer), 400);
  }
  eq("...and the server is still up afterwards", (await fetch(base)).status, 200);
  check("...with no server error logged for any of it", !/RangeError|TypeError|Server error/.test(s.log), s.log);
  check("it says where it is serving from", s.log.includes("static files from " + root), s.log);
  check("it mentions no documents, PIN or API", !/documents in|PIN|API|DATA_DIR/.test(s.log), s.log);
} finally {
  s.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

console.log("");
if (failures.length) {
  console.log("FAILED " + failures.length + " of " + (passed + failures.length) + " checks:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL PASS - " + passed + "/" + passed + " server checks");
process.exit(0);
