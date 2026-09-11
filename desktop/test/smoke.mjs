#!/usr/bin/env node
/* Splitpage desktop — automated smoke/integration suite.
 *
 * Drives the real Electron window over the Chrome DevTools Protocol (no
 * npm test dependencies — Node 22 built-ins only, plus the global fetch
 * and WebSocket Node ships with). See "THE DESKTOP BRIDGE CONTRACT" and
 * "TEST/ISOLATION HOOKS" in the project handoff notes for the exact shape
 * this drives against.
 *
 * Usage:
 *   node test/smoke.mjs                       # dev + both packaged unpacked exes (whichever exist)
 *   node test/smoke.mjs --exe <path to .exe>   # just that one target
 *
 * Every launch gets its own fresh temp SPLITPAGE_USER_DATA, its own free
 * --remote-debugging-port, and SPLITPAGE_NO_UPDATE_CHECK=1 unless the case
 * needs the real update check. Nothing here ever touches the developer's
 * real Splitpage profile or documents — every fixture lives under
 * os.tmpdir(), created fresh and removed at the end of the run.
 */

"use strict";

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ----------------------------------------------------------------------
 * 0. Paths, targets, small utilities.
 * -------------------------------------------------------------------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseCliArgs(argv) {
  const out = { exe: null, onlyTarget: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exe") out.exe = argv[++i];
    // Debugging-only, undocumented: restrict a default (no --exe) run to a
    // single named target (dev | packaged-x64 | packaged-arm64) without
    // having to comment code out. Not part of the public CLI contract.
    if (argv[i] === "--only-target") out.onlyTarget = argv[++i];
  }
  return out;
}

function resolveTargets(exeOverride) {
  if (exeOverride) {
    const abs = path.resolve(exeOverride);
    return [{ name: "custom:" + path.basename(abs), kind: "packaged", exe: abs }];
  }
  const targets = [];
  const devExe = path.join(DESKTOP_DIR, "node_modules", "electron", "dist", "electron.exe");
  if (fs.existsSync(devExe)) targets.push({ name: "dev", kind: "dev", exe: devExe, appPath: DESKTOP_DIR });
  const x64Exe = path.join(DESKTOP_DIR, "dist", "win-unpacked", "Splitpage.exe");
  if (fs.existsSync(x64Exe)) targets.push({ name: "packaged-x64", kind: "packaged", exe: x64Exe });
  const arm64Exe = path.join(DESKTOP_DIR, "dist", "win-arm64-unpacked", "Splitpage.exe");
  if (fs.existsSync(arm64Exe)) targets.push({ name: "packaged-arm64", kind: "packaged", exe: arm64Exe });
  return targets;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// A truly wedged TCP peer (see teardown()'s comment on the DevTools port
// going unresponsive after any window-close attempt) can leave a plain
// fetch() pending indefinitely — Node/undici has no default timeout, so
// every fetchJson call here gets an explicit bound via AbortSignal.
async function fetchJson(url, opts, timeoutMs) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs || 8000) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, headers: res.headers, body };
}

async function portClosed(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: host || "127.0.0.1" });
    const done = (closed) => { try { socket.destroy(); } catch {} resolve(closed); };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    socket.setTimeout(1500, () => done(true));
  });
}

/* ----------------------------------------------------------------------
 * 1. A tiny CDP client — one WebSocket, JSON-RPC request/response
 *    correlation by id, plus a method->listeners map for events. Works
 *    identically for a page-level target's webSocketDebuggerUrl and for
 *    the browser-level one from /json/version (Browser.close lives only
 *    on the latter).
 * -------------------------------------------------------------------- */

class CDPConn {
  constructor(wsUrl, opts) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
    this.sendTimeoutMs = (opts && opts.sendTimeoutMs) || 20000;
    this.closed = false;
  }

  async open(connectTimeoutMs) {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("CDP connect timeout after " + (connectTimeoutMs || 8000) + "ms"));
      }, connectTimeoutMs || 8000);
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = (e) => { cleanup(); reject(new Error("CDP socket error: " + (e && e.message || e))); };
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onErr);
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onErr);
    });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error("CDP " + (msg.error.message || JSON.stringify(msg.error))));
        else resolve(msg.result);
      } else if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) cbs.slice().forEach((cb) => { try { cb(msg.params); } catch {} });
      }
    });
    // Without this, a target that dies mid-request (the app crashed, or the
    // process was killed out from under us) leaves every in-flight send()
    // awaiting a reply that will never arrive — a silent hang forever, not
    // a failure any case's own try/catch or poll() timeout could ever see.
    const onGone = (why) => {
      this.closed = true;
      const err = new Error("CDP connection closed: " + why);
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
    };
    this.ws.addEventListener("close", (ev) => onGone("close (code " + ev.code + ")"));
    this.ws.addEventListener("error", (e) => onGone("error (" + (e && e.message || "unknown") + ")"));
  }

  send(method, params) {
    if (this.closed) return Promise.reject(new Error("CDP connection already closed (" + method + ")"));
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error("CDP socket not open (" + method + ")"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout after " + this.sendTimeoutMs + "ms waiting for " + method));
      }, this.sendTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  close() { try { if (this.ws) this.ws.close(); } catch {} }
}

/* Runs `expression` in the page's own top-level context (same world the
   real app's IIFE already ran in, so window.__splitpageFormats,
   window.__desktopTest and window.splitpageDesktop are all reachable —
   the app's own closure-local functions, like markDirty, are not, which
   is exactly why every case below drives the app through those two test
   hooks or through real DOM clicks instead of trying to reach inside). */
async function evalPage(cdp, expression, opts) {
  opts = opts || {};
  const params = {
    expression,
    awaitPromise: opts.awaitPromise !== false,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true
  };
  // Chromium only honours a page's beforeunload block (and therefore
  // Electron's 'will-prevent-unload') after the page has had USER
  // ACTIVATION. A Runtime.evaluate call is not itself a user gesture unless
  // this flag is set — every click or window.close() a close/unsaved-
  // changes test drives through evalPage needs it, or the prompt this suite
  // means to exercise simply never fires.
  if (opts.userGesture) params.userGesture = true;
  const res = await cdp.send("Runtime.evaluate", params);
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails.exception;
    const msg = (ex && (ex.description || ex.value)) || JSON.stringify(res.exceptionDetails);
    throw new Error("page eval failed: " + msg + " -- expr: " + expression.slice(0, 200));
  }
  return res.result ? res.result.value : undefined;
}

/* Polls `expression` (page-side) until it's truthy or the timeout hits.
   Swallows eval errors while polling (not just "not ready yet" values) —
   a page mid-navigation (Page.reload, a close in flight) throws "Cannot
   find context" for a moment, which should read as "keep waiting", not
   as a hard failure, from a poll's point of view. */
