#!/usr/bin/env node
/* Splitpage launcher — one command, any OS.
 *
 *   node start.mjs              serve the app and open it in your browser
 *   node start.mjs --port 9000  use a different port
 *   node start.mjs --no-open    don't launch a browser
 *   node start.mjs --data DIR   where documents are kept
 *   node start.mjs --no-update-check   skip the background update check
 *
 * FIRST RUN SETS ITSELF UP. There is nothing to configure: the first launch
 * creates the document folder, turns the document server on, registers
 * Splitpage to start with the machine, and writes what it decided to a config
 * file. Every launch after that reads those answers back, so the shortcut, the
 * boot-time start and `node start.mjs` all behave the same way.
 *
 * IT NEVER STARTS TWICE. If a Splitpage server is already listening on the
 * port — normally the one that started at boot — this opens a browser at it
 * and exits, rather than putting a second copy on a second port and splitting
 * your documents between them.
 *
 * WHY SERVE IT AT ALL, rather than just opening index.html?
 * Browsers only give a page installed-app status, a service worker (offline
 * use) and a microphone when it arrives over http(s). Opened off disk as a
 * file:// URL, Splitpage still edits and exports fine, but "Install app" and
 * Follow My Voice are both unavailable. That is the whole reason this exists.
 *
 * THE DOCUMENT SERVER IS ON BY DEFAULT, from first run: documents live in the
 * data folder and are there in any browser you open the app in. `--no-library`
 * turns it off for good (it is remembered), and then a document is an .html
 * file you save to disk — the workflow this tool started with.
 */

