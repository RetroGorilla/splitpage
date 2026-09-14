/* Splitpage desktop — Electron main process.
 *
 * Turns "a local server you open in the browser" into a standalone app: its
 * own window, native menus, native dialogs, file associations. The document
 * server keeps existing exactly as-is (server/server.js, untouched) — this
 * process only decides when to run it and how the window talks to it.
 *
 * ORIGIN STABILITY IS THE WHOLE POINT of loading the app from a privileged
 * custom scheme rather than http://localhost:<port>/. localStorage,
 * IndexedDB and every "remembered file handle" the page keeps are keyed by
 * origin; if that origin were the launcher's port, it would change every
 * time the port did (another instance already listening, a busy port, a
 * user picking --port). splitpage://app never changes, so version history
 * and local settings survive across launches no matter what the server is
 * doing underneath. See "THE DESKTOP BRIDGE CONTRACT" in the handoff notes.
 *
 * CommonJS throughout, per house style for the Electron main process (the
 * renderer/src/js house style is plain ES5-ish browser JS; this file is not
 * that — it runs in Node, under contextIsolation, with a bridge to the page).
 */

"use strict";

const {
  app, BrowserWindow, Menu, protocol, net, ipcMain, dialog, shell,
  utilityProcess, session, nativeTheme, screen
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const os = require("node:os");
const net_ = require("node:net");
const { spawn } = require("node:child_process");

/* ---------------------------------------------------------------------
 * 0. The privileged scheme. Must be registered before `app` is ready —
 *    Electron reads this table once, at startup.
 * --------------------------------------------------------------------- */

protocol.registerSchemesAsPrivileged([
  {
    scheme: "splitpage",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true
    }
  }
]);

/* ---------------------------------------------------------------------
 * 1. Test/isolation hooks (env-gated; inert unless set). Must run before
 *    app.whenReady() reads any paths.
 * --------------------------------------------------------------------- */

if (process.env.SPLITPAGE_USER_DATA) {
  app.setPath("userData", process.env.SPLITPAGE_USER_DATA);
}

/* SPLITPAGE_TEST_DIALOGS points at a JSON file: an array of answers consumed
   IN ORDER by every dialog this process would otherwise show natively —
   openFileDialog, saveFileDialog, the unsaved-changes prompt and the
   stop-sharing prompt, in whichever order the test actually triggers them.
   One shared cursor, not one array per dialog kind: that is what lets a test
   script narrate a sequence ("open this file, then try to close with unsaved
   work and choose Stay") without knowing which internal dialog call maps to
   which array slot. */
let testDialogAnswers = null;
let testDialogCursor = 0;
if (process.env.SPLITPAGE_TEST_DIALOGS) {
  try {
    testDialogAnswers = JSON.parse(fs.readFileSync(process.env.SPLITPAGE_TEST_DIALOGS, "utf8"));
    if (!Array.isArray(testDialogAnswers)) testDialogAnswers = null;
  } catch {
    testDialogAnswers = null;
  }
}
function consumeTestDialogAnswer() {
  if (!testDialogAnswers || testDialogCursor >= testDialogAnswers.length) return undefined;
  return testDialogAnswers[testDialogCursor++];
}

const SKIP_UPDATE_CHECK = process.env.SPLITPAGE_NO_UPDATE_CHECK === "1";

/* SPLITPAGE_TEST=1 marks an automated run (desktop/test/smoke.mjs). Such a
   run must never put anything on the screen of the person whose machine it
   is: the window is never shown and stays off the taskbar (createWindow),
   any dialog a test did not pre-answer through SPLITPAGE_TEST_DIALOGS
   resolves as Cancel instead of appearing, and an uncaught main-process
   error exits with its stack on stderr instead of raising Electron's modal
   error box. That box blocks the main thread — which is how a crash on
   window close once passed for "the debug port goes dead on the first
   close" while popping error dialogs on Adam's desktop every test run. */
const TEST_MODE = process.env.SPLITPAGE_TEST === "1";
if (TEST_MODE) {
  /* uncaughtException/unhandledRejection are registered further down (see
     the "winning instance" block below), not here — the crash handler needs
     to call killDocumentServer()/killTunnel() before exiting, and those are
     declared inside that block. Registering the listener early would just
     mean a crash before that point throws ReferenceError trying to reach
     them; nothing meaningful can crash that early anyway. */

  /* Every dialog call site passes (win, opts) or (opts); the answer is the
     dialog's own cancelId, i.e. exactly what pressing Esc would have done. */
  const cancelIndex = (opts) => (opts && typeof opts.cancelId === "number")
    ? opts.cancelId
    : Math.max(0, ((opts && opts.buttons) || ["OK"]).length - 1);
  const optsOf = (args) => args[args.length - 1];
  dialog.showMessageBoxSync = (...args) => cancelIndex(optsOf(args));
  dialog.showMessageBox = async (...args) => ({ response: cancelIndex(optsOf(args)), checkboxChecked: false });
  dialog.showOpenDialogSync = () => undefined;
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showSaveDialogSync = () => undefined;
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  dialog.showErrorBox = (title, content) => console.error("[splitpage-test] error box: " + title + " — " + content);
}

/* ---------------------------------------------------------------------
 * 2. Where the app's files live.
 *
 *    Dev: straight off the repo root (this file is desktop/main.js, so
 *    APP_ROOT is one level up). Packaged: the staged copy under
 *    resources/splitpage (stage.mjs, written by another agent, is what
 *    puts it there — this file only ever reads the constant).
 * --------------------------------------------------------------------- */

const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "splitpage")
  : path.resolve(__dirname, "..");

/* Only these get served from "/" other than index.html. Anything else is a
   404, and traversal is impossible by construction: the request path is
   matched against this fixed table, never used to build a filesystem path. */
const STATIC_ALLOWLIST = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/README.md": { file: "README.md", type: "text/markdown; charset=utf-8" },
  "/VERSION": { file: "VERSION", type: "text/plain; charset=utf-8" }
};