async function poll(cdp, expression, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evalPage(cdp, expression);
      if (last) return last;
    } catch { /* not ready — keep polling */ }
    await sleep(intervalMs || 250);
  }
  throw new Error("timed out waiting for: " + expression + " (last value: " + JSON.stringify(last) + ")");
}

async function waitForRows(cdp, timeoutMs) {
  return poll(cdp, "document.querySelectorAll('#rows > *').length", timeoutMs || 20000);
}

/* ----------------------------------------------------------------------
 * 2. Launching and tearing down the app.
 * -------------------------------------------------------------------- */

async function waitForCdpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const { body } = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (body && body.webSocketDebuggerUrl) return body;
    } catch (e) { lastErr = e; }
    await sleep(300);
  }
  throw new Error("CDP never came up on port " + port + (lastErr ? " (" + lastErr.message + ")" : ""));
}

async function findPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { body } = await fetchJson(`http://127.0.0.1:${port}/json`);
      if (Array.isArray(body)) {
        const page = body.find((t) => t.type === "page" && t.webSocketDebuggerUrl && !/^devtools:/.test(t.url || ""));
        if (page) return page;
      }
    } catch { /* keep trying */ }
    await sleep(300);
  }
  throw new Error("no page target appeared on port " + port);
}

/* opts: { flags:[], fixtures:[], dialogs:[]|null, userDataDir, dataDir,
           allowUpdateCheck:false, updateApi, label } */
async function launchApp(target, opts) {
  opts = opts || {};
  const port = await freePort();
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  if (!opts.userDataDir) fs.mkdirSync(userDataDir, { recursive: true });

  /* SPLITPAGE_TEST=1: the window never shows, unanswered dialogs cancel
     themselves, and a main-process crash exits with its stack on stderr
     instead of popping a modal error box on whoever's desktop this is. */
  const env = { ...process.env, SPLITPAGE_USER_DATA: userDataDir, SPLITPAGE_TEST: "1" };
  if (opts.allowUpdateCheck) delete env.SPLITPAGE_NO_UPDATE_CHECK;
  else env.SPLITPAGE_NO_UPDATE_CHECK = "1";
  if (opts.updateApi) env.SPLITPAGE_UPDATE_API = opts.updateApi;

  let dialogsPath = null;
  if (opts.dialogs) {
    dialogsPath = path.join(userDataDir, "test-dialogs-" + Date.now() + ".json");
    fs.writeFileSync(dialogsPath, JSON.stringify(opts.dialogs));
    env.SPLITPAGE_TEST_DIALOGS = dialogsPath;
  }

  const flags = [`--remote-debugging-port=${port}`, ...(opts.flags || [])];
  if (opts.dataDir) flags.push("--data", opts.dataDir);
  const fixtures = opts.fixtures || [];

  const args = target.kind === "dev"
    ? [target.appPath, ...flags, ...fixtures]
    : [...flags, ...fixtures];

  const proc = spawn(target.exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  proc.stdout.on("data", (d) => { stdout += d; });
  proc.stderr.on("data", (d) => { stderr += d; });
  let spawnErr = null;
  proc.on("error", (e) => { spawnErr = e; });

  await sleep(150); // let an immediate ENOENT-style spawn error surface
  if (spawnErr) throw new Error("failed to spawn " + target.exe + ": " + spawnErr.message);

  // A second instance that loses the single-instance lock calls app.quit()
  // before app.whenReady() ever runs — it never opens a --remote-debugging
  // port at all, so waiting on CDP here would just time out. Callers that
  // expect exactly that (case 7) ask for skipCdp and drive teardown/exit
  // detection off `proc` directly instead.
  if (opts.skipCdp) {
    return {
      target, proc, port, userDataDir, dialogsPath, cdp: null, browserWsUrl: null,
      label: opts.label || "launch", getStdout: () => stdout, getStderr: () => stderr
    };
  }

  const verInfo = await waitForCdpReady(port, 30000);
  const pageTarget = await findPageTarget(port, 30000);
  const cdp = new CDPConn(pageTarget.webSocketDebuggerUrl);
  await cdp.open();

  return {
    target, proc, port, userDataDir, dialogsPath, cdp,
    browserWsUrl: verInfo.webSocketDebuggerUrl,
    label: opts.label || "launch",
    getStdout: () => stdout,
    getStderr: () => stderr
  };
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const onExit = () => { if (!done) { done = true; resolve(true); } };
    proc.once("exit", onExit);
    setTimeout(() => { if (!done) { done = true; proc.removeListener("exit", onExit); resolve(false); } }, timeoutMs);
  });
}

function psProcessesMatching(substrings) {
  // Case-insensitive CommandLine contains-any-of check via Get-CimInstance,
  // exactly per the harness design note. -EncodedCommand sidesteps quoting
  // headaches from backslash-heavy Windows temp paths.
  const needles = substrings.map((s) => s.replace(/'/g, "''"));
  const conditions = needles.map((n) => `$_.CommandLine -like '*${n}*'`).join(" -or ");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and (${conditions}) } | Select-Object -ExpandProperty ProcessId`;
  const buf = Buffer.from(script, "utf16le");
  try {
    // ignore stderr: a first-use PowerShell module load can write a CLIXML
    // progress record there, which is noise, not a failure signal.
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", buf.toString("base64")], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  } catch {
    return [];
  }
}

function killPid(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 }); } catch {}
}

// document.visibilityState reads "visible" even in TEST_MODE (backgroundThrottling:false
// makes Electron report that) — it proves nothing about the screen. The only honest way to
// confirm no visible top-level window exists is to ask the OS: a process with no visible
// window has MainWindowHandle 0. The BrowserWindow's native HWND belongs to Electron's
// browser (main) process, not a renderer subprocess, so checking the pid we spawned is right
// for both dev and packaged targets.
function getMainWindowHandle(pid) {
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`
    ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : -1;
  } catch { return -1; }
}

// Fires a page-side expression (typically window.close()) without blocking on a reply that
// may never arrive: when the requested close actually goes through, the execution context —
// and sometimes the whole CDP target — can vanish mid-flight, which would otherwise hang this
// call until CDPConn's own (much longer) sendTimeoutMs. A short local race is exactly the
// "don't assume a reply" pattern the rest of this close case already has to use.
async function fireEval(cdp, expression, opts) {
  try {
    await Promise.race([evalPage(cdp, expression, opts), sleep(5000)]);
  } catch { /* context/target gone — expected on the close that actually succeeds */ }
}

