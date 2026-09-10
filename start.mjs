#!/usr/bin/env node
/* Splitpage launcher — one command, any OS.
 *
 *   node start.mjs              serve the app and open it in your browser
 *   node start.mjs --library    also run the document server (see below)
 *   node start.mjs --port 9000  use a different port
 *   node start.mjs --no-open    don't launch a browser
 *
 * WHY SERVE IT AT ALL, rather than just opening index.html?
 * Browsers only give a page installed-app status, a service worker (offline
 * use) and a microphone when it arrives over http(s). Opened off disk as a
 * file:// URL, Splitpage still edits and exports fine, but "Install app" and
 * Follow My Voice are both unavailable. That is the whole reason this exists.
 *
 * DEFAULT MODE IS DELIBERATELY DUMB. It serves files and nothing else, so the
 * app stays in local mode: a document is an .html file you save to disk, which
 * is the workflow this tool has always had. --library additionally runs the
 * document API and keeps documents on the server in ./data — the same thing
 * the Docker image does, minus the sharing.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ---------- arguments ---------- */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function valueOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
}

if (has("--help") || has("-h")) {
  console.log(`
Splitpage launcher

  node start.mjs                serve the app and open it in your browser
  node start.mjs --library      keep documents on the server, in ./data
  node start.mjs --port 9000    use a different port (default 8791)
  node start.mjs --no-open      don't launch a browser
`);
  process.exit(0);
}

const LIBRARY = has("--library");
const WANTED_PORT = Number(valueOf("--port", 8791));
if (!Number.isInteger(WANTED_PORT) || WANTED_PORT < 1 || WANTED_PORT > 65535) {
  console.error("--port must be a number between 1 and 65535");
  process.exit(1);
}

/* ---------- build, if this is a source checkout ---------- */

/* A downloaded release is just the built files, with no src/ and nothing to
   build. In a checkout, building first means you never debug a change you
   forgot to compile. */
if (existsSync(join(ROOT, "build.mjs")) && existsSync(join(ROOT, "src"))) {
  const built = spawn(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, stdio: "inherit" });
  const code = await new Promise((r) => built.on("exit", r));
  if (code !== 0) {
    console.error("\nBuild failed — not starting. Fix the error above and try again.");
    process.exit(1);
  }
}

if (!existsSync(join(ROOT, "index.html"))) {
  console.error("index.html is missing, and there is no src/ to build it from.");
  process.exit(1);
}

/* ---------- find a port ---------- */

function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

let port = WANTED_PORT;
for (let i = 0; i < 20 && !(await isFree(port)); i++) port++;
if (!(await isFree(port))) {
  console.error(`Ports ${WANTED_PORT}-${port} are all busy. Try --port with something else.`);
  process.exit(1);
}
if (port !== WANTED_PORT) {
  console.log(`Port ${WANTED_PORT} was busy — using ${port} instead.`);
}

/* ---------- run the server ---------- */

const server = spawn(process.execPath, [join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    PORT: String(port),
    /* localhost only. There is no authentication in that process on purpose,
       so a launcher must never put it on the network — that is what the
       Docker image plus Cloudflare Access in DEPLOY.md is for. */
    HOST: "127.0.0.1",
    STATIC_DIR: ROOT,
    DATA_DIR: join(ROOT, "data"),
    NO_API: LIBRARY ? "0" : "1"
  }
});

server.on("exit", (code) => process.exit(code == null ? 0 : code));

/* ---------- wait for it, then open a browser ---------- */

const url = `http://localhost:${port}/`;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url + "index.html", { method: "HEAD" });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error("The server did not come up. Look for an error above.");
  server.kill();
  process.exit(1);
}

console.log(`
  Splitpage is running at ${url}
  ${LIBRARY ? "Documents are kept on the server, in ./data" : "Documents are files you save to disk (--library keeps them on the server)"}

  In Chrome or Edge, use the install icon in the address bar to add it as
  its own app window. Leave this window open while you work; Ctrl+C stops it.
`);

if (!has("--no-open")) {
  /* Handed to the OS opener as a single argument and never through a shell,
     so the URL cannot be reinterpreted as anything else. */
  const opener =
    platform === "win32" ? { cmd: "cmd", args: ["/c", "start", "", url] }
    : platform === "darwin" ? { cmd: "open", args: [url] }
    : { cmd: "xdg-open", args: [url] };
  const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`  (Could not open a browser — go to ${url} yourself.)`));
  child.unref();
}

/* Ctrl+C should stop the server too, not orphan it. */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.kill(); process.exit(0); });
}