import { spawn } from "node:child_process";
import { constants, accessSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";
import { homedir, networkInterfaces } from "node:os";
import { writeFileSync, readFileSync } from "node:fs";
import * as autostart from "./autostart.mjs";

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
  node start.mjs --host         host a shared session others on your network
                                can open and edit
  node start.mjs --port 9000    use a different port (default 8791)
  node start.mjs --no-open      don't launch a browser
  node start.mjs --data DIR     where documents are kept
  node start.mjs --no-update-check
                                don't look for a new version in the background

First run sets everything up by itself. These change what it decided, and
each one is remembered from then on:

  node start.mjs --no-library   don't keep documents on the server; a
                                document goes back to being a file you save
  node start.mjs --library      keep documents on the server again
  node start.mjs --autostart    start Splitpage when this machine starts
  node start.mjs --no-autostart stop doing that
  node start.mjs --setup        do the first-run setup and exit, without
                                starting anything (the installer uses this)
  node start.mjs --background   serve with no browser and no banner, and do
                                nothing at all if Splitpage is already running
                                (this is what the boot-time start runs)
  node start.mjs --stop         stop the copy that is running in the background

Updates install at launch and never while the app is open (see update.mjs):
  node update.mjs   downloads one, and the next start puts it in place.
`);
  process.exit(0);
}

/* --setup is the installer's way in: do everything a first run would do, then
   stop. --background is the boot-time start: no browser, no banner, and it
   steps aside if a Splitpage is already listening. */
const SETUP_ONLY = has("--setup");
const BACKGROUND = has("--background");
const QUIET = BACKGROUND;

/* ---------- what the last run decided ----------
 *
 * Kept outside the app folder on purpose. An all-users install lands in
 * Program Files, which a normal user cannot write to, and settings that only
 * work when you install "just for me" are worse than no settings at all. This
 * is per-user by the same logic as autostart: it describes how YOU want your
 * copy to start.
 */

function configHome() {
  if (platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Splitpage");
  }
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Splitpage");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "splitpage");
}

const CONFIG_FILE = process.env.SPLITPAGE_CONFIG || join(configHome(), "config.json");

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { return null; }
}

function writeConfig(next) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch (err) {
    console.error(`  could not save settings to ${CONFIG_FILE}: ${err.message}`);
    return false;
  }
}

/* Beside the app when that folder is writable — a portable copy on a USB stick
   should keep its documents on the stick — and in the user's own data folder
   when it is not, which is what an install into Program Files gets. */
function defaultDataDir() {
  try {
    accessSync(ROOT, constants.W_OK);
    return join(ROOT, "data");
  } catch {
    return join(configHome(), "data");
  }
}

const saved = readConfig();
/* A config written by a copy that lives somewhere else describes that copy,
   not this one: a reinstall to a new folder, a portable copy moved, a second
   copy run once. Treat it as a first run and re-point everything here. */
const FIRST_RUN = !saved || saved.appDir !== ROOT;

/* Hosting is sharing, and sharing means the documents have to live somewhere
   both people can reach — so it implies the library. It is also the one answer
   that is deliberately never remembered: everything else here is a preference,
   while this one puts the library on the network with no password in front of
   it, and a setting that quietly survives into the next boot is not something
   anyone should be able to turn on by accident. */
const HOSTING = has("--host");
/* What the user has asked for in general, which is what gets remembered... */
const LIBRARY_PREF = has("--no-library") ? false
  : has("--library") ? true
  : (FIRST_RUN ? true : saved.library !== false);
/* ...and what this run actually does: sharing has to have somewhere shared to
   put the documents, so --host switches the library on for this run without
   changing the answer that is stored. */
const LIBRARY = HOSTING || LIBRARY_PREF;
/* An installed copy lives somewhere the user does not browse, so documents
   should be able to live somewhere they do. */
const DATA_DIR = valueOf("--data", (!FIRST_RUN && saved.dataDir) || defaultDataDir());
const WANTED_PORT = Number(valueOf("--port", (!FIRST_RUN && saved.port) || 8791));
if (!Number.isInteger(WANTED_PORT) || WANTED_PORT < 1 || WANTED_PORT > 65535) {
  console.error("--port must be a number between 1 and 65535");
  process.exit(1);
}

/* ---------- first run: set the server up ----------
 *
 * The whole of it: make the folder documents live in, decide that they live
 * there, and ask the OS to start Splitpage from now on. It happens once,
 * without asking, because every answer is reversible with one flag and a
 * wizard nobody reads is not a feature.
 */

function setUpAutostart(wanted) {
  if (!wanted) {
    const off = autostart.disable({ onlyIfPointsAt: ROOT });
    if (!off.ok && off.error) console.error(`  could not remove the boot-time start: ${off.error}`);
    return { enabled: false, where: off.where };
  }
  const on = autostart.enable({ root: ROOT, node: process.execPath });
  if (!on.ok) {
    /* Not fatal, and never silent: everything else about this launch works. */
    console.error(`  could not set Splitpage to start with this machine: ${on.error}`);
    return { enabled: false, where: on.where };
  }
  return { enabled: true, where: on.where };
}

/* --autostart / --no-autostart on any later run mean "change it and remember",
   so the setting can be undone without reinstalling. */
function wantsAutostart() {
  if (has("--no-autostart")) return false;
  if (has("--autostart")) return true;
  if (FIRST_RUN) return true;
  return saved.autostart !== false;
}

const wantAuto = wantsAutostart();
/* Only ever touched when this run has something to say about it: the first
   run, or one of the two flags. Re-asserting it on every launch would put the
   entry back every time somebody removed it by hand, which is not a setting,
   it is an argument. */
const auto = (FIRST_RUN || has("--autostart") || has("--no-autostart"))
  ? setUpAutostart(wantAuto)
  : { enabled: wantAuto, where: autostart.location().where };

try {
  if (LIBRARY) mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error(`  could not create the documents folder ${DATA_DIR}: ${err.message}`);
  process.exit(1);
}

writeConfig({
  ...(saved || {}),
  appDir: ROOT,
  dataDir: DATA_DIR,
  port: WANTED_PORT,
  library: LIBRARY_PREF,
  autostart: auto.enabled,
  setupAt: (!FIRST_RUN && saved.setupAt) || new Date().toISOString()
});

if (FIRST_RUN && !QUIET) {
  console.log(`
  Setting Splitpage up — this happens once.

    Documents      ${LIBRARY ? DATA_DIR : "saved to disk yourself (--no-library)"}
    Address        http://localhost:${WANTED_PORT}/
    At startup     ${auto.enabled ? "Splitpage starts with this machine" : "not started automatically"}
    Settings       ${CONFIG_FILE}
`);
}

if (SETUP_ONLY) {
  if (!QUIET && !FIRST_RUN) console.log(`  Splitpage is set up. Settings are in ${CONFIG_FILE}`);
  process.exit(0);
}

/* ---------- one Splitpage, not four ----------
 *
 * With a copy started at boot, the desktop shortcut is no longer "start the
 * app" but "show me the app". Starting a second server would work, quietly, on
 * the next port up — and the documents you saved this morning would be missing
 * from it. So: if ours is already answering on that port, hand the browser to
 * it and get out of the way.
 */

/* Written while a server of ours is up, so a later launch can not only see
   that one is running but stop it. Kept beside the settings rather than in the
   app folder, for the same reason: Program Files is not writable. */
const INSTANCE_FILE = join(dirname(CONFIG_FILE), "instance.json");

function readInstance() {
  try { return JSON.parse(readFileSync(INSTANCE_FILE, "utf8")); } catch { return null; }
}

async function findRunning(p) {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/index.html`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000)
    });
    /* Only ever ours. Something else on 8791 is somebody else's server, and
       pointing a browser at it would be worse than starting beside it. */
    if (!res.ok || !res.headers.get("x-splitpage")) return null;
    const bind = res.headers.get("x-splitpage-bind") || "127.0.0.1";
    const record = readInstance();
    return {
      port: p,
      hosting: bind !== "127.0.0.1" && bind !== "localhost",
      /* Only trust the record if it is about this port — a stale one from a
         run on another port must never send a kill to whatever pid it names. */
      pids: record && record.port === p ? [record.serverPid, record.pid].filter(Boolean) : []
    };
  } catch {
    return null;
  }
}