async function closeBrowserGracefully(app) {
  try {
    const conn = new CDPConn(app.browserWsUrl, { sendTimeoutMs: 6000 });
    await conn.open(5000);
    await conn.send("Browser.close").catch(() => {});
    conn.close();
    return true;
  } catch { return false; }
}

/* Always: CDP Browser.close first (the clean path), then taskkill /T /F
   the tree as a fallback, then confirm via Win32_Process that nothing
   naming this launch's user-data dir survives.

   Also always records two checks under `tag` (case 15 in the harness
   design applies to EVERY case, so it lives here once instead of being
   repeated at each of the ~10 call sites): that teardown left no orphaned
   process, and that this launch's stderr never printed a
   "[splitpage-test] uncaught" line — a main-process crash must fail the
   suite loudly even when the case's own assertions all happened to pass
   before the crash. `app.getStderr()` reads a closure over already-
   captured output, so it's safe to call after the process has exited. */
async function teardown(app, tag) {
  const notes = [];
  try { app.cdp && app.cdp.close(); } catch {}
  if (app.cdp) await closeBrowserGracefully(app);
  let exited = await waitForExit(app.proc, 12000);
  if (!exited) {
    notes.push("did not exit after Browser.close; force-killed via taskkill");
    killPid(app.proc.pid);
    exited = await waitForExit(app.proc, 10000);
    if (!exited) notes.push("process still reported alive after taskkill");
  }
  // A packaged app's launcher exe can spawn a child renderer/utility process
  // tree under a different top pid than the one we spawned — search by the
  // user-data dir string (unique per launch) rather than trust one pid.
  await sleep(500);
  const leftover = psProcessesMatching([app.userDataDir]);
  if (leftover.length) {
    notes.push("leftover processes after teardown: " + leftover.join(","));
    leftover.forEach(killPid);
    await sleep(500);
    const stillThere = psProcessesMatching([app.userDataDir]);
    if (stillThere.length) notes.push("still present after forced cleanup: " + stillThere.join(","));
  }
  if (tag) {
    record(tag + ": clean teardown, no orphaned processes",
      !notes.some((n) => n.indexOf("leftover") === 0 || n.indexOf("still present") !== -1 || n.indexOf("still reported alive") !== -1),
      notes.join("; "));
    const stderrText = (app.getStderr && app.getStderr()) || "";
    const uncaught = /\[splitpage-test\] uncaught/.test(stderrText);
    record(tag + ": no main-process crash (stderr has no \"[splitpage-test] uncaught\")",
      !uncaught, uncaught ? stderrText.slice(-2000) : "");
  }
  return notes;
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

/* ----------------------------------------------------------------------
 * 3. Reporting.
 * -------------------------------------------------------------------- */

let totalChecks = 0, passedChecks = 0;
const failureLines = [];

function record(name, ok, detail) {
  totalChecks++;
  if (ok) passedChecks++;
  const line = (ok ? "PASS" : "FAIL") + " - " + name + (detail ? " :: " + detail : "");
  console.log(line);
  if (!ok) failureLines.push(name + (detail ? " :: " + detail : ""));
}

async function guarded(name, fn) {
  try {
    await fn();
  } catch (e) {
    record(name, false, "exception: " + (e && e.message ? e.message : String(e)));
  }
}

/* ----------------------------------------------------------------------
 * 4. Fixtures.
 * -------------------------------------------------------------------- */

// Hand-written per HANDOFF §4 / src/js/20d-formats.js's parseSplitpageFile:
// only `rows` needs to be an array — migrateRows (02-state.js) fills in
// every id/status/timestamp default, exactly like an untrusted load does.
function splitpageFixtureText(title, rowPairs) {
  const rows = rowPairs.map(([visual, audio]) => ({
    visualText: "<p>" + visual + "</p>",
    audioText: "<p>" + audio + "</p>"
  }));
  return JSON.stringify({ title, rows }, null, 2);
}

function writeFixture(dir, name, title, rowPairs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, splitpageFixtureText(title, rowPairs), "utf8");
  return p;
}

/* ----------------------------------------------------------------------
 * 5. The thirteen cases, grouped into launches so a ~10-15s emulated
 *    teardown isn't paid once per assertion. Cases that the harness design
 *    marks as needing the SAME user-data dir across two launches (7, 8)
 *    are written as exactly that; everything else gets its own fresh temp
 *    profile per the "every launch is isolated" rule.
 * -------------------------------------------------------------------- */