/* ---------------------------------------------------------------------
 * 3. Argument parsing — mirrors start.mjs's own flag reading so the two
 *    stay easy to compare. Electron's argv shape differs from a plain
 *    Node script's: in dev (`electron .`) argv is
 *    [electronExe, appPath, ...ours]; packaged, it is [exe, ...ours].
 *    Anything Chromium/Electron itself recognises (--remote-debugging-port,
 *    --enable-logging, …) just falls through here unrecognised and is
 *    ignored, exactly as asked — we never error on an unknown flag.
 * --------------------------------------------------------------------- */

const rawArgv = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);

function argHas(list, flag) { return list.includes(flag); }
function argValueOf(list, flag, fallback) {
  const i = list.indexOf(flag);
  return i === -1 || i === list.length - 1 ? fallback : list[i + 1];
}
function argValuesOf(list, flag) {
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    if (list[i] === flag && list[i + 1] && !list[i + 1].startsWith("--")) out.push(list[i + 1].trim());
  }
  return out;
}

const OPENABLE_EXTENSIONS = [".splitpage", ".md", ".html", ".htm", ".docx", ".txt", ".csv"];
/* `baseDir` matters: a relative path in argv must resolve against the
   directory the LAUNCHING process was actually run from, not against
   process.cwd() of whichever process happens to be executing this function.
   That distinction is invisible for the initial launch (its own argv is
   naturally relative to its own cwd) but very much not for 'second-instance'
   below, where Electron hands the FIRST (already-running) process the
   SECOND process's argv — resolving those against the first process's own
   cwd silently drops any relative path the second launch gave it. */
function filesToOpenFrom(list, baseDir) {
  const out = [];
  for (const item of list) {
    if (item.startsWith("-")) continue;
    const ext = path.extname(item).toLowerCase();
    if (!OPENABLE_EXTENSIONS.includes(ext)) continue;
    try {
      const abs = path.resolve(baseDir, item);
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch { /* not a real file — ignore, don't crash on a stray argument */ }
  }
  return out;
}

const HOSTING = argHas(rawArgv, "--host");
const LIBRARY = HOSTING || argHas(rawArgv, "--library");
const WANTED_PORT = Number(argValueOf(rawArgv, "--port", 8791));
const DEFAULT_DATA_DIR = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "Splitpage", "data")
  : path.join(app.getPath("userData"), "data");
const DATA_DIR = argValueOf(rawArgv, "--data", DEFAULT_DATA_DIR);
const ALLOW_ORIGINS = argValuesOf(rawArgv, "--allow-origin").filter(Boolean);