/* Stop a running copy of ours: the server first, which makes the launcher
   above it exit on its own, and the console window (or the hidden wscript)
   with it. */
async function stopRunning(instance) {
  for (const pid of instance.pids) {
    try { process.kill(pid); } catch { /* already gone, or not ours to kill */ }
  }
  for (let i = 0; i < 40; i++) {
    if (!(await findRunning(instance.port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (has("--stop")) {
  const instance = await findRunning(WANTED_PORT);
  if (!instance) {
    console.log(`  Nothing of ours is running on port ${WANTED_PORT}.`);
    process.exit(0);
  }
  if (!instance.pids.length) {
    console.error(`
  Splitpage is running on port ${WANTED_PORT}, but this copy did not start it
  and has no record of which process it is. Close its window to stop it.
`);
    process.exit(1);
  }
  const stopped = await stopRunning(instance);
  console.log(stopped ? "  Stopped." : `  It is still answering on port ${WANTED_PORT} — close its window.`);
  process.exit(stopped ? 0 : 1);
}

/* Handed to the OS opener as a single argument and never through a shell,
   so the URL cannot be reinterpreted as anything else. */
function openBrowser(url) {
  const opener =
    platform === "win32" ? { cmd: "cmd", args: ["/c", "start", "", url] }
    : platform === "darwin" ? { cmd: "open", args: [url] }
    : { cmd: "xdg-open", args: [url] };
  const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`  (Could not open a browser — go to ${url} yourself.)`));
  child.unref();
}

let running = await findRunning(WANTED_PORT);

/* Asking to share when a private copy holds the port is the one case where
   "it is already running" is the wrong answer: that copy is bound to loopback
   and nobody else can reach it. Take the port over — it is ours, it has the
   same documents behind it, and leaving both up would put the shared library
   behind two processes writing the same files. */
if (running && HOSTING && !running.hosting && running.pids.length) {
  console.log("  Stopping the private copy so this window can share the address.");
  if (!(await stopRunning(running))) {
    console.error(`
  It would not stop. Close the other Splitpage window, then try again.
`);
    process.exit(1);
  }
  running = null;
}

if (running) {
  const url = `http://localhost:${running.port}/`;
  if (!QUIET) {
    console.log(`
  Splitpage is already running at ${url} — opening it.
`);
    /* A staged update is deliberately NOT installed here: those files are open
       in the running server. It goes in the next time the machine starts. */
    try {
      const { pending } = await import("./update.mjs");
      const waiting = pending();
      if (waiting) console.log(`  Version ${waiting.version} is downloaded — it installs the next time this machine starts.\n`);
    } catch { /* a release without the updater */ }
    if (!has("--no-open")) openBrowser(url);
  }
  /* Exit 0, not an error: being already up is the good outcome. */
  process.exit(0);
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
if (port !== WANTED_PORT && !QUIET) {
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

/* Now that there is definitely something listening, leave the note that lets
   the next launch find it — and `--stop` end it. Both pids: the server is what
   has to die, this process is what would otherwise be left holding a dead
   child. */
try {
  writeFileSync(INSTANCE_FILE, JSON.stringify({
    pid: process.pid,
    serverPid: server.pid,
    port,
    hosting: HOSTING,
    dataDir: LIBRARY ? DATA_DIR : null,
    appDir: ROOT,
    startedAt: new Date().toISOString()
  }, null, 2) + "\n");
} catch { /* not being able to write it costs a --stop, not the app */ }

function forgetInstance() {
  /* Only ever our own note: a crash-left file from another run is that run's
     to clean up, and removing it would strand a server that is still up. */
  try {
    const record = readInstance();
    if (record && record.pid === process.pid) rmSync(INSTANCE_FILE, { force: true });
  } catch { /* gone already */ }
}
process.on("exit", forgetInstance);

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

if (QUIET) {
  /* The boot-time start has no window to read, but somebody running
     --background by hand should still get one line saying it worked. */
  console.log(`Splitpage is serving ${url} in the background.`);
}

if (!QUIET) console.log(`
  Splitpage is running at ${url}
  ${LIBRARY ? `Documents are kept on the server, in ${DATA_DIR}` : "Documents are files you save to disk (--library keeps them on the server)"}
`);

if (HOSTING && !QUIET) {
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

if (!QUIET) console.log(`
  In Chrome or Edge, use the install icon in the address bar to add it as
  its own app window. Leave this window open while you work; Ctrl+C stops it.
`);

if (!has("--no-open") && !BACKGROUND) openBrowser(url);

/* Ctrl+C should stop the server too, not orphan it. */
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.kill(); forgetInstance(); process.exit(0); });
}