async function caseBootAndSecurity(target, fixturesDir) {
  const tag = target.name + " boot+security";
  let app = null;
  try {
    app = await launchApp(target, { label: "boot" });
    const cdp = app.cdp;

    // Right when CDP attaches, the target can still be showing about:blank
    // for a moment before loadURL's navigation lands — poll instead of a
    // single read so this isn't a coin flip on how fast the app boots.
    const url = await poll(cdp, "location.href !== 'about:blank' && location.href", 15000).catch(() => "about:blank");
    record(tag + ": origin is splitpage://app/index.html", url === "splitpage://app/index.html", url);

    const isDesktop = await evalPage(cdp, "!!(window.splitpageDesktop && window.splitpageDesktop.isDesktop)");
    record(tag + ": window.splitpageDesktop.isDesktop", isDesktop === true);

    await guarded(tag + ": #rows populated", async () => {
      const n = await waitForRows(cdp, 20000);
      record(tag + ": #rows populated", n > 0, "rows=" + n);
    });

    const health = await evalPage(cdp, "fetch('/api/health').then(function(r){return r.status;})");
    record(tag + ": fetch('/api/health') is 404 in local mode", health === 404, "status=" + health);

    const updateStatus = await evalPage(cdp, "fetch('update-status.json').then(function(r){return r.json();})");
    record(tag + ": update-status.json parses with desktop:true", !!updateStatus && updateStatus.desktop === true, JSON.stringify(updateStatus));

    const title = await evalPage(cdp, "document.title");
    record(tag + ": document.title contains 'Splitpage'", typeof title === "string" && title.indexOf("Splitpage") !== -1, title);

    await guarded(tag + ": no service worker registered", async () => {
      // On this build, navigator.serviceWorker.getRegistrations() itself
      // rejects on the splitpage:// origin (observed: Electron's custom
      // "standard: true, secure: true" scheme isn't wired into Chromium's
      // service-worker-eligible-scheme allowlist the way http/https are —
      // a platform characteristic of protocol.handle-based custom schemes,
      // not anything src/js/21-events.js's DESKTOP-gated skip controls).
      // Either a rejection or an empty list is equally good evidence that
      // no service worker is running, which is the actual thing this case
      // cares about — the app itself never calls .register() when DESKTOP
      // is set, precisely because it doesn't need to.
      const outcome = await evalPage(cdp,
        "navigator.serviceWorker.getRegistrations().then(function(r){return {ok:true,length:r.length};})" +
        ".catch(function(e){return {ok:false,length:0,error:String(e && e.message || e)};})");
      const noSw = !!outcome && outcome.length === 0;
      record(tag + ": no service worker registered", noSw, JSON.stringify(outcome));
    });

    // --- security ---
    await guarded(tag + ": writeFile('bogus-id', ...) rejects", async () => {
      const writeRejected = await evalPage(cdp,
        "(async function(){ try { await window.splitpageDesktop.writeFile('bogus-id','x'); return false; } catch(e){ return true; } })()");
      record(tag + ": writeFile('bogus-id', ...) rejects", writeRejected === true);
    });

    await guarded(tag + ": in-window navigation to https:// is blocked", async () => {
      await evalPage(cdp, "try { location.href = 'https://example.com/'; } catch(e){}", { awaitPromise: false });
      await sleep(1500);
      const hrefAfterNav = await evalPage(cdp, "location.href");
      record(tag + ": in-window navigation to https:// is blocked", typeof hrefAfterNav === "string" && hrefAfterNav.indexOf("splitpage://app/") === 0, hrefAfterNav);
    });

    await guarded(tag + ": window.open(https://...)", async () => {
      const beforeTargets = (await fetchJson(`http://127.0.0.1:${app.port}/json`)).body || [];
      const beforePages = beforeTargets.filter((t) => t.type === "page").length;
      const openReturnedNull = await evalPage(cdp, "window.open('https://example.com/') === null");
      await sleep(1500);
      const afterTargets = (await fetchJson(`http://127.0.0.1:${app.port}/json`)).body || [];
      const afterPages = afterTargets.filter((t) => t.type === "page").length;
      record(tag + ": window.open(https://...) returns null", openReturnedNull === true);
      record(tag + ": window.open(https://...) opens no new Electron target", afterPages === beforePages, `before=${beforePages} after=${afterPages}`);
    });

    await guarded(tag + ": static allowlist", async () => {
      const nonAllowlisted = await evalPage(cdp, "fetch('splitpage://app/server/server.js').then(function(r){return r.status;})");
      record(tag + ": server/server.js is not on the static allowlist (404)", nonAllowlisted === 404, "status=" + nonAllowlisted);

      const traversalToNonAllowlisted = await evalPage(cdp, "fetch('splitpage://app/../../server/server.js').then(function(r){return r.status;})");
      record(tag + ": '../..' traversal to a non-allowlisted file is refused (404)", traversalToNonAllowlisted === 404, "status=" + traversalToNonAllowlisted);

      // VERSION genuinely IS on the static allowlist by design (main.js
      // STATIC_ALLOWLIST) — a dotted-path request that normalizes onto it
      // is expected to succeed. Recorded, not asserted as a "should be
      // blocked" failure, so this doesn't misreport an intentional
      // allowlist entry as a traversal bug.
      const versionViaDots = await evalPage(cdp, "fetch('splitpage://app/../../VERSION').then(function(r){return r.status;})");
      record(tag + ": '../../VERSION' resolves onto the (intentionally allowlisted) /VERSION entry", versionViaDots === 200, "status=" + versionViaDots + " -- VERSION is in STATIC_ALLOWLIST by design, so this is expected, not a traversal escape");
    });
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
  }
}

async function caseOpenSaveConflictExport(target, fixturesDir) {
  const tag = target.name + " open/save/conflict/save-as/export";
  const openTitle = "Opened — 🎬 Fixture";
  const fixturePath = writeFixture(fixturesDir, "case2-open.splitpage", openTitle,
    [["First shot — establishing 🎬", "Some narration — with an em dash"], ["Second shot 🚀", "More narration"]]);
  const savedTitle = "Saved in place — 🚀 New Title";
  const newSplitpagePath = path.join(fixturesDir, "case5-save-as.splitpage");
  const exportMdPath = path.join(fixturesDir, "case6-export.md");

  let app = null;
  try {
    app = await launchApp(target, {
      label: "open+save",
      fixtures: [fixturePath],
      dialogs: [newSplitpagePath, null, exportMdPath]
    });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);

    // --- case 2: open via argv ---
    const stateTitle = await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify(openTitle), 20000);
    record(tag + ": argv-opened file's title reaches state", !!stateTitle, "");
    const rowCount = await evalPage(cdp, "window.__splitpageFormats.state().rows.length");
    record(tag + ": argv-opened file's row count matches", rowCount === 2, "rows=" + rowCount);

    // --- case 3: save in place round trip ---
    await evalPage(cdp, "window.__splitpageFormats.state().title = " + JSON.stringify(savedTitle) + "; true");
    await evalPage(cdp, "window.__splitpageFormats.save()");
    let onDisk = null;
    for (let i = 0; i < 20 && onDisk === null; i++) {
      try { onDisk = JSON.parse(fs.readFileSync(fixturePath, "utf8")); } catch { await sleep(250); }
    }
    record(tag + ": save() writes the new title to disk, byte-exact non-ASCII", !!onDisk && onDisk.title === savedTitle, onDisk ? onDisk.title : "no parse");

    // --- case 4: conflict guard ---
    const beforeConflictBytes = fs.readFileSync(fixturePath);
    const st = fs.statSync(fixturePath);
    const bumped = new Date(st.mtime.getTime() + 5000);
    fs.utimesSync(fixturePath, bumped, bumped);
    await evalPage(cdp, "window.__splitpageFormats.save()");
    const conflictShown = await poll(cdp, "document.getElementById('file-conflict-modal') && document.getElementById('file-conflict-modal').hidden === false", 10000);
    record(tag + ": on-disk conflict shows #file-conflict-modal", !!conflictShown);
    const afterConflictBytes = fs.readFileSync(fixturePath);
    record(tag + ": conflicted file is left unchanged on disk", beforeConflictBytes.equals(afterConflictBytes));

    // --- case 5: Save As via test dialogs (answered, then cancelled) ---
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    let saveAsOk = false;
    for (let i = 0; i < 30 && !saveAsOk; i++) {
      if (fs.existsSync(newSplitpagePath)) saveAsOk = true; else await sleep(250);
    }
    record(tag + ": Save As (answered dialog) writes the new file", saveAsOk);
    if (saveAsOk) {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(newSplitpagePath, "utf8")); } catch {}
      record(tag + ": Save As file parses as a .splitpage document", !!parsed && Array.isArray(parsed.rows), parsed ? "" : "parse failed");
    }

    const toastsBefore = await evalPage(cdp, "document.querySelectorAll('.toast').length");
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    await sleep(1500); // cancelled dialog: nothing to poll for, just let it settle
    const toastsAfter = await evalPage(cdp, "document.querySelectorAll('.toast').length");
    record(tag + ": cancelled Save As shows no error toast", toastsAfter === toastsBefore, `before=${toastsBefore} after=${toastsAfter}`);

    // --- case 6: export via test dialogs ---
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('export-md')", { awaitPromise: false });
    let exportOk = false;
    for (let i = 0; i < 30 && !exportOk; i++) {
      if (fs.existsSync(exportMdPath)) exportOk = true; else await sleep(250);
    }
    record(tag + ": export-md writes a .md file", exportOk);
    if (exportOk) {
      const mdText = fs.readFileSync(exportMdPath, "utf8");
      record(tag + ": exported .md contains the script title", mdText.indexOf(savedTitle) !== -1);
    }
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
  }
}