let JOIN_PIN = "";
if (argHas(rawArgv, "--pin")) {
  const given = argValueOf(rawArgv, "--pin", "");
  JOIN_PIN = (given && !given.startsWith("--")) ? given.trim() : String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

const TUNNEL_TARGET = argHas(rawArgv, "--tunnel") ? argValueOf(rawArgv, "--tunnel", "") : null;
const TUNNEL_REMOTE_PORT = Number(argValueOf(rawArgv, "--remote-port", 8791));
const TUNNEL_LOCAL_PORT = Number(argValueOf(rawArgv, "--local-port", String(TUNNEL_REMOTE_PORT)));

const argvFilesToOpen = filesToOpenFrom(rawArgv, process.cwd());

/* ---------------------------------------------------------------------
 * 4. Single-instance lock. A second launch hands its argv to the first
 *    instance (so double-clicking another .md file focuses the existing
 *    window and opens it there) instead of starting a second server.
 * --------------------------------------------------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {

/* Every module-level `const`/`let` from here on only runs in the winning
   instance — the losing one already called app.quit() above and everything
   past this brace is dead for it in practice (Electron tears the process
   down once app.quit() resolves), but we still avoid touching app.* before
   that quit takes effect. */

let mainWindow = null;
let documentServerChild = null;
let documentServerPort = null; // set once /api/health answers
let tunnelChild = null;
let tunnelLocalUrl = null; // set once the tunnel is up; load path bypasses the bridge entirely

/* Files handed to us by the OS — launch argv, a second instance's argv, or
   macOS 'open-file' — queue here until the renderer calls back to say its
   onOpenFile callback is registered, then flush in order. */
let pendingOpenFiles = [];
let rendererReady = false;
let readyMainWindow = null; // the webContents that signalled ready, for the flush

/* TEST_MODE's crash handler lives here (rather than up in section 1, where
   the rest of the TEST_MODE setup runs) because it must call
   killDocumentServer()/killTunnel() — both declared later in this same
   block — before exiting. Function declarations are hoisted to the top of
   their enclosing block, so the calls below are valid even though the
   functions' own text comes further down; what matters is that this
   registration happens INSIDE the block that declares them, which section 1
   (before the single-instance-lock check) is not. Without this, a crash
   under SPLITPAGE_TEST=1 in --library/--host/--tunnel mode called
   app.exit(70) directly, which Electron never routes through 'before-quit'
   — orphaning the forked document server or the spawned ssh tunnel exactly
   when "never leave processes behind" matters most (an automated test run
   that's already broken). */
if (TEST_MODE) {
  process.on("uncaughtException", (err) => {
    console.error("[splitpage-test] uncaught main-process error: " + ((err && err.stack) || err));
    killDocumentServer();
    killTunnel();
    app.exit(70);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[splitpage-test] unhandled rejection: " + ((err && err.stack) || err));
  });
}

/* id -> absolute path. The renderer only ever holds opaque ids; nothing
   sent from the page can name a path directly, and nothing outside a
   dialog pick / an OS-handed file / the persisted "last file" ever gets an
   entry here. */
const fileRegistry = new Map();
function registerPath(absPath) {
  const id = crypto.randomBytes(16).toString("hex");
  fileRegistry.set(id, absPath);
  return id;
}

/* webContents.id -> last reported `dirty` from splitpage:set-document-state.
   This is what makes the 'close' handler (below) the authority on unsaved
   changes instead of the page's own beforeunload block — see the big
   comment above that handler for why beforeunload alone isn't enough.
   Cleaned up on 'closed' so a destroyed window's id is never read stale. */
const lastDirtyByWebContents = new Map();

/* Windows whose close has already been explicitly decided (a hosting/
   unsaved-changes dialog answered "go ahead", or neither applied) — so the
   beforeunload round trip that can follow doesn't ask the same question
   twice. A plain WeakSet is enough: nothing needs to read it once GC'd. */
const closeConfirmedWindows = new WeakSet();

/* ---------------------------------------------------------------------
 * 5. desktop-state.json — last file path, window bounds + maximized.
 * --------------------------------------------------------------------- */

function stateFilePath() { return path.join(app.getPath("userData"), "desktop-state.json"); }
function readDesktopState() {
  try { return JSON.parse(fs.readFileSync(stateFilePath(), "utf8")); } catch { return {}; }
}
function writeDesktopState(patch) {
  const current = readDesktopState();
  const next = { ...current, ...patch };
  try {
    fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    fs.writeFileSync(stateFilePath(), JSON.stringify(next, null, 2));
  } catch { /* best-effort — losing window-position memory is not fatal */ }
}

/* ---------------------------------------------------------------------
 * 6. FileEntry helpers.
 *
 *    lastModified is ALWAYS an integer millisecond count (Math.floor of
 *    stat.mtimeMs) because the renderer's on-disk-conflict guard compares
 *    it with !== against the value a browser File reports, which is also
 *    always an integer. A float here reports a phantom conflict on every
 *    single save.
 * --------------------------------------------------------------------- */

async function readFileEntry(id, absPath) {
  const stat = await fsp.stat(absPath);
  const buf = await fsp.readFile(absPath);
  return {
    id,
    name: path.basename(absPath),
    lastModified: Math.floor(stat.mtimeMs),
    size: stat.size,
    bytes: new Uint8Array(buf)
  };
}

function toBuffer(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new Error("writeFile: unsupported data type");
}

/* Atomic write: a crash mid-write leaves the previous file intact rather
   than a half-written one. Same technique server.js already uses for its
   own document storage. */
async function atomicWrite(absPath, buffer) {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  await fsp.writeFile(tmp, buffer);
  try {
    await fsp.rename(tmp, absPath);
  } catch (err) {
    /* A rename can fail on Windows even after the temp file was written
       cleanly — e.g. the destination is transiently locked by an antivirus
       scan or a sync client. Leaving the temp file behind in that case
       means a stray `.<name>.tmp-xxxx` sits next to the user's document
       forever with no indication it's there; best-effort clean it up before
       surfacing the original error so the renderer's save still fails
       loudly (it must — the user's edit was NOT saved). */
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/* ---------------------------------------------------------------------
 * 7. The document server (--library / --host).
 * --------------------------------------------------------------------- */

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = net_.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

async function findFreePort(wanted, host) {
  let port = wanted;
  for (let i = 0; i < 20 && !(await isPortFree(port, host)); i++) port++;
  if (!(await isPortFree(port, host))) return null;
  return port;
}

async function waitForHealth(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await net.fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startDocumentServer() {
  const host = HOSTING ? "0.0.0.0" : "127.0.0.1";
  const port = await findFreePort(WANTED_PORT, host);
  if (port == null) {
    dialog.showErrorBox("Splitpage", `Ports ${WANTED_PORT}-${WANTED_PORT + 20} are all busy. Try --port with something else.`);
    return false;
  }
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {});

  documentServerChild = utilityProcess.fork(path.join(APP_ROOT, "server", "server.js"), [], {
    cwd: APP_ROOT,
    stdio: "pipe",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      STATIC_DIR: APP_ROOT,
      DATA_DIR,
      NO_API: "0",
      JOIN_PIN,
      ALLOW_ORIGINS: ALLOW_ORIGINS.join(","),
      /* The Start-Menu launcher's loopback-only install routes have no
         meaning inside the desktop app — there is no Start Menu entry for
         this process to install itself as. Leaving this empty disables
         those routes entirely (server.js treats a blank LAUNCH_TOKEN as
         "the launcher routes do not exist"). */
      LAUNCH_TOKEN: ""
    }
  });
  if (documentServerChild.stdout) documentServerChild.stdout.on("data", (d) => process.stdout.write(`[doc-server] ${d}`));
  if (documentServerChild.stderr) documentServerChild.stderr.on("data", (d) => process.stderr.write(`[doc-server] ${d}`));

  const healthy = await waitForHealth(port);
  if (!healthy) {
    dialog.showErrorBox("Splitpage", "The document server did not start. Check the console for details.");
    try { documentServerChild.kill(); } catch {}
    documentServerChild = null;
    return false;
  }
  documentServerPort = port;
  return true;
}

function killDocumentServer() {
  if (documentServerChild) {
    try { documentServerChild.kill(); } catch {}
    documentServerChild = null;
    documentServerPort = null;
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net_addr of list || []) {
      if (net_addr.family === "IPv4" && !net_addr.internal) out.push(net_addr.address);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------
 * 8. --tunnel: join someone else's server over SSH. No console exists for
 *    a password prompt in a windowed app, so BatchMode=yes fails fast
 *    instead of hanging, and we show a native dialog explaining why.
 * --------------------------------------------------------------------- */

async function waitForLocalPort(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const socket = net_.connect({ port, host: "127.0.0.1" });
      const done = (v) => { socket.destroy(); resolve(v); };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function startTunnel() {
  const forward = `${TUNNEL_LOCAL_PORT}:localhost:${TUNNEL_REMOTE_PORT}`;
  tunnelChild = spawn("ssh", [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-L", forward,
    TUNNEL_TARGET
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let sshOutput = "";
  tunnelChild.stdout.on("data", (d) => { sshOutput += d; });
  tunnelChild.stderr.on("data", (d) => { sshOutput += d; });

  const exitedEarly = new Promise((resolve) => {
    tunnelChild.once("exit", (code) => resolve(code));
    tunnelChild.once("error", (err) => resolve(err));
  });

  const ready = await Promise.race([
    waitForLocalPort(TUNNEL_LOCAL_PORT).then((ok) => (ok ? "ready" : "timeout")),
    exitedEarly.then(() => "exited")
  ]);

  if (ready !== "ready") {
    const reason = ready === "exited"
      ? "The SSH connection closed before the tunnel came up. Key-based login is required — this window has no password prompt for you to answer, so BatchMode is on and a login that needs a password or passphrase fails immediately. Make sure your key is loaded in an agent (ssh-add) and that the host accepts it."
      : `The tunnel did not come up on port ${TUNNEL_LOCAL_PORT} within a minute. Check that ${TUNNEL_TARGET} is reachable and that nothing else is using that local port.`;
    dialog.showErrorBox("Splitpage — could not reach that server", `${reason}\n\n${sshOutput.trim()}`);
    try { tunnelChild.kill(); } catch {}
    tunnelChild = null;
    return false;
  }

  tunnelLocalUrl = `http://localhost:${TUNNEL_LOCAL_PORT}/`;
  return true;
}

function killTunnel() {
  if (tunnelChild) {
    try { tunnelChild.kill(); } catch {}
    tunnelChild = null;
  }
}

/* ---------------------------------------------------------------------
 * 9. Update check. Never auto-downloads anything — the same "a file the
 *    page reads" design as start.mjs's update-status.json, just built in
 *    memory here instead of written to disk (there is no reason for a
 *    desktop build to keep a JSON file next to the app for this).
 * --------------------------------------------------------------------- */

function readAppVersion() {
  try { return fs.readFileSync(path.join(APP_ROOT, "VERSION"), "utf8").trim(); } catch { return app.getVersion(); }
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

let updateStatus = {
  version: readAppVersion(),
  checkedAt: new Date().toISOString(),
  latest: null,
  updateAvailable: false,
  pending: null,
  justUpdated: null,
  desktop: true,
  releaseUrl: null
};

async function checkForUpdate() {
  if (SKIP_UPDATE_CHECK) return;
  const current = readAppVersion();
  const apiUrl = process.env.SPLITPAGE_UPDATE_API
    || "https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest";
  try {
    const res = await net.fetch(apiUrl, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-desktop" }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.json();
    const latest = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
    updateStatus = {
      ...updateStatus,
      version: current,
      checkedAt: new Date().toISOString(),
      latest,
      updateAvailable: !!latest && compareVersions(latest, current) > 0,
      releaseUrl: body.html_url || null,
      error: undefined
    };
  } catch (err) {
    updateStatus = {
      ...updateStatus,
      version: current,
      checkedAt: new Date().toISOString(),
      error: err.message
    };
  }
}

/* ---------------------------------------------------------------------
 * 10. protocol.handle — the whole of what the window is allowed to load.
 * --------------------------------------------------------------------- */

function contentTypeFor(ext) {
  const table = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
  };
  return table[ext] || "application/octet-stream";
}

function registerProtocol() {
  protocol.handle("splitpage", async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return new Response("bad url", { status: 400 }); }
    const pathname = decodeURIComponent(url.pathname);

    /* --- /api/* : proxy to the document server, or 404 if none is running.
       The client's own /api/health probe then fails exactly like NO_API=1
       does today, and the page quietly stays in local mode. */
    if (pathname.startsWith("/api/")) {
      if (!documentServerPort) {
        return new Response(JSON.stringify({ error: "no server" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      const target = `http://127.0.0.1:${documentServerPort}${pathname}${url.search}`;
      const headers = new Headers(request.headers);
      headers.delete("origin");
      headers.delete("host");
      headers.delete("referer");
      const init = { method: request.method, headers, redirect: "manual" };
      if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
        init.body = request.body;
        init.duplex = "half";
      }
      try {
        return await net.fetch(target, init);
      } catch {
        return new Response(JSON.stringify({ error: "no server" }), {
          status: 502,
          headers: { "content-type": "application/json" }
        });
      }
    }

    /* --- /update-status.json : always from memory, never from disk. */
    if (pathname === "/update-status.json") {
      return new Response(JSON.stringify(updateStatus), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    /* --- / and the static allowlist. */
    const key = pathname === "/" ? "/index.html" : pathname;
    const entry = STATIC_ALLOWLIST[key];
    if (!entry) return new Response("not found", { status: 404 });

    const absPath = path.join(APP_ROOT, entry.file);
    /* Belt-and-suspenders: even though `entry.file` is a fixed literal from
       the table above and can never contain "..", confirm the resolved path
       is still inside APP_ROOT before reading it. */
    if (!absPath.startsWith(APP_ROOT)) return new Response("not found", { status: 404 });
    try {
      const buf = await fsp.readFile(absPath);
      return new Response(buf, { status: 200, headers: { "content-type": entry.type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

/* ---------------------------------------------------------------------
 * 11. The window.
 * --------------------------------------------------------------------- */

function backgroundColorForTheme() {
  return nativeTheme.shouldUseDarkColors ? "#16130F" : "#F6F4EC";
}

function savedBoundsIfVisible() {
  const state = readDesktopState();
  const b = state.windowBounds;
  if (!b || typeof b.x !== "number") return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
           b.y < wa.y + wa.height && b.y + b.height > wa.y;
  });
  return onScreen ? b : null;
}

function createWindow() {
  const saved = savedBoundsIfVisible();
  const iconPath = app.isPackaged ? undefined : path.join(APP_ROOT, "installer", "icon.ico");

  const win = new BrowserWindow({
    width: saved ? saved.width : 1400,
    height: saved ? saved.height : 900,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: backgroundColorForTheme(),
    show: false,
    /* test runs stay invisible: see TEST_MODE */
    skipTaskbar: TEST_MODE,
    title: "Splitpage",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      /* a window that is never shown would otherwise have its timers and
         rAF throttled like a background tab, and the tests drive it live */
      backgroundThrottling: !TEST_MODE
    }
  });

  /* maximize() also SHOWS a hidden window, so it is skipped in test runs */
  if (readDesktopState().windowMaximized && saved && !TEST_MODE) win.maximize();

  win.once("ready-to-show", () => { if (!TEST_MODE) win.show(); });

  const target = tunnelLocalUrl || "splitpage://app/index.html";
  win.loadURL(target);

  /* --- external links / new windows: hand off to the OS browser, never
     open a second Electron window. --- */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  /* --- navigation allowlist: only our own origin (or, in tunnel mode, the
     tunnelled localhost origin) may navigate the window itself. --- */
  win.webContents.on("will-navigate", (event, url) => {
    const allowedPrefix = tunnelLocalUrl
      ? `http://localhost:${TUNNEL_LOCAL_PORT}/`
      : "splitpage://app/";
    if (url.startsWith(allowedPrefix)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  /* --- unsaved changes: THE MAIN PROCESS IS THE SOLE AUTHORITY, not the
     page's own beforeunload handler (src/js/21-events.js). Chromium only
     honours a beforeunload block after the page has had USER ACTIVATION —
     a click, a keypress — in this session. A document that became dirty
     with no gesture at all (applyStashedWork merging a stash at load, a
     resumed/merged project, an OS-opened file the app marks dirty on open)
     never gets that activation, so relying on 'will-prevent-unload' below
     meant such a window closed SILENTLY, with no prompt, losing the work.
     The 'close' handler beneath fixes that: it asks lastDirtyByWebContents
     (kept current by the splitpage:set-document-state IPC handler, which
     fires on every markDirty()/clearDirty() call — see setSaveButtons() in
     src/js/12-dirty-toast.js, invariant #20) directly, before Chromium's
     own beforeunload negotiation ever runs, so the answer no longer depends
     on whether a gesture happened to occur. 'will-prevent-unload' stays
     below as a narrower safety net for reload/navigation (where 'close'
     never fires at all) and for the rare case its own dirty report hasn't
     reached main yet; closeConfirmedWindows keeps it from asking the SAME
     question a second time right after 'close' already got an answer. --- */
  win.webContents.on("will-prevent-unload", (event) => {
    if (closeConfirmedWindows.has(win)) { event.preventDefault(); return; }
    const answer = consumeTestDialogAnswer();
    let leave;
    if (answer === "confirm") leave = true;
    else if (answer === "cancel") leave = false;
    else {
      const choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Leave without saving", "Stay"],
        defaultId: 1,
        cancelId: 1,
        title: "Splitpage",
        message: "You have unsaved changes",
        detail: "If you leave now, your changes will be lost."
      });
      leave = choice === 0;
    }
    if (leave) event.preventDefault();
  });

  /* --- close: one decision per applicable condition, asked here rather
     than left to fire-if-Chromium-feels-like-it beforeunload semantics.
     Hosting is checked first (unrelated to dirty state — closing while
     hosting ends the session for everyone connected, dirty document or
     not), then unsaved changes, each only if the prior one didn't already
     cancel the close. Once every applicable question has been answered
     "go ahead", closeConfirmedWindows records that so the beforeunload
     round trip which follows (see 'will-prevent-unload' above) — if the
     page happens to have activation and tries to block again — doesn't ask
     either question a second time. --- */
  win.on("close", (event) => {
    if (closeConfirmedWindows.has(win)) return; // already decided this attempt

    if (HOSTING) {
      const answer = consumeTestDialogAnswer();
      let stop;
      if (answer === "confirm") stop = true;
      else if (answer === "cancel") stop = false;
      else {
        const choice = dialog.showMessageBoxSync(win, {
          type: "warning",
          buttons: ["Stop sharing and close", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: "Splitpage",
          message: "Closing Splitpage stops the shared session — anyone connected loses access."
        });
        stop = choice === 0;
      }
      if (!stop) { event.preventDefault(); return; }
    }

    if (lastDirtyByWebContents.get(win.webContents.id)) {
      const answer = consumeTestDialogAnswer();
      let leave;
      if (answer === "confirm") leave = true;
      else if (answer === "cancel") leave = false;
      else {
        const choice = dialog.showMessageBoxSync(win, {
          type: "warning",
          buttons: ["Leave without saving", "Stay"],
          defaultId: 1,
          cancelId: 1,
          title: "Splitpage",
          message: "You have unsaved changes",
          detail: "If you leave now, your changes will be lost."
        });
        leave = choice === 0;
      }
      if (!leave) { event.preventDefault(); return; }
    }

    closeConfirmedWindows.add(win);
  });

  /* --- 'will-download' fallback. The renderer routes every export through
     the bridge's saveFileDialog/writeFile; this only catches a stray
     download Electron itself decides to start (e.g. a data: URL it treats
     as a download instead of navigation), and just lets its native save
     dialog handle it rather than doing nothing. --- */
  win.webContents.session.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
  });

  let boundsSaveTimer = null;
  function scheduleBoundsSave() {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      writeDesktopState({
        windowBounds: win.isMaximized() ? readDesktopState().windowBounds : win.getBounds(),
        windowMaximized: win.isMaximized()
      });
    }, 400);
  }
  win.on("resize", scheduleBoundsSave);
  win.on("move", scheduleBoundsSave);
  win.on("maximize", () => writeDesktopState({ windowMaximized: true }));
  win.on("unmaximize", () => writeDesktopState({ windowMaximized: false, windowBounds: win.getBounds() }));

  /* Captured now, while the window is alive: by the time 'closed' fires the
     BrowserWindow is destroyed, and even reading win.webContents from it
     throws "Object has been destroyed" — an uncaught main-process error
     dialog on every close. `contentsId` is captured as a plain number for
     the same reason — `contents.id` itself is a getter backed by the native
     object, so reading it AFTER destruction is exactly as unsafe as reading
     win.webContents would be; only a value already pulled out while alive
     is safe to use inside 'closed'. */
  const contents = win.webContents;
  const contentsId = contents.id;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    if (readyMainWindow === contents) { readyMainWindow = null; rendererReady = false; }
    lastDirtyByWebContents.delete(contentsId);
  });

  return win;
}

/* ---------------------------------------------------------------------
 * 12. Open-file queueing.
 * --------------------------------------------------------------------- */

function queueOpenFile(absPath) {
  let id;
  try {
    if (!fs.statSync(absPath).isFile()) return;
    id = registerPath(absPath);
  } catch { return; }
  pendingOpenFiles.push({ id, absPath });
  flushOpenFiles();
}

function flushOpenFiles() {
  if (!rendererReady || !readyMainWindow || readyMainWindow.isDestroyed()) return;
  while (pendingOpenFiles.length) {
    const { id, absPath } = pendingOpenFiles.shift();
    readFileEntry(id, absPath).then((entry) => {
      readyMainWindow.send("splitpage:open-file", entry);
    }).catch(() => { /* file vanished between queueing and flush */ });
  }
}

function focusMainWindow() {
  if (!mainWindow || TEST_MODE) return; /* restore()/show() would surface a test window */
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------------------------------------------------------------------
 * 13. Native menu.
 *
 *    ACCELERATORS: grepped src/js for keydown handling before assigning
 *    any of these. The page intercepts exactly one shortcut that overlaps
 *    a menu command — Ctrl/Cmd+F for Find & replace (src/js/21-events.js,
 *    the window "keydown" listener around line 691). That item's
 *    accelerator is set for display only (registerAccelerator: false) so
 *    the keystroke still reaches the page's own handler instead of being
 *    swallowed here. Ctrl+B/I/U and Ctrl+Enter/Alt+Enter are also
 *    page-handled but aren't menu commands at all, so they don't come up.
 *    Everything else below — Save, Save As, Open, undo/redo/cut/copy/paste
 *    roles, zoom, fullscreen — has no page-level listener, so real
 *    accelerators are safe to register normally.
 * --------------------------------------------------------------------- */

function sendMenuCommand(command) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send("splitpage:menu-command", command);
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const exportSubmenu = [
    { label: "Word (.docx)", click: () => sendMenuCommand("export-docx") },
    { label: "Markdown (.md)", click: () => sendMenuCommand("export-md") },
    { label: "Markdown, two columns (.md)", click: () => sendMenuCommand("export-md-table") },
    { label: "Spreadsheet (.csv)", click: () => sendMenuCommand("export-csv") },
    { label: "Breakdown only (.csv)", click: () => sendMenuCommand("export-breakdown") },
    { label: "PDF (.pdf)", click: () => sendMenuCommand("export-pdf") },
    { type: "separator" },
    { label: "Standalone HTML (.html)", click: () => sendMenuCommand("export-html") },
    { type: "separator" },
    { label: "Narration only (.docx)", click: () => sendMenuCommand("export-narration-docx") },
    { label: "Narration only (.txt)", click: () => sendMenuCommand("export-narration-txt") },
    { type: "separator" },
    { label: "Gear (.pdf)", click: () => sendMenuCommand("export-packing-gear") },
    { label: "Props (.pdf)", click: () => sendMenuCommand("export-packing-prop") }
  ];

  const fileMenu = {
    label: "File",
    submenu: [
      { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenuCommand("save") },
      { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenuCommand("save-as") },
      { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => sendMenuCommand("open") },
      { label: "Save to file", id: "menu-save-back", click: () => sendMenuCommand("save-back") },
      { type: "separator" },
      { label: "Paste a script…", click: () => sendMenuCommand("paste") },
      { label: "Import from Google Doc link…", click: () => sendMenuCommand("gdoc-import") },
      { label: "Google Drive files…", click: () => sendMenuCommand("drive-open") },
      { label: "Open from the server…", click: () => sendMenuCommand("server-open") },
      { label: "Put this script on the server", click: () => sendMenuCommand("server-publish") },
      { label: "Servers…", click: () => sendMenuCommand("servers") },
      { type: "separator" },
      { label: "Version history…", click: () => sendMenuCommand("history") },
      { type: "separator" },
      { label: "Export", submenu: exportSubmenu },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit", label: "Exit" }
    ]
  };

  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "selectAll" },
      { type: "separator" },
      /* The one page-handled shortcut among our menu commands. Accelerator
         shown for discoverability; registerAccelerator:false so the
         keystroke reaches the page's own Ctrl/Cmd+F listener instead of
         being consumed here first. */
      {
        label: "Find & replace",
        accelerator: "CmdOrCtrl+F",
        registerAccelerator: false,
        click: () => sendMenuCommand("find")
      }
    ]
  };

  const viewMenu = {
    label: "View",
    submenu: [
      { label: "Production", accelerator: "CmdOrCtrl+Alt+P", click: () => sendMenuCommand("toggle-production") },
      { label: "Gear", click: () => sendMenuCommand("toggle-gear") },
      { label: "Comments", accelerator: "CmdOrCtrl+Alt+C", click: () => sendMenuCommand("toggle-comments") },
      { label: "Write", click: () => sendMenuCommand("write") },
      { label: "Present", click: () => sendMenuCommand("present") },
      { type: "separator" },
      ...(app.isPackaged ? [] : [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" }
      ]),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" }
    ]
  };

  const helpMenu = {
    label: "Help",
    submenu: [
      { label: "User guide…", accelerator: "F1", click: () => sendMenuCommand("help") },
      { label: "Tagging reference", click: () => sendMenuCommand("tagging-help") },
      { label: "Take the tour", click: () => sendMenuCommand("tour") },
      { label: "Set up Splitpage…", click: () => sendMenuCommand("setup") },
      { type: "separator" },
      { label: "About Splitpage", click: () => sendMenuCommand("about") }
    ]
  };

  const template = isMac
    ? [{ role: "appMenu" }, fileMenu, editMenu, viewMenu, helpMenu]
    : [fileMenu, editMenu, viewMenu, helpMenu];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------------
 * 14. IPC — the bridge's other half. Every handler validates the calling
 *     frame is our own app origin (or, in tunnel mode, none of these are
 *     exposed at all — see preload.js), never trusting contextIsolation
 *     alone to have kept a compromised/tunnelled renderer out.
 * --------------------------------------------------------------------- */

function isTrustedSender(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === "string" && url.startsWith("splitpage://app/");
}

function requireTrusted(event) {
  if (!isTrustedSender(event)) throw new Error("untrusted sender");
}

function registerIpc() {
  ipcMain.handle("splitpage:open-file-dialog", async (event) => {
    requireTrusted(event);
    const answer = consumeTestDialogAnswer();
    let chosen;
    if (answer !== undefined) {
      chosen = answer; // absolute path string, or null for "cancelled"
    } else {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [
          { name: "Scripts and documents", extensions: ["splitpage", "md", "html", "htm", "docx", "txt", "csv"] }
        ]
      });
      chosen = result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    }
    if (!chosen) return null;
    const id = registerPath(chosen);
    return await readFileEntry(id, chosen);
  });

  ipcMain.handle("splitpage:save-file-dialog", async (event, options) => {
    requireTrusted(event);
    const opts = options || {};
    const answer = consumeTestDialogAnswer();
    let chosen;
    if (answer !== undefined) {
      chosen = answer;
    } else {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(win, {
        defaultPath: opts.suggestedName,
        filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : undefined
      });
      chosen = result.canceled || !result.filePath ? null : result.filePath;
    }
    if (!chosen) return null;
    const id = registerPath(chosen);
    return { id, name: path.basename(chosen) };
  });

  ipcMain.handle("splitpage:read-file", async (event, id) => {
    requireTrusted(event);
    const absPath = fileRegistry.get(id);
    if (!absPath) throw new Error("ENOENT: unknown file id");
    return await readFileEntry(id, absPath);
  });

  ipcMain.handle("splitpage:write-file", async (event, id, data) => {
    requireTrusted(event);
    const absPath = fileRegistry.get(id);
    if (!absPath) throw new Error("ENOENT: unknown file id");
    const buffer = toBuffer(data);
    await atomicWrite(absPath, buffer);
    const stat = await fsp.stat(absPath);
    return { lastModified: Math.floor(stat.mtimeMs), size: stat.size };
  });

  ipcMain.handle("splitpage:stat-file", async (event, id) => {
    requireTrusted(event);
    const absPath = fileRegistry.get(id);
    if (!absPath) throw new Error("ENOENT: unknown file id");
    try {
      const stat = await fsp.stat(absPath);
      return { lastModified: Math.floor(stat.mtimeMs), size: stat.size };
    } catch {
      return null;
    }
  });

  ipcMain.handle("splitpage:get-last-file", async (event) => {
    requireTrusted(event);
    const state = readDesktopState();
    const last = state.lastFilePath;
    if (!last) return null;
    try {
      if (!fs.statSync(last).isFile()) return null;
    } catch {
      return null;
    }
    const id = registerPath(last); // "registers a fresh id" per contract
    return await readFileEntry(id, last);
  });

  ipcMain.handle("splitpage:set-last-file", async (event, id) => {
    requireTrusted(event);
    const absPath = fileRegistry.get(id);
    if (!absPath) throw new Error("ENOENT: unknown file id");
    writeDesktopState({ lastFilePath: absPath });
  });

  ipcMain.handle("splitpage:get-session-info", async (event) => {
    requireTrusted(event);
    return {
      library: LIBRARY,
      hosting: HOSTING,
      port: documentServerPort,
      lanUrls: HOSTING && documentServerPort
        ? lanAddresses().map((addr) => `http://${addr}:${documentServerPort}/`)
        : [],
      pin: JOIN_PIN || ""
    };
  });

  /* Synchronous: preload reads this once, at load time, to build the plain
     `appVersion` string property on window.splitpageDesktop (not a
     promise — see the bridge contract). */
  ipcMain.on("splitpage:get-app-version-sync", (event) => {
    event.returnValue = isTrustedSender(event) ? app.getVersion() : null;
  });

  /* Synchronous for the same reason appVersion is: the renderer's boot
     sequence needs the answer before it decides whether to fire
     tryResumeLastProjectDesktop() (20f-desktop.js/21-events.js), and that
     decision happens well before any IPC round trip like getLastFile()
     could return. See the "boot-race-resume-vs-osfile" fix: without this,
     resuming the last-session file and opening a file the OS handed us at
     launch (a double-click) raced each other with no coordination, and
     whichever IPC round trip finished last silently won — including, worse,
     becoming the target of the next Save. argvFilesToOpen is fixed at
     module load, before any window exists, so the answer is already known
     by the time this is ever asked. */
  ipcMain.on("splitpage:has-file-to-open-sync", (event) => {
    event.returnValue = isTrustedSender(event) ? argvFilesToOpen.length > 0 : false;
  });

  ipcMain.on("splitpage:open-external", (event, url) => {
    if (!isTrustedSender(event)) return;
    if (typeof url === "string" && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });

  ipcMain.on("splitpage:set-document-state", (event, docState) => {
    if (!isTrustedSender(event)) return;
    const dirty = !!(docState && docState.dirty);
    /* Recorded regardless of window state, and BEFORE the early-return
       below — the 'close' handler (see its own comment) reads this map as
       the authority on unsaved changes instead of trusting the page's own
       beforeunload block, so it must be current the instant the page
       reports it, not only while the window title also happens to update. */
    lastDirtyByWebContents.set(event.sender.id, dirty);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const title = (docState && docState.title) || "Untitled";
    win.setTitle(dirty ? `• ${title} — Splitpage` : `${title} — Splitpage`);
    if (process.platform === "darwin") win.setDocumentEdited(dirty);
  });

  ipcMain.on("splitpage:renderer-ready", (event) => {
    if (!isTrustedSender(event)) return;
    rendererReady = true;
    readyMainWindow = event.sender;
    flushOpenFiles();
  });

  /* Synchronous, same pattern as get-app-version-sync/has-file-to-open-sync
     above: preload reads this once, at load time, to decide whether to
     expose the TEST_MODE-only __testRequestClose/__testRequestQuit hooks
     below at all. Safe to always register, unlike those two — it only ever
     answers the same TEST_MODE boolean that already governs every dialog
     in this process (see section 1), nothing a normal launch couldn't
     already infer by watching dialogs never appear. */
  ipcMain.on("splitpage:is-test-mode-sync", (event) => {
    event.returnValue = isTrustedSender(event) ? TEST_MODE : false;
  });

  if (TEST_MODE) {
    /* TEST_MODE-only bridge for desktop/test/smoke.mjs. A page-initiated
       window.close() (confirmed experimentally: fires Chromium's own
       "close this tab" path, which asks beforeunload — and, with no user
       activation, Chromium answers that on its own without ever reaching
       this process — then tears the WebContents down directly, WITHOUT
       emitting BrowserWindow's 'close' event) is a fundamentally different
       operation from a real user's close. A user only ever triggers the
       latter: the title-bar X and Alt+F4 deliver a native WM_CLOSE that
       Electron turns into NativeWindow::Close() — exactly what
       BrowserWindow#close() does — and File > Exit is app.quit()
       (test-request-quit below), which closes every window the same way
       on its way out. The app itself never calls window.close() (grep
       src/js — it doesn't exist there), so it is not a user-reachable path
       at all; a test that wants to prove "closing a dirty, never-activated
       window prompts" has to drive THIS path to be testing something a
       user can actually do. Gated on TEST_MODE at registration, not just
       inside the handler, so the channel has no listener — and therefore
       no effect — at all in a normal launch. */
    ipcMain.on("splitpage:test-request-close", (event) => {
      if (!isTrustedSender(event)) return;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.close();
    });

    /* The File > Exit path (role: "quit" below calls this same app.quit()).
       Quitting with a dirty window still has to prompt — app.quit() asks
       every open BrowserWindow to close first, which fires the same
       win.on('close') this whole fix is about. */
    ipcMain.on("splitpage:test-request-quit", (event) => {
      if (!isTrustedSender(event)) return;
      app.quit();
    });
  }
}

/* ---------------------------------------------------------------------
 * 15. App lifecycle.
 * --------------------------------------------------------------------- */

app.on("second-instance", (_event, argv, cwd) => {
  /* `cwd` is the SECOND (launching) process's real working directory —
     resolve relative paths against it, not against this (the first,
     already-running) process's own cwd. See filesToOpenFrom()'s comment. */
  const files = filesToOpenFrom(app.isPackaged ? argv.slice(1) : argv.slice(2), cwd);
  for (const f of files) queueOpenFile(f);
  focusMainWindow();
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    argvFilesToOpen.push(filePath); // startup 'open-file' arrives before whenReady on macOS
    return;
  }
  queueOpenFile(filePath);
});

app.setAppUserModelId("com.retrogorilla.splitpage");

app.whenReady().then(async () => {
  registerProtocol();
  registerIpc();
  buildMenu();

  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(backgroundColorForTheme());
    }
  });

  /* Auto-grant is scoped to OUR trusted origin ONLY — never the tunnelled
     localhost origin. --tunnel mode loads a REMOTE party's own server
     content (forwarded over ssh from a machine and server this user does
     not control); silently granting it the same clipboard-read/write and
     media access as our own app would let any script that server serves
     read whatever is on the OS clipboard or activate the camera/mic with
     zero prompt — exactly the kind of thing a normal browser always asks
     about, and the opposite of "NO bridge for that origin" (this bridge
     contract's own stated design goal for tunnel mode, which was correct at
     the JS-bridge layer but not, until this, at the OS-permission layer).
     Returning false here isn't a hard block on the feature: Electron simply
     denies rather than silently allowing, same as leaving the handler
     unset — every kind stays off for a remote origin instead of on. */
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const allowedOrigin = url.startsWith("splitpage://app/");
    const allowedKinds = ["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"];
    callback(allowedOrigin && allowedKinds.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const url = webContents.getURL();
    const allowedOrigin = url.startsWith("splitpage://app/");
    const allowedKinds = ["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"];
    return allowedOrigin && allowedKinds.includes(permission);
  });

  if (TUNNEL_TARGET) {
    const ok = await startTunnel();
    if (!ok) { app.quit(); return; }
  } else if (LIBRARY) {
    await startDocumentServer(); // failure already shown a dialog; still open the window in local mode
  }

  if (!SKIP_UPDATE_CHECK) checkForUpdate(); // deliberately not awaited — must never delay the window

  mainWindow = createWindow();

  for (const f of argvFilesToOpen) queueOpenFile(f);

  app.on("activate", () => {
    // macOS convention: closing the last window doesn't quit; re-create on dock click.
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* Kill every child process on the way out — no orphaned document server or
   ssh tunnel left running once the app quits. */
/* 'will-quit', not 'before-quit': Electron emits before-quit BEFORE it asks
   the windows to close, and a window's close handler can still cancel the
   quit (unsaved changes -> Stay, or hosting -> Cancel). Killing the children
   there meant File ▸ Exit -> Stay left the app running with its document
   server or tunnel already dead — sharing silently stopped for everyone
   connected, and the Save the user stayed for could no longer reach the
   server. will-quit only fires once every window has actually closed. */
app.on("will-quit", () => {
  killDocumentServer();
  killTunnel();
});

} // end single-instance-lock guard
