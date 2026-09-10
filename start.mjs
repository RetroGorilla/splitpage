#!/usr/bin/env node
/* Splitpage launcher — one command, any OS.
 *
 *   node start.mjs              serve the app and open it in your browser
 *   node start.mjs --library    also run the document server (see below)
 *   node start.mjs --port 9000  use a different port
 *   node start.mjs --no-open    don't launch a browser
 *   node start.mjs --data DIR   where --library keeps documents
 *   node start.mjs --no-update-check   skip the background update check
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
import { networkInterfaces } from "node:os";
import { writeFileSync, readFileSync } from "node:fs";

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
  node start.mjs --host         host a shared session others on your network
                                can open and edit (implies --library)
  node start.mjs --port 9000    use a different port (default 8791)
  node start.mjs --no-open      don't launch a browser
  node start.mjs --data DIR     where --library keeps documents
                                (default: ./data beside this script)
  node start.mjs --no-update-check
                                don't look for a new version in the background

Updates install at launch and never while the app is open (see update.mjs):
  node update.mjs   downloads one, and the next start puts it in place.
`);
  process.exit(0);
}

/* Hosting is sharing, and sharing means the documents have to live somewhere
   both people can reach — so it implies the library. */
const HOSTING = has("--host");
const LIBRARY = HOSTING || has("--library");
/* An installed copy lives somewhere the user does not browse, so documents
   should be able to live somewhere they do. */
const DATA_DIR = valueOf("--data", join(ROOT, "data"));
const WANTED_PORT = Number(valueOf("--port", 8791));
if (!Number.isInteger(WANTED_PORT) || WANTED_PORT < 1 || WANTED_PORT > 65535) {
  console.error("--port must be a number between 1 and 65535");
  process.exit(1);
}

/* ---------- install anything update.mjs staged ----------
 *
 * Here, before the server starts and before a browser has the app open: this
 * is the one moment when replacing index.html is safe. update.mjs only ever
 * downloads and verifies; the swap happens exactly here.
 */

let applied = null;
if (existsSync(join(ROOT, "update.mjs"))) {
  try {
    const updater = await import("./update.mjs");
    applied = updater.apply({ log: (m) => console.log(m) });
  } catch (err) {
    /* A failed update rolls itself back, so the old version is still intact
       and the right thing to do is start it and say what happened. */
    console.error(`  update could not be installed: ${err.message}`);
    console.error("  starting the version you already had.");
  }
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

/* Probes whatever address the real server will actually bind — always
   127.0.0.1 before, regardless of --host, while server.js binds 0.0.0.0
   whenever HOSTING is set. A wildcard bind can conflict with something
   already listening on a specific interface (or vice versa) in ways a
   loopback-only probe can never see, so a "free" port here could still
   fail in the real server. */
function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOSTING ? "0.0.0.0" : "127.0.0.1");
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

/* ---------- tell the app where it stands ----------
 *
 * A plain file the page fetches. The app can then show "an update is ready"
 * without this process growing an HTTP route that installs things — which,
 * on an unauthenticated localhost server, would be reachable from any other
 * page in the browser.
 */

const STATUS_FILE = join(ROOT, "update-status.json");

let updater = null;
try { updater = await import("./update.mjs"); } catch { /* a release without it */ }

function readVersion() {
  try { return readFileSync(join(ROOT, "VERSION"), "utf8").trim(); } catch { return null; }
}

function readStatus() {
  try { return JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return {}; }
}

function writeStatus(extra) {
  const previous = readStatus();
  const version = readVersion();
  /* Carry forward what the last run learned. Starting from a blank slate
     every launch would hide a known update whenever the check is skipped
     (--no-update-check) or fails (offline) — which is exactly when the file
     is the only thing that still knows. updateAvailable is recomputed rather
     than carried, so it goes false by itself once the update is installed. */
  const latest = extra.latest !== undefined ? extra.latest : (previous.latest ?? null);
  const status = {
    /* Carry the whole previous status forward, not just `latest` — a
       field like justUpdated (set right after applying a staged update,
       for the frontend to show a "you're now on vX" banner) used to be
       silently dropped the moment ANY later writeStatus() call didn't
       itself re-supply it, which the background update-check does
       moments later. Fields below override this as intended; `extra`
       (the caller's actual update) always wins last. */
    ...previous,
    version,
    checkedAt: new Date().toISOString(),
    latest,
    updateAvailable: !!latest && !!version && updater
      ? updater.compareVersions(latest, version) > 0
      : false,
    ...extra,
    /* ...but never let a stale updateAvailable from `extra` win over the
       recomputation above when the versions say otherwise. */
    ...(extra.updateAvailable === undefined ? {} : { updateAvailable: extra.updateAvailable })
  };
  if (status.latest && version && updater && updater.compareVersions(status.latest, version) <= 0) {
    status.updateAvailable = false;
  }
  try { writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + "\n"); } catch { /* read-only dir */ }
}

writeStatus({ pending: updater ? updater.pending() : null, justUpdated: applied });

/* Deliberately not awaited: a slow or unreachable update server must never
   delay the app opening. Whatever it finds lands in the file, and the page
   picks it up on this load or the next one. */
if (!has("--no-update-check") && updater) {
  (async () => {
    try {
      const res = await fetch(process.env.SPLITPAGE_UPDATE_API
        || "https://api.github.com/repos/RetroGorilla/splitpage/releases/latest",
        { headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-launcher" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json();
      const latest = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
      const current = readVersion() || "0.0.0";
      writeStatus({
        latest,
        updateAvailable: !!latest && updater.compareVersions(latest, current) > 0,
        pending: updater.pending()
      });
    } catch (err) {
      writeStatus({ error: err.message, pending: updater.pending() });
    }
  })();
}

/* ---------- run the server ---------- */

const server = spawn(process.execPath, [join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    PORT: String(port),
    /* Loopback unless the user asked to host. There is no authentication in
       that process by design, so reaching the network is never the default
       and never silent — see the warning printed below. Putting it on the
       INTERNET is a different job again: the Docker image behind Cloudflare
       Access, in DEPLOY.md. */
    HOST: HOSTING ? "0.0.0.0" : "127.0.0.1",
    STATIC_DIR: ROOT,
    DATA_DIR,
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

/* Every address someone else could actually type. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

console.log(`
  Splitpage is running at ${url}
  ${LIBRARY ? `Documents are kept on the server, in ${DATA_DIR}` : "Documents are files you save to disk (--library keeps them on the server)"}
`);

if (HOSTING) {
  const addresses = lanAddresses();
  console.log("  Other people on your network open one of these:");
  if (addresses.length) {
    for (const address of addresses) console.log(`      http://${address}:${port}/`);
  } else {
    console.log("      (no network address found — are you connected?)");
  }
  /* Said plainly, every time, because it cannot be inferred from the URL:
     there is no password on this. On a home or office network that is the
     point; on a cafe's wifi it is a mistake, and nobody should have to read
     the source to find that out. */
  console.log(`
  Anyone who can reach that address can read and edit these scripts —
  there is no password. Fine on your own network, not on a public one.
  Close this window to stop sharing.`);
}

console.log(`
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