async function caseSecondInstance(target, fixturesDir) {
  const tag = target.name + " second instance";
  const fixtureA = writeFixture(fixturesDir, "case7-a.splitpage", "First Instance Doc", [["a", "b"]]);
  const fixtureB = writeFixture(fixturesDir, "case7-b.splitpage", "Second Instance Doc — 🚀", [["c", "d"]]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));

  let first = null;
  let second = null;
  try {
    first = await launchApp(target, { label: "first-instance", userDataDir, fixtures: [fixtureA] });
    await waitForRows(first.cdp, 20000);
    await poll(first.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("First Instance Doc"), 15000);

    second = await launchApp(target, { label: "second-instance", userDataDir, fixtures: [fixtureB], skipCdp: true });
    const secondExited = await waitForExit(second.proc, 15000);
    record(tag + ": second launch exits quickly (single-instance lock)", secondExited === true);

    const gotSecondDoc = await poll(first.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Second Instance Doc — 🚀"), 15000);
    record(tag + ": first window now shows the second file's title", !!gotSecondDoc);
  } finally {
    if (second) {
      // Only close what still needs closing — a real single-instance exit
      // already tore this one down.
      if (second.proc.exitCode === null) killPid(second.proc.pid);
      try { second.cdp.close(); } catch {}
    }
    if (first) {
      await teardown(first, tag);
    }
    rmrf(userDataDir);
  }
}

async function caseLastFileResume(target, fixturesDir) {
  const tag = target.name + " last-file resume";
  const fixtureC = writeFixture(fixturesDir, "case8-resume.splitpage", "Resume Me — 🎬", [["x", "y"], ["p", "q"]]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));

  let appA = null, appB = null;
  try {
    appA = await launchApp(target, { label: "open+save+quit", userDataDir, fixtures: [fixtureC] });
    await waitForRows(appA.cdp, 20000);
    await poll(appA.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Resume Me — 🎬"), 15000);
    await evalPage(appA.cdp, "window.__splitpageFormats.save()");
    await sleep(500);
    await teardown(appA, tag + " (first launch: open+save)");
    appA = null;

    appB = await launchApp(target, { label: "resume", userDataDir });
    await waitForRows(appB.cdp, 20000);
    const resumedTitle = await poll(appB.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Resume Me — 🎬"), 20000);
    record(tag + ": relaunch with no args resumes the last file", !!resumedTitle);
    const resumedRows = await evalPage(appB.cdp, "window.__splitpageFormats.state().rows.length");
    record(tag + ": resumed document's row count matches", resumedRows === 2, "rows=" + resumedRows);
  } finally {
    if (appA) await teardown(appA, tag + " (first launch: open+save)");
    if (appB) {
      await teardown(appB, tag + " (second launch: resume)");
    }
    rmrf(userDataDir);
  }
}

async function caseLibraryMode(target) {
  const tag = target.name + " --library";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "library", flags: ["--library"], dataDir });
    await waitForRows(app.cdp, 20000);

    const healthStatus = await poll(app.cdp, "fetch('/api/health').then(function(r){return r.status;})", 15000);
    record(tag + ": fetch('/api/health') is 200 in --library mode", healthStatus === 200, "status=" + healthStatus);
    const health = await evalPage(app.cdp, "fetch('/api/health').then(function(r){return r.json();})");
    record(tag + ": /api/health reports mode 'server'", !!health && health.mode === "server", JSON.stringify(health));

    const docTitle = "Library Doc — 🎬";
    const created = await evalPage(app.cdp,
      `fetch('/api/docs', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ state: { title: ${JSON.stringify(docTitle)}, rows: [] } }) }).then(function(r){ return r.json(); })`);
    record(tag + ": POST /api/docs creates a doc", !!created && !!created.id, JSON.stringify(created));

    if (created && created.id) {
      const readBack = await evalPage(app.cdp, `fetch('/api/docs/${created.id}').then(function(r){return r.json();})`);
      record(tag + ": GET /api/docs/:id round-trips the same title", !!readBack && readBack.state && readBack.state.title === docTitle, JSON.stringify(readBack));
    }

    const info = await evalPage(app.cdp, "window.splitpageDesktop.getSessionInfo()");
    record(tag + ": getSessionInfo() reports library:true", !!info && info.library === true, JSON.stringify(info));

    const docServerPort = info && info.port;
    const closedUserDataDir = app.userDataDir;
    await teardown(app, tag);
    app = null;
    rmrf(closedUserDataDir);

    if (docServerPort) {
      const closed = await portClosed(docServerPort, "127.0.0.1");
      record(tag + ": document server port closed after quit", closed === true, "port=" + docServerPort);
    } else {
      record(tag + ": document server port closed after quit", false, "no port was ever reported by getSessionInfo()");
    }
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
    rmrf(dataDir);
  }
}

async function caseHostMode(target) {
  const tag = target.name + " --host --pin";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "host", flags: ["--host", "--pin", "4821"], dataDir });
    await waitForRows(app.cdp, 20000);

    const info = await poll(app.cdp, "window.splitpageDesktop.getSessionInfo().then(function(i){ return (i && i.hosting) ? i : null; })", 20000);
    record(tag + ": getSessionInfo() reports hosting:true", !!info && info.hosting === true, JSON.stringify(info));
    record(tag + ": getSessionInfo() reports pin '4821'", !!info && info.pin === "4821", JSON.stringify(info));
    record(tag + ": getSessionInfo() reports a lanUrls array", !!info && Array.isArray(info.lanUrls), JSON.stringify(info && info.lanUrls));

    const shareVisible = await poll(app.cdp, "(function(){ var el = document.getElementById('desktop-share-info'); return el && el.hidden === false; })()", 10000);
    record(tag + ": the desktop share-info UI is visible while hosting", !!shareVisible);

    const port = info && info.port;
    if (port) {
      const noToken = await fetchJson(`http://127.0.0.1:${port}/api/docs`);
      record(tag + ": GET /api/docs with no token is 401", noToken.status === 401, "status=" + noToken.status + " body=" + JSON.stringify(noToken.body));

      const joined = await fetchJson(`http://127.0.0.1:${port}/api/join`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "4821" })
      });
      record(tag + ": POST /api/join with the correct PIN returns a token", joined.status === 200 && !!joined.body && !!joined.body.token, JSON.stringify(joined.body));
    } else {
      record(tag + ": GET /api/docs with no token is 401", false, "no port reported by getSessionInfo()");
      record(tag + ": POST /api/join with the correct PIN returns a token", false, "no port reported by getSessionInfo()");
    }
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
    rmrf(dataDir);
  }
}

async function startTinyUpdateServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tag_name: "v99.0.0", html_url: "https://example.com/r" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/repos/x/releases/latest` };
}

async function caseUpdateStatus(target) {
  const tag = target.name + " update status";
  const mini = await startTinyUpdateServer();
  let app = null;
  try {
    app = await launchApp(target, { label: "update-check", allowUpdateCheck: true, updateApi: mini.url });
    await waitForRows(app.cdp, 20000);

    const status = await poll(app.cdp, "fetch('update-status.json',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){return s.updateAvailable ? s : null;})", 20000);
    record(tag + ": update-status.json reports updateAvailable:true", !!status && status.updateAvailable === true, JSON.stringify(status));
    record(tag + ": update-status.json reports the release URL", !!status && status.releaseUrl === "https://example.com/r", JSON.stringify(status));

    // The renderer only reads update-status.json once, at boot (fire-and-
    // forget in init()) — reload so it re-reads the now-updated in-memory
    // status and the notice actually renders.
    await app.cdp.send("Page.reload", {}).catch(() => {});
    await waitForRows(app.cdp, 20000);
    const barVisible = await poll(app.cdp, "(function(){ var b = document.getElementById('update-bar'); return b && b.hidden === false; })()", 15000);
    record(tag + ": the update notice bar appears", !!barVisible);
    const barText = await evalPage(app.cdp, "(document.getElementById('update-bar-text')||{}).textContent || ''");
    record(tag + ": the update notice mentions the new version", typeof barText === "string" && barText.indexOf("99.0.0") !== -1, barText);
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
    await new Promise((resolve) => mini.server.close(resolve));
  }
}

/* Case 14: clean-close regression test for the fixed "Object has been
   destroyed" bug. main.js's window 'closed' handler used to read
   win.webContents AFTER the BrowserWindow was already destroyed, throwing
   on every single close and popping Electron's modal error box (which
   blocks the main thread — the ORIGINAL, wrong diagnosis in this file
   attributed that hang to "CDP window-closing is flaky in this
   environment"; it was this crash). The fix captures webContents before
   destruction. This case is the regression guard: an untouched (never
   dirtied, so no unsaved-changes prompt in the way at all) document,
   closed for real, must exit clean — code 0, no crash line on stderr. */
async function caseCleanClose(target) {
  const tag = target.name + " clean close (regression)";
  let app = null;
  try {
    app = await launchApp(target, { label: "clean-close" });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);

    const t0 = Date.now();
    await fireEval(cdp, "window.close()", { awaitPromise: false, userGesture: true });
    const exited = await waitForExit(app.proc, 45000); // x64-on-ARM64 emulation teardown is slow
    const elapsedMs = Date.now() - t0;
    record(tag + ": process exits within 45s of window.close()", exited === true, "elapsed=" + elapsedMs + "ms");
    record(tag + ": exit code is 0", app.proc.exitCode === 0, "exitCode=" + app.proc.exitCode + " signal=" + app.proc.signalCode);

    const stderrText = app.getStderr() || "";
    const hasTestMarker = stderrText.indexOf("[splitpage-test]") !== -1;
    const hasDestroyedError = stderrText.indexOf("Object has been destroyed") !== -1;
    record(tag + ": stderr has no \"[splitpage-test]\" line", !hasTestMarker, hasTestMarker ? stderrText.slice(-2000) : "");
    record(tag + ": stderr has no \"Object has been destroyed\"", !hasDestroyedError, hasDestroyedError ? stderrText.slice(-2000) : "");
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
  }
}

/* Case 13: unsaved-changes close. Drives the SAME will-prevent-unload path
   main.js actually implements (see main.js's own comment block just above
   `win.webContents.on("will-prevent-unload", ...)`): "cancel" leaves the
   block in place (window stays open), "confirm" overrides it (window
   closes). This used to be mis-diagnosed as unobservable over CDP — that
   was really the "Object has been destroyed" crash above; with that fixed,
   the debug port stays alive across a close the app itself cancels, so
   this drives both outcomes for real instead of giving up on them.

   Two things matter for this to actually exercise the app's logic rather
   than silently no-op:
     - the edit that dirties the document needs userGesture:true, because
       Chromium only honours a beforeunload block after the page has had
       real user activation (see evalPage's userGesture comment);
     - window.close() itself is fired through fireEval(), which does not
       wait for a reply that may never arrive — when "confirm" actually
       goes through, the page's execution context (and sometimes the
       whole CDP target) can vanish out from under the in-flight
       Runtime.evaluate call. */
async function caseUnsavedChangesClose(target) {
  const tag = target.name + " unsaved-changes close";

  // --- part A: cancel keeps it open; a second close, now answered
  //     "confirm", actually closes it. One shared SPLITPAGE_TEST_DIALOGS
  //     cursor (main.js's own design — see its own comment on
  //     testDialogAnswers), consumed in the order the app calls it. ---
  let app = null;
  try {
    app = await launchApp(target, { label: "unsaved-close-cancel-then-confirm", dialogs: ["cancel", "confirm"] });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);

    await evalPage(cdp,
      "(function(){ var b = document.querySelector('.add-row-btn'); if (b) b.click(); return !!b; })()",
      { userGesture: true });
    const dirtyShown = await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
    record(tag + ": editing marks the document dirty (Save button shows the dot)", !!dirtyShown);

    // First close request: dialogs[0] = "cancel" -> will-prevent-unload's
    // event.preventDefault() is NOT called -> the page's own block stands
    // -> window stays open.
    await fireEval(cdp, "window.close()", { awaitPromise: false, userGesture: true });
    await sleep(1500);
    const stillAliveAfterCancel = app.proc.exitCode === null;
    let pageStillThere = false;
    if (stillAliveAfterCancel) {
      const list = (await fetchJson(`http://127.0.0.1:${app.port}/json`, undefined, 4000).catch(() => ({ body: [] }))).body || [];
      pageStillThere = Array.isArray(list) && list.some((t) => t.type === "page");
    }
    record(tag + ": 'cancel' on the unsaved-changes prompt keeps the window open",
      stillAliveAfterCancel && pageStillThere,
      "exitCode=" + app.proc.exitCode + " pageStillThere=" + pageStillThere);

    // Still the same dirty document, not a fresh window — confirms "kept
    // open" actually means what it says, not just "process alive".
    const stillDirty = await evalPage(cdp,
      "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()"
    ).catch(() => null);
    record(tag + ": the same dirty document is still showing after 'cancel'", stillDirty === true, String(stillDirty));

    // Second close request: dialogs[1] = "confirm" -> event.preventDefault()
    // IS called -> overrides the page's block -> window closes for real.
    await fireEval(cdp, "window.close()", { awaitPromise: false, userGesture: true });
    const exited = await waitForExit(app.proc, 20000);
    record(tag + ": 'confirm' on the unsaved-changes prompt closes the window", exited === true);
    record(tag + ": process exits with code 0 after confirming", app.proc.exitCode === 0, "exitCode=" + app.proc.exitCode);
  } finally {
    if (app) {
      await teardown(app, tag + " (cancel-then-confirm)");
      rmrf(app.userDataDir);
    }
  }

  // --- part B: a dirty close with NO pre-answered dialog. TEST_MODE
  //     monkeypatches dialog.showMessageBoxSync to auto-answer its
  //     cancelId (main.js) whenever SPLITPAGE_TEST_DIALOGS didn't supply
  //     one — for this prompt's button order that's "Stay" — so the
  //     window must stay open and, per the hard rule for this machine,
  //     nothing must ever have appeared on screen while that happened. ---
  let app2 = null;
  try {
    app2 = await launchApp(target, { label: "unsaved-close-no-dialogs-default-stay" });
    const cdp2 = app2.cdp;
    await waitForRows(cdp2, 20000);

    await evalPage(cdp2,
      "(function(){ var b = document.querySelector('.add-row-btn'); if (b) b.click(); return !!b; })()",
      { userGesture: true });
    await poll(cdp2, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);

    await fireEval(cdp2, "window.close()", { awaitPromise: false, userGesture: true });
    await sleep(1500);
    const stillAlive2 = app2.proc.exitCode === null;
    record(tag + ": dirty close with NO pre-answered dialog stays open (test-mode default = Stay)",
      stillAlive2, "exitCode=" + app2.proc.exitCode);

    const handle = getMainWindowHandle(app2.proc.pid);
    record(tag + ": no visible top-level window appeared during the whole case (MainWindowHandle=0)", handle === 0, "handle=" + handle);
  } finally {
    if (app2) {
      await teardown(app2, tag + " (no pre-answered dialog)");
      rmrf(app2.userDataDir);
    }
  }
}

/* Regression case for "close-relies-on-beforeunload-activation": the main
   process must be the sole authority on unsaved changes, not the page's own
   beforeunload block, which Chromium only honours after real user
   activation (a click, a keypress) has happened THIS session. This case
   never clicks anything at all — window.__desktopTest.markDirtyForTest()
   (20f-desktop.js) calls markDirty() directly with zero DOM interaction,
   the same shape as a real no-gesture dirty path (applyStashedWork merging
   a stash at load, a resumed project, an OS-opened file marked dirty on
   open) — and window.close() itself is fired with no userGesture either.
   Before the fix, this closed the window silently with no prompt at all;
   after it, main.js's 'close' handler reads lastDirtyByWebContents (kept
   current by splitpage:set-document-state) directly, so the prompt fires
   regardless of activation. */
async function caseCloseAuthorityNoGesture(target) {
  const tag = target.name + " close authority (no user gesture anywhere)";
  let app = null;
  try {
    app = await launchApp(target, { label: "close-authority-no-gesture", dialogs: ["cancel", "confirm"] });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);

    await evalPage(cdp, "window.__desktopTest.markDirtyForTest(); true", { awaitPromise: false });
    const dirtyShown = await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
    record(tag + ": markDirtyForTest() dirties the document with zero DOM interaction", !!dirtyShown);

    // setDocumentState() (called from markDirty() via notifyDesktopDocumentState())
    // reaches main over ipcRenderer.send — fire-and-forget from the
    // renderer's point of view, so the DOM already showing the dirty dot is
    // no guarantee main.js's lastDirtyByWebContents map has been updated
    // yet. An ipcRenderer.invoke() round trip on the SAME WebContents is
    // delivered in order after that earlier send, so awaiting one here
    // guarantees main has already processed it before we ask it to close.
    await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");

    // First close request, no userGesture at all: dialogs[0] = "cancel" ->
    // the 'close' handler's own dirty check answers "Stay" -> window stays
    // open. If this were still relying on will-prevent-unload, Chromium
    // would never even fire it here (no activation ever happened), and the
    // window would just close silently instead.
    await fireEval(cdp, "window.close()", { awaitPromise: false });
    await sleep(1500);
    const stillAliveAfterCancel = app.proc.exitCode === null;
    let pageStillThere = false;
    if (stillAliveAfterCancel) {
      const list = (await fetchJson(`http://127.0.0.1:${app.port}/json`, undefined, 4000).catch(() => ({ body: [] }))).body || [];
      pageStillThere = Array.isArray(list) && list.some((t) => t.type === "page");
    }
    let dbgLog = "";
    try { dbgLog = fs.readFileSync(path.join(app.userDataDir, "debug.log"), "utf8"); } catch {}
    record(tag + ": close is still prompted with no user gesture, and 'cancel' keeps the window open",
      stillAliveAfterCancel && pageStillThere,
      "exitCode=" + app.proc.exitCode + " pageStillThere=" + pageStillThere + " DBGLOG=" + dbgLog);

    // Second close request: dialogs[1] = "confirm" -> "Leave without saving"
    // -> the window actually closes, still with no gesture ever having
    // happened this session.
    await fireEval(cdp, "window.close()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 20000);
    record(tag + ": 'confirm' closes the window for real, still with no user gesture", exited === true);
    record(tag + ": process exits with code 0", app.proc.exitCode === 0, "exitCode=" + app.proc.exitCode);
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
  }
}

/* Regression case for "second-instance-wrong-cwd": a RELATIVE path handed
   to a second launch must resolve against that second (launching) process's
   own working directory, not against the already-running first instance's.
   Spawns the second process directly (not through launchApp(), which always
   passes absolute fixture paths) with `cwd: fixturesDir` and just the
   fixture's basename as the argument. */
async function caseSecondInstanceRelativePath(target, fixturesDir) {
  const tag = target.name + " second instance (relative path from a different cwd)";
  const fixtureName = "case7c-relative.splitpage";
  const fixtureTitle = "Relative Path Doc — 🎯";
  writeFixture(fixturesDir, fixtureName, fixtureTitle, [["m", "n"]]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));

  let first = null;
  let secondProc = null;
  try {
    first = await launchApp(target, { label: "first-instance-relpath", userDataDir });
    await waitForRows(first.cdp, 20000);

    const port = await freePort();
    const env = { ...process.env, SPLITPAGE_USER_DATA: userDataDir, SPLITPAGE_TEST: "1", SPLITPAGE_NO_UPDATE_CHECK: "1" };
    const flags = [`--remote-debugging-port=${port}`];
    // Only the basename — the whole point is that this must resolve against
    // the SECOND process's cwd (fixturesDir, set below), not the first's.
    const args = target.kind === "dev" ? [target.appPath, ...flags, fixtureName] : [...flags, fixtureName];
    secondProc = spawn(target.exe, args, { cwd: fixturesDir, env, stdio: ["ignore", "pipe", "pipe"] });
    const secondExited = await waitForExit(secondProc, 15000);
    record(tag + ": second launch exits quickly (single-instance lock)", secondExited === true);

    const gotDoc = await poll(first.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify(fixtureTitle), 15000);
    record(tag + ": first window opens the relative-path file resolved against the SECOND process's cwd", !!gotDoc);
  } finally {
    if (secondProc && secondProc.exitCode === null) killPid(secondProc.pid);
    if (first) await teardown(first, tag);
    rmrf(userDataDir);
  }
}

/* Regression case for "unpinned-shared-session-shortcut": "--pin" with no
   value (exactly what the installer's shared-session shortcut now passes,
   per installer.nsh) must auto-generate a real 6-digit PIN rather than
   leaving JOIN_PIN empty. */
async function caseHostModeAutoPin(target) {
  const tag = target.name + " --host --pin (no value, auto-generated)";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "host-auto-pin", flags: ["--host", "--pin"], dataDir });
    await waitForRows(app.cdp, 20000);
    const info = await poll(app.cdp, "window.splitpageDesktop.getSessionInfo().then(function(i){ return (i && i.hosting) ? i : null; })", 20000);
    record(tag + ": a bare '--pin' auto-generates a 6-digit PIN instead of leaving JOIN_PIN empty",
      !!info && /^\d{6}$/.test(info.pin || ""), JSON.stringify(info));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(dataDir);
  }
}

/* Regression case for the other half of "unpinned-shared-session-shortcut":
   renderDesktopShareInfo() (20f-desktop.js) must say so explicitly on the
   rare occasion a session genuinely has no PIN (typing --host by hand, with
   no --pin at all — bypassing the installer's own shortcut, which now
   always adds one) instead of silently omitting the whole PIN section like
   it used to. */
async function caseHostModeNoPinWarning(target) {
  const tag = target.name + " --host with no --pin at all shows an explicit warning";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "host-no-pin", flags: ["--host"], dataDir });
    await waitForRows(app.cdp, 20000);
    await poll(app.cdp, "(function(){ var el = document.getElementById('desktop-share-info'); return el && el.hidden === false; })()", 15000);
    const warningText = await evalPage(app.cdp,
      "(function(){ var el = document.querySelector('.connect-share-nopin'); return el ? el.textContent : null; })()");
    record(tag + ": the share-info panel explicitly warns when the session truly has no PIN",
      typeof warningText === "string" && /no pin/i.test(warningText), String(warningText));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(dataDir);
  }
}

/* ----------------------------------------------------------------------
 * 6. Runner.
 * -------------------------------------------------------------------- */

async function runTargetSuite(target) {
  console.log(`\n==== target: ${target.name} (${target.exe}) ====`);
  const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-fixtures-"));
  // Each group gets its own top-level guard: one group crashing outright
  // (not just failing an assertion — an uncaught exception past its own
  // internal try/finally) must not skip every group after it for this
  // target. Groups already tear down their own launches in their own
  // finally blocks; this only protects the group sequencing.
  const groups = [
    ["open/boot/security", () => caseBootAndSecurity(target, fixturesDir)],
    ["open/save/conflict/save-as/export", () => caseOpenSaveConflictExport(target, fixturesDir)],
    ["second instance", () => caseSecondInstance(target, fixturesDir)],
    ["second instance (relative path)", () => caseSecondInstanceRelativePath(target, fixturesDir)],
    ["last-file resume", () => caseLastFileResume(target, fixturesDir)],
    ["--library", () => caseLibraryMode(target)],
    ["--host --pin", () => caseHostMode(target)],
    ["--host --pin (auto-generated)", () => caseHostModeAutoPin(target)],
    ["--host with no --pin (warning)", () => caseHostModeNoPinWarning(target)],
    ["update status", () => caseUpdateStatus(target)],
    ["unsaved-changes close", () => caseUnsavedChangesClose(target)],
    ["close authority (no user gesture)", () => caseCloseAuthorityNoGesture(target)],
    ["clean close (regression)", () => caseCleanClose(target)]
  ];
  try {
    for (const [name, fn] of groups) {
      try {
        await fn();
      } catch (e) {
        record(target.name + ": " + name + " (group)", false, "uncaught exception: " + (e && e.message ? e.message : String(e)));
      }
    }
  } finally {
    rmrf(fixturesDir);
  }
}

async function main() {
  const { exe, onlyTarget } = parseCliArgs(process.argv.slice(2));
  let targets = resolveTargets(exe);
  if (onlyTarget) targets = targets.filter((t) => t.name === onlyTarget);
  if (!targets.length) {
    console.error("No target found: no desktop/node_modules/electron and no packaged dist/*-unpacked/Splitpage.exe. Nothing to test.");
    process.exit(1);
  }
  console.log("Targets: " + targets.map((t) => t.name).join(", "));

  for (const target of targets) {
    try {
      await runTargetSuite(target);
    } catch (e) {
      record(target.name + ": target suite", false, "uncaught exception: " + (e && e.stack || e));
    }
  }

  console.log("");
  if (passedChecks === totalChecks) {
    console.log(`ALL PASS - ${passedChecks}/${totalChecks} desktop checks`);
    process.exit(0);
  } else {
    console.log(`FAILURES (${totalChecks - passedChecks}):`);
    failureLines.forEach((l) => console.log("  - " + l));
    console.log(`${passedChecks}/${totalChecks} desktop checks passed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("smoke.mjs crashed:", e && e.stack || e);
  process.exit(1);
});
