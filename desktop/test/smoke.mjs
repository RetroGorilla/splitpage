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
import crypto from "node:crypto";
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

// Pulls the ?tab=<tabId> query param off a page target's url, tab-strip and
// pre-navigation (about:blank) targets included — those just come back null.
function parseTabIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = /[?&]tab=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/* SMOKE-HARNESS target discovery. Today (pre-F1) the app is still a single
   splitpage://app/index.html page with no tab strip and no ?tab= query
   string at all — tabTargets/tabStripTargets and the tabId-less findPageTarget
   call below must keep finding exactly that one page unchanged. Once F1 lands,
   splitpage://tabstrip/... becomes the window's primary webContents and each
   tab page gets its own ?tab=<tabId>; findTargetsByKind is what lets every
   other helper (and F1's own suite) tell the two apart without ever treating
   the strip as a page a case can drive assertions against. */
async function findTargetsByKind(port) {
  const { body } = await fetchJson(`http://127.0.0.1:${port}/json`);
  const list = Array.isArray(body) ? body : [];
  const isPage = (t) => t.type === "page" && t.webSocketDebuggerUrl && !/^devtools:/.test(t.url || "");
  const tabStripTargets = list.filter((t) => isPage(t) && (t.url || "").indexOf("splitpage://tabstrip/") === 0);
  const tabTargets = list
    .filter((t) => isPage(t) && (t.url || "").indexOf("splitpage://app/index.html") === 0)
    .map((t) => Object.assign({}, t, { tabId: parseTabIdFromUrl(t.url) }));
  return { tabStripTargets, tabTargets };
}

// Returns a splitpage://app/index.html tab target — NEVER the tab-strip
// target, even once one exists. opts.tabId narrows to that one tab; with no
// tabId (today's single-window app, or "any tab is fine") the first tab
// target found wins.
async function findPageTarget(port, timeoutMs, opts) {
  opts = opts || {};
  const wantTabId = opts.tabId || null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { tabTargets } = await findTargetsByKind(port);
      const candidates = wantTabId ? tabTargets.filter((t) => t.tabId === wantTabId) : tabTargets;
      if (candidates.length) return candidates[0];
    } catch { /* keep trying */ }
    await sleep(300);
  }
  throw new Error("no page target appeared on port " + port + (wantTabId ? " for tabId=" + wantTabId : ""));
}

// window.__desktopTest.tabId doesn't exist until F1/F3 land (it's the
// renderer's own copy of TAB-BOOT-SYNC's tabId) — harness plumbing ahead of
// that landing, not exercised by any case in this step.
async function tabIdOfTarget(cdp) {
  return evalPage(cdp, "(window.__desktopTest && window.__desktopTest.tabId) || null");
}

// A second CDP connection to one specific tab, alongside the app's primary
// one (e.g. the tab strip's) — used once multiple pages can be live at once.
async function connectTab(app, tabId) {
  const t = await findPageTarget(app.port, 30000, { tabId });
  const cdp = new CDPConn(t.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

// window.splitpageDesktop.__testShell(op, args) is F1's TEST_MODE-only main-
// process driver hook (create/close/move tabs etc. without real DOM/menu
// interaction) — not defined until F1 lands. Harness side implemented now
// per SMOKE-HARNESS so F1 is verifiable against it without touching this file.
async function shell(cdp, op, args) {
  return evalPage(cdp, "window.splitpageDesktop.__testShell(" + JSON.stringify(op) + ", " + JSON.stringify(args === undefined ? null : args) + ")");
}

// --- desktop/drafts.js on-disk layout (DRAFT-STORE), read directly rather
// than through any IPC — the harness must be able to see a draft that
// survived a real crash even though nothing is left alive to ask over CDP.
function parseDraftFile(p) {
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf8");
  const nl = text.indexOf("\n");
  const line1 = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? "" : text.slice(nl + 1);
  let header = null, state = null;
  try { header = JSON.parse(line1); } catch { /* corrupt/partial write */ }
  try { state = JSON.parse(rest); } catch { /* corrupt/partial write */ }
  return { header, state, bytes: Buffer.byteLength(text, "utf8") };
}

// { <tabId>: { dir, current, previous, baseFiles: [...] } } for every tab
// folder under <userDataDir>/drafts — corrupt/, .trash-* and .tmp-* entries
// (DRAFT-STORE's own transient/quarantine names) are not tab folders and are
// skipped.
function readDraftDirs(userDataDir) {
  const draftsRoot = path.join(userDataDir, "drafts");
  const out = {};
  if (!fs.existsSync(draftsRoot)) return out;
  for (const ent of fs.readdirSync(draftsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name === "corrupt" || ent.name.indexOf(".trash-") === 0 || ent.name.indexOf(".tmp-") === 0) continue;
    const tabDir = path.join(draftsRoot, ent.name);
    let files = [];
    try { files = fs.readdirSync(tabDir); } catch { continue; }
    out[ent.name] = {
      dir: tabDir,
      current: parseDraftFile(path.join(tabDir, "current.draft")),
      previous: parseDraftFile(path.join(tabDir, "previous.draft")),
      baseFiles: files.filter((f) => /^base-[0-9a-f]{12}\.json$/.test(f))
    };
  }
  return out;
}

// <userDataDir>/drafts/session.json — null for "doesn't exist yet" or
// "unparseable", exactly like DRAFT-STORE's own init() treats a missing file.
function readSession(userDataDir) {
  const p = path.join(userDataDir, "drafts", "session.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/* ----------------------------------------------------------------------
 * 1b. Step L2 extras: helpers the tab-shell cases below share. TAB-IDENTITY's
 *     tabId/windowId are 32 lowercase hex from crypto.randomBytes(16) — the
 *     v1-migration and restore-at-launch cases hand-write desktop-state.json
 *     themselves (rather than build a session live through the UI) and need
 *     ids in that exact shape so main's own normalizeDesktopStateV2 accepts
 *     them unchanged instead of minting replacements out from under the test.
 * -------------------------------------------------------------------- */

function newHexId() { return crypto.randomBytes(16).toString("hex"); }

// Hand-writes <userDataDir>/desktop-state.json (DESKTOP-STATE-V2 / v1) BEFORE
// a launch, so a case can control exactly what session main restores without
// driving a whole prior app run through the UI first.
function writeDesktopStateFile(userDataDir, state) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "desktop-state.json"), JSON.stringify(state), "utf8");
}

// Reads it back — null for "doesn't exist" or "unparseable", same convention
// as readSession above.
function readDesktopStateFile(userDataDir) {
  const p = path.join(userDataDir, "desktop-state.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// window.__desktopTest.markDirtyForTest() (20f-desktop.js) calls markDirty()
// directly with zero DOM interaction — see caseCloseAuthorityNoGesture's own
// comment on why that matters for a close/quit prompt to actually fire. Every
// L2 case that needs a dirty tab uses this same no-gesture path so a real
// user click is never required just to set up a precondition.
async function dirtyTabForTest(cdp) {
  await evalPage(cdp, "window.__desktopTest.markDirtyForTest(); true", { awaitPromise: false });
  await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
}

// Fire-and-forget __testShell call: for an op whose target tab or window may
// be destroyed as a direct RESULT of the call (closing the tab/window the
// calling page itself lives in) — same reasoning as fireEval's own comment.
// A normal awaited shell() would hang until CDPConn's own long sendTimeoutMs
// on exactly this case, since the reply can never arrive once the context is
// gone.
async function fireShell(cdp, op, args) {
  const expr = "window.splitpageDesktop.__testShell(" + JSON.stringify(op) + "," + JSON.stringify(args === undefined ? null : args) + ")";
  await fireEval(cdp, expr, { awaitPromise: false });
}

// Node-side poll (unlike poll() above, which evaluates an EXPRESSION on the
// page) — for waiting on a condition that itself has to run several page
// evals / CDP calls to compute, such as "a tab other than this known one has
// appeared". Swallows errors while polling, same as poll().
async function pollNode(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* keep polling */ }
    await sleep(intervalMs || 250);
  }
  throw new Error("pollNode: timed out (last value: " + JSON.stringify(last) + ")");
}

// Opens a fresh, independent CDP connection to a /json target object (as
// returned by findTargetsByKind), alongside whatever connection(s) a case
// already has open.
async function connectTarget(t) {
  const cdp = new CDPConn(t.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

// Polls __testShell('listTargets') (over ANY still-alive tab's connection —
// a witness tab in a window/tab that is not itself being closed) until
// `predicate` accepts the shell state, or times out.
async function pollShellState(cdp, predicate, timeoutMs) {
  return pollNode(async () => {
    const listing = await shell(cdp, "listTargets", {});
    return predicate(listing) ? listing : null;
  }, timeoutMs || 15000);
}

// Shared fixture for the close/quit multi-window cases below: window1 keeps
// the launch's own first tab plus a second tab created alongside it; a third
// tab is created and immediately torn off into its own new window2. Returns
// every id and a live CDP connection to each of the three tabs so a case can
// dirty/close/read any of them independently.
async function setupTwoDirtyWindows(target, opts) {
  const app = await launchApp(target, opts);
  await waitForRows(app.cdp, 20000);
  const tab1Id = await tabIdOfTarget(app.cdp);

  const tab2Id = await shell(app.cdp, "createTab", {});
  const cdp2 = await connectTab(app, tab2Id);
  await waitForRows(cdp2, 20000);

  const tab3Id = await shell(app.cdp, "createTab", {});
  const cdp3 = await connectTab(app, tab3Id);
  await waitForRows(cdp3, 20000);
  const window2Id = await shell(app.cdp, "moveTabToWindow", { tabId: tab3Id, windowId: null });

  const listing = await shell(app.cdp, "listTargets", {});
  const window1 = listing.windows.find((w) => w.tabs.some((t) => t.tabId === tab1Id));

  return {
    app, tab1Id, tab2Id, tab3Id,
    window1Id: window1 ? window1.windowId : null,
    window2Id,
    cdp1: app.cdp, cdp2, cdp3
  };
}

/* One spawn attempt: builds the env/flags/args for `target` against `port`
   and `userDataDir`, spawns it, and waits just long enough for an immediate
   ENOENT-style spawn error to surface. Split out of launchApp so a CDP-never-
   came-up retry (see launchApp) can spawn a fresh process on a fresh port
   without duplicating this setup. */
async function spawnAttempt(target, opts, userDataDir, port) {
  /* SPLITPAGE_TEST=1: the window never shows, unanswered dialogs cancel
     themselves, and a main-process crash exits with its stack on stderr
     instead of popping a modal error box on whoever's desktop this is.
     opts.env is merged in AFTER these built-in vars (so a case can override
     anything here, e.g. SPLITPAGE_NO_UPDATE_CHECK), but SPLITPAGE_TEST itself
     is re-pinned to "1" below no matter what opts.env said — it must never be
     the thing that lets an automated run show a real window on this machine. */
  const env = { ...process.env, SPLITPAGE_USER_DATA: userDataDir, SPLITPAGE_TEST: "1" };
  if (opts.allowUpdateCheck) delete env.SPLITPAGE_NO_UPDATE_CHECK;
  else env.SPLITPAGE_NO_UPDATE_CHECK = "1";
  if (opts.updateApi) env.SPLITPAGE_UPDATE_API = opts.updateApi;
  if (opts.env) Object.assign(env, opts.env);
  env.SPLITPAGE_TEST = "1";

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

  return { proc, dialogsPath, getStdout: () => stdout, getStderr: () => stderr };
}

/* opts: { flags:[], fixtures:[], dialogs:[]|null, userDataDir, dataDir,
           allowUpdateCheck:false, updateApi, label, env } */
async function launchApp(target, opts) {
  opts = opts || {};
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  if (!opts.userDataDir) fs.mkdirSync(userDataDir, { recursive: true });

  // A second instance that loses the single-instance lock calls app.quit()
  // before app.whenReady() ever runs — it never opens a --remote-debugging
  // port at all, so waiting on CDP here would just time out. Callers that
  // expect exactly that (case 7) ask for skipCdp and drive teardown/exit
  // detection off `proc` directly instead. That's also not a "CDP never came
  // up" failure, so it gets exactly one attempt, no retry.
  const maxAttempts = opts.skipCdp ? 1 : 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // freePort() only PROBES a port free and releases the listener straight
    // back — under two suite runs going at once (one per tree, per the
    // orchestrator's own concurrency rule) another process can grab that
    // same port in the gap before Electron binds its own listener. Retrying
    // with a freshly probed port recovers from that race instead of failing
    // the whole launch outright.
    const port = await freePort();
    const { proc, dialogsPath, getStdout, getStderr } = await spawnAttempt(target, opts, userDataDir, port);

    if (opts.skipCdp) {
      return {
        target, proc, port, userDataDir, dialogsPath, cdp: null, browserWsUrl: null,
        label: opts.label || "launch", getStdout, getStderr
      };
    }

    try {
      const verInfo = await waitForCdpReady(port, 30000);
      const pageTarget = await findPageTarget(port, 30000);
      const cdp = new CDPConn(pageTarget.webSocketDebuggerUrl);
      await cdp.open();
      return {
        target, proc, port, userDataDir, dialogsPath, cdp,
        browserWsUrl: verInfo.webSocketDebuggerUrl,
        label: opts.label || "launch",
        getStdout, getStderr
      };
    } catch (e) {
      lastErr = e;
      // PID-scoped kill, exactly like teardown() — never by image name, this
      // is someone's working computer and other launches (this tree's other
      // targets, or the other tree's own concurrent run) must be untouched.
      killPid(proc.pid);
      await waitForExit(proc, 10000);
      if (attempt >= maxAttempts) {
        throw new Error("launchApp: CDP never came up after " + attempt + " attempt(s) on " + target.name + ": " + (lastErr && lastErr.message || lastErr));
      }
      // else: loop retries with a fresh freePort() and a fresh spawn.
    }
  }
  throw lastErr || new Error("launchApp: exhausted attempts with no error recorded");
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
async function teardown(app, tag, opts) {
  opts = opts || {};
  const notes = [];
  try { app.cdp && app.cdp.close(); } catch {}
  if (app.cdp) await closeBrowserGracefully(app);
  let exited = await waitForExit(app.proc, 12000);
  if (!exited) {
    notes.push("did not exit after Browser.close; force-killed via taskkill");
    killPid(app.proc.pid);
    /* 30 s, not 10: taskkill /F is authoritative, but an x64 Electron tree
       under ARM64 emulation on a loaded machine (an installer build or the
       browser suite running alongside) can take well over 10 s to REPORT
       its exit — which once failed a case whose processes were all gone. */
    exited = await waitForExit(app.proc, 30000);
    if (!exited) notes.push("process still reported alive after taskkill");
  }
  // A packaged app's launcher exe can spawn a child renderer/utility process
  // tree under a different top pid than the one we spawned — search by the
  // user-data dir string (unique per launch) rather than trust one pid.
  // PID/userDataDir-scoped, same as killPid above — never by image name, so
  // a concurrent run (this tree's other targets, or the other tree's own
  // suite) is never touched.
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
    if (opts.expectExitCode !== undefined) {
      record(tag + ": exit code is " + opts.expectExitCode,
        app.proc.exitCode === opts.expectExitCode,
        "exitCode=" + app.proc.exitCode + " signal=" + app.proc.signalCode);
    }
  }
  return notes;
}

// Simulates a real crash: no CDP Browser.close negotiation at all, just a
// hard PID-scoped kill (same killPid as teardown's fallback path — never by
// image name) and a wait for the OS to actually report the process gone.
// Leaves app.userDataDir's drafts/session.json exactly as DRAFT-STORE's own
// crash-detection (previousSession !== 'clean-exit') expects to find it on
// the next launchApp({ userDataDir: app.userDataDir }).
async function crashApp(app) {
  killPid(app.proc.pid);
  const exited = await waitForExit(app.proc, 30000);
  try { app.cdp && app.cdp.close(); } catch {}
  return exited;
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
    // TAB-IDENTITY: every tab page is splitpage://app/index.html?tab=<32 hex>.
    // The exact-equality form this check used before F1 can never hold again —
    // the tabId in the query string is what findTargetsByKind/connectTab use to
    // tell one tab from another — so it is matched as a whole here instead,
    // which also proves the tabId is well formed (a stricter check, not a
    // looser one). Step L2 owns this file; this one line moved with F1 because
    // nothing else in the suite could pass until it did.
    record(tag + ": origin is splitpage://app/index.html with a tabId",
      /^splitpage:\/\/app\/index\.html\?tab=[0-9a-f]{32}$/.test(url), url);

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
  let secondTabCdp = null;
  try {
    first = await launchApp(target, { label: "first-instance", userDataDir, fixtures: [fixtureA] });
    await waitForRows(first.cdp, 20000);
    await poll(first.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("First Instance Doc"), 15000);
    const firstTabId = await tabIdOfTarget(first.cdp);

    second = await launchApp(target, { label: "second-instance", userDataDir, fixtures: [fixtureB], skipCdp: true });
    const secondExited = await waitForExit(second.proc, 15000);
    record(tag + ": second launch exits quickly (single-instance lock)", secondExited === true);

    // DOCUMENT-STATE-AND-ROUTING-IPC's route-open rule: the running instance's
    // tab already holds fixtureA, so it is no longer pristine
    // (isPristineSeedDocument() requires no file ever opened, 03a-history-
    // store.js) — routeOpenPath's "reuse this tab" branch therefore does NOT
    // apply, and the second file has to land in a brand-new tab, leaving the
    // first tab and its document completely untouched (TAB-IDENTITY). Before
    // F3 wired up real pristine reporting this landed in the SAME tab; see
    // F1's own deviations note on this exact case.
    const newTabTarget = await pollNode(async () => {
      const { tabTargets } = await findTargetsByKind(first.port);
      const extra = tabTargets.filter((t) => t.tabId && t.tabId !== firstTabId);
      return extra.length ? extra[0] : null;
    }, 20000);
    record(tag + ": the second file opens in a NEW tab, not the first (it is no longer pristine)", !!newTabTarget);

    if (newTabTarget) {
      secondTabCdp = await connectTarget(newTabTarget);
      const gotSecondDoc = await poll(secondTabCdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Second Instance Doc — 🚀"), 15000);
      record(tag + ": the new tab shows the second file's title", !!gotSecondDoc);
    } else {
      record(tag + ": the new tab shows the second file's title", false, "no new tab target appeared");
    }

    const firstStillA = await evalPage(first.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("First Instance Doc"));
    record(tag + ": the first tab's document is untouched", firstStillA === true, String(firstStillA));
  } finally {
    if (secondTabCdp) { try { secondTabCdp.close(); } catch {} }
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

// SMOKE-HARNESS: caseLastFileResume renamed caseSessionRestore for the tab
// shell — same flow (open a fixture via argv, save, teardown, relaunch with
// the same userDataDir, assert the title and row count), now proving
// DESKTOP-STATE-V2's own session restore (the tab this fixture landed in is
// written back to desktop-state.json as a file source on save, and
// restoreSessionAtLaunch recreates it) rather than the old single-window
// "last file" bookkeeping it used to exercise.
async function caseSessionRestore(target, fixturesDir) {
  const tag = target.name + " session restore";
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
    /* dialogs: ["confirm"] answers the "stop sharing and close" prompt that
       teardown's Browser.close raises — without it test mode answers Cancel,
       the app rightly stays open, and teardown can only force-kill it. */
    app = await launchApp(target, { label: "host", flags: ["--host", "--pin", "4821"], dataDir, dialogs: ["confirm"] });
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
   open).

   The close itself is driven through window.splitpageDesktop.__testRequestClose()
   (preload.js/main.js, TEST_MODE-only), NOT the page's own window.close().
   An experiment run while diagnosing this case proved those are not the
   same operation: a page-initiated window.close() asks Chromium's own
   beforeunload negotiation, which — with no user activation having ever
   happened — Chromium settles on its own without asking the main process
   at all, then tears the WebContents down directly. BrowserWindow's
   'close' event, which main.js's dirty check (lastDirtyByWebContents) lives
   entirely inside, never fires; only 'closed' does, after the fact. So a
   dirty, never-activated document closed with no prompt whenever the test
   used window.close(), REGARDLESS of what main.js's own close authority
   fix did — the fix was never being exercised at all.
   __testRequestClose() instead calls BrowserWindow#close() from the main
   process, exactly like a real user's title-bar X / Alt+F4 does
   (NativeWindow::Close() is that same call), which DOES fire 'close'. See
   main.js's own comment on splitpage:test-request-close for the full
   story, and caseCloseFromPageIsUnguarded below, which documents the
   window.close() behaviour this case used to (wrongly) rely on. */
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

    // First close request, no userGesture at all, driven through
    // __testRequestClose() -> main's BrowserWindow#close() -> the SAME
    // 'close' event a real title-bar X / Alt+F4 fires: dialogs[0] =
    // "cancel" -> the 'close' handler's own dirty check answers "Stay" ->
    // window stays open.
    await fireEval(cdp, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    await sleep(1500);
    const stillAliveAfterCancel = app.proc.exitCode === null;
    let pageStillThere = false;
    if (stillAliveAfterCancel) {
      const list = (await fetchJson(`http://127.0.0.1:${app.port}/json`, undefined, 4000).catch(() => ({ body: [] }))).body || [];
      pageStillThere = Array.isArray(list) && list.some((t) => t.type === "page");
    }
    record(tag + ": close is still prompted with no user gesture, and 'cancel' keeps the window open",
      stillAliveAfterCancel && pageStillThere,
      "exitCode=" + app.proc.exitCode + " pageStillThere=" + pageStillThere);

    // Second close request: dialogs[1] = "confirm" -> "Leave without saving"
    // -> the window actually closes, still with no gesture ever having
    // happened this session.
    await fireEval(cdp, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
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

/* Documents (rather than regression-tests a fix for) the OTHER close path:
   the page's OWN window.close(), fired with no user gesture. Confirmed by
   experiment while building caseCloseAuthorityNoGesture above: with no
   activation ever having happened, Chromium settles its beforeunload
   negotiation on its own, WITHOUT ever asking the main process, then tears
   the WebContents down directly — BrowserWindow's 'close' event never
   fires, so main.js's dirty check (which lives entirely in that handler)
   never runs, and a dirty document is lost with no prompt at all.
   Leaving this undefended is only safe because it is not a user-reachable
   path: src/js never calls window.close() anywhere (grep it) — every real
   close goes through the title bar / Alt+F4 (BrowserWindow#close(),
   exercised above via __testRequestClose) or File > Exit (app.quit(),
   exercised in caseQuitAuthorityNoGesture below). If src/js ever grows a
   call to window.close() (a "close this document" menu command, say),
   this check starts failing and the app would need the same main-process
   authority the real close path already has extended to that new caller
   too. No dialogs are pre-answered here — none should be consulted, since
   'close' never fires to ask them. */
async function caseCloseFromPageIsUnguarded(target) {
  const tag = target.name + " page-initiated window.close() (documented, not user-reachable)";
  let app = null;
  try {
    app = await launchApp(target, { label: "close-from-page-unguarded" });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await evalPage(cdp, "window.__desktopTest.markDirtyForTest(); true", { awaitPromise: false });
    await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
    await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");

    await fireEval(cdp, "window.close()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 20000);
    record(tag + ": closes immediately with no dialog and no chance to cancel, even though the document is dirty",
      exited === true && app.proc.exitCode === 0,
      "exited=" + exited + " exitCode=" + app.proc.exitCode);
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
  }
}

/* Same regression as caseCloseAuthorityNoGesture, but through the File >
   Exit path (role: "quit" -> app.quit(), main.js section 13) instead of a
   single window's close button. app.quit() asks every open BrowserWindow
   to close before the app actually exits, which fires the same
   win.on('close') handler this whole fix is about — this proves the
   authority holds on the quit path too, not only a direct window close. */
/* Regression case: a CANCELLED quit must leave the document server running.
   Electron emits 'before-quit' before it asks the windows to close, and a
   window's close handler can still cancel the quit (unsaved changes -> Stay).
   main.js used to kill the server in before-quit, so File ▸ Exit -> Stay left
   the app running with no server behind /api: sharing silently stopped and
   the Save the user stayed for could not reach it. The kill lives in
   'will-quit' now, which only fires once every window has really closed —
   the second half of this case proves it still happens then. */
async function caseQuitCancelKeepsServer(target) {
  const tag = target.name + " --library quit cancelled keeps the document server";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "quit-cancel-server", flags: ["--library"], dataDir, dialogs: ["cancel", "confirm"] });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);

    const before = await poll(cdp, "fetch('/api/health').then(function(r){return r.status;})", 15000);
    record(tag + ": /api/health is 200 before quitting", before === 200, "status=" + before);
    const info = await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");
    const port = info && info.port;

    await evalPage(cdp, "window.__desktopTest.markDirtyForTest(); true", { awaitPromise: false });
    await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
    // invoke round trip: main has processed the dirty report before the quit
    await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");

    // First quit: dialogs[0] = "cancel" -> Stay.
    await fireEval(cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await sleep(3000);
    record(tag + ": 'Stay' keeps the app running", app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);

    const viaProxy = await evalPage(cdp, "fetch('/api/health').then(function(r){return r.status;}).catch(function(){return 0;})");
    record(tag + ": /api/health through the app is still 200 after the cancelled quit", viaProxy === 200, "status=" + viaProxy);
    const direct = port
      ? await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.status).catch(() => 0)
      : 0;
    record(tag + ": the document server itself still answers on its port", direct === 200, "port=" + port + " status=" + direct);

    // Second quit: dialogs[1] = "confirm" -> the app really exits, and the
    // server goes with it (will-quit).
    await fireEval(cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": 'confirm' quits for real with exit code 0", exited === true && app.proc.exitCode === 0, "exitCode=" + app.proc.exitCode);
    if (port) {
      const closed = await portClosed(port, "127.0.0.1");
      record(tag + ": document server port closed after the real quit", closed === true, "port=" + port);
    } else {
      record(tag + ": document server port closed after the real quit", false, "no port was ever reported by getSessionInfo()");
    }
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
    rmrf(dataDir);
  }
}

async function caseQuitAuthorityNoGesture(target) {
  const tag = target.name + " quit authority (no user gesture anywhere)";
  let app = null;
  try {
    app = await launchApp(target, { label: "quit-authority-no-gesture", dialogs: ["cancel", "confirm"] });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await evalPage(cdp, "window.__desktopTest.markDirtyForTest(); true", { awaitPromise: false });
    await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
    await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");

    // First quit request, no userGesture at all: dialogs[0] = "cancel" ->
    // the 'close' handler answers "Stay" -> app.quit() aborts, process
    // stays alive.
    await fireEval(cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await sleep(1500);
    record(tag + ": quitting still prompts with no user gesture, and 'cancel' keeps the app alive",
      app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);

    // Second quit request: dialogs[1] = "confirm" -> the app actually
    // exits, still with no gesture ever having happened this session.
    await fireEval(cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 20000);
    record(tag + ": 'confirm' quits for real, still with no user gesture", exited === true);
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
    // "confirm": the stop-sharing prompt at teardown (see caseHostMode)
    app = await launchApp(target, { label: "host-auto-pin", flags: ["--host", "--pin"], dataDir, dialogs: ["confirm"] });
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
    // "confirm": the stop-sharing prompt at teardown (see caseHostMode)
    app = await launchApp(target, { label: "host-no-pin", flags: ["--host"], dataDir, dialogs: ["confirm"] });
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
 * 5b. Step L2 — the tab shell cases (SMOKE-HARNESS, TAB-IDENTITY,
 *     DESKTOP-STATE-V2, TAB-BOOT-SYNC, DOCUMENT-STATE-AND-ROUTING-IPC,
 *     TABSTRIP-BRIDGE, CLOSE-QUIT-LIFECYCLE). Every case launches through
 *     launchApp (SPLITPAGE_TEST=1), drives tab/window operations through
 *     window.splitpageDesktop.__testShell — the same functions the menu, the
 *     strip and drag-and-drop call in real use (invariant #33: no click ever
 *     has to land on this machine's screen) — and closes only through the
 *     TEST_MODE hooks (__testRequestClose/__testRequestQuit/__testShell
 *     closeTab), never a page window.close().
 * -------------------------------------------------------------------- */

/* "tabstrip origin: on the strip target, typeof window.splitpageDesktop ===
   'undefined'; window.splitpageTabStrip.readFile is undefined;
   fetch('splitpage://tabstrip/api/health') is 404" — TABSTRIP-BRIDGE. */
async function caseTabstripOrigin(target) {
  const tag = target.name + " tabstrip origin: no file/draft/history bridge, no /api proxy";
  let app = null;
  let stripCdp = null;
  try {
    app = await launchApp(target, { label: "tabstrip-origin" });
    await waitForRows(app.cdp, 20000);

    const stripTarget = await pollNode(async () => {
      const { tabStripTargets } = await findTargetsByKind(app.port);
      return tabStripTargets.length ? tabStripTargets[0] : null;
    }, 20000).catch(() => null);
    record(tag + ": the tab strip's own CDP target appears", !!stripTarget);
    if (!stripTarget) return;

    stripCdp = await connectTarget(stripTarget);
    await poll(stripCdp, "typeof window.splitpageTabStrip !== 'undefined'", 15000).catch(() => {});

    const noDesktopBridge = await evalPage(stripCdp, "typeof window.splitpageDesktop === 'undefined'");
    record(tag + ": window.splitpageDesktop is undefined on the strip origin", noDesktopBridge === true, String(noDesktopBridge));

    const noReadFile = await evalPage(stripCdp, "typeof (window.splitpageTabStrip && window.splitpageTabStrip.readFile) === 'undefined'");
    record(tag + ": window.splitpageTabStrip.readFile is undefined", noReadFile === true, String(noReadFile));

    const healthStatus = await evalPage(stripCdp, "fetch('splitpage://tabstrip/api/health').then(function(r){return r.status;}).catch(function(){return -1;})");
    record(tag + ": fetch('splitpage://tabstrip/api/health') is 404", healthStatus === 404, "status=" + healthStatus);
  } finally {
    if (stripCdp) { try { stripCdp.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* "Ctrl+T via __testShell createTab → a new pristine blank tab whose
   DESKTOP.launchIntent.type === 'blank'". */
async function caseCtrlTNewTab(target) {
  const tag = target.name + " Ctrl+T (__testShell createTab): a new pristine blank tab";
  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "ctrl-t-new-tab" });
    await waitForRows(app.cdp, 20000);

    const newTabId = await shell(app.cdp, "createTab", {});
    record(tag + ": createTab returns a well-formed tabId", typeof newTabId === "string" && /^[0-9a-f]{32}$/.test(newTabId), String(newTabId));
    if (typeof newTabId !== "string") return;

    cdp2 = await connectTab(app, newTabId);
    await pollNode(async () => (await tabIdOfTarget(cdp2)) === newTabId, 15000);
    const intentType = await evalPage(cdp2, "window.splitpageDesktop.launchIntent.type");
    record(tag + ": the new tab's DESKTOP.launchIntent.type is 'blank'", intentType === "blank", String(intentType));

    const listing = await shell(app.cdp, "listTargets", {});
    const w = listing.windows.find((x) => x.tabs.some((t) => t.tabId === newTabId));
    const t = w && w.tabs.find((tt) => tt.tabId === newTabId);
    record(tag + ": main records the new tab as pristine and not dirty",
      !!t && t.pristine === true && t.dirty === false, JSON.stringify(t));
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* "pristine reuse vs new tab: route a file open from a fresh tab → count
   stays 1; from a dirty tab → count 2 and the original is untouched" +
   "path dedupe: opening the same path twice → switches, no duplicate; also
   from a second window" + "second-instance argv → a tab in the running
   instance, same dedupe" — all three exercised through real second-instance
   launches (the actual DOCUMENT-STATE-AND-ROUTING-IPC path, not a stand-in),
   since routeOpenPath is exactly what app.on('second-instance') calls. */
async function caseTabRoutingRules(target, fixturesDir) {
  const tag = target.name + " routing: pristine reuse, dirty->new tab, path dedupe (same and cross window)";
  const fixtureA = writeFixture(fixturesDir, "case-route-a.splitpage", "Route A Doc", [["1", "2"]]);
  const fixtureB = writeFixture(fixturesDir, "case-route-b.splitpage", "Route B Doc — 🧭", [["3", "4"]]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));

  async function sendSecondInstance(fixturePath) {
    const port = await freePort();
    const flags = [`--remote-debugging-port=${port}`];
    const args = target.kind === "dev" ? [target.appPath, ...flags, fixturePath] : [...flags, fixturePath];
    const env = { ...process.env, SPLITPAGE_USER_DATA: userDataDir, SPLITPAGE_TEST: "1", SPLITPAGE_NO_UPDATE_CHECK: "1" };
    const proc = spawn(target.exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    await waitForExit(proc, 15000);
  }

  let app = null;
  let cdpB = null;
  try {
    app = await launchApp(target, { label: "routing-rules", userDataDir });
    await waitForRows(app.cdp, 20000);
    const tab1Id = await tabIdOfTarget(app.cdp);

    // --- pristine reuse: a fresh, never-touched tab absorbs the file ---
    await sendSecondInstance(fixtureA);
    const reused = await poll(app.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Route A Doc"), 15000).catch(() => null);
    record(tag + ": routing into a pristine tab reuses it (count stays 1)", !!reused);
    let listing = await shell(app.cdp, "listTargets", {});
    let totalTabs = listing.windows.reduce((n, w) => n + w.tabs.length, 0);
    record(tag + ": tab count is still 1 after the pristine reuse", totalTabs === 1, "total=" + totalTabs);

    // --- dirty tab: this same tab now holds a real file (no longer
    //     pristine) — dirty it explicitly too, then route a second file. It
    //     must land in a NEW tab, and the first tab must be untouched. ---
    await dirtyTabForTest(app.cdp);
    await sendSecondInstance(fixtureB);
    const newTabTarget = await pollNode(async () => {
      const { tabTargets } = await findTargetsByKind(app.port);
      const extra = tabTargets.filter((t) => t.tabId && t.tabId !== tab1Id);
      return extra.length ? extra[0] : null;
    }, 20000).catch(() => null);
    record(tag + ": routing from a dirty tab opens a NEW tab (count becomes 2)", !!newTabTarget);
    const tab1TitleStill = await evalPage(app.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Route A Doc"));
    record(tag + ": the original (dirty) tab is untouched", tab1TitleStill === true, String(tab1TitleStill));
    if (!newTabTarget) return;

    cdpB = await connectTarget(newTabTarget);
    // findTargetsByKind already parsed the tabId straight off the target's
    // own URL (?tab=<tabId>) — reading it there avoids a race against this
    // brand-new page's own preload/boot script actually having run yet,
    // which a page-side tabIdOfTarget() eval cannot avoid the moment after
    // the target first appears.
    const tabBId = newTabTarget.tabId;
    const gotB = await poll(cdpB, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Route B Doc — 🧭"), 15000).catch(() => null);
    record(tag + ": the new tab shows the second file's document", !!gotB);

    // --- path dedupe, same window: opening fixtureB again switches, no dup ---
    await sendSecondInstance(fixtureB);
    listing = await shell(app.cdp, "listTargets", {});
    totalTabs = listing.windows.reduce((n, w) => n + w.tabs.length, 0);
    record(tag + ": opening the same path again does not duplicate the tab (still 2)", totalTabs === 2, "total=" + totalTabs);
    let ownerWindow = listing.windows.find((w) => w.tabs.some((t) => t.tabId === tabBId));
    record(tag + ": the existing tab for that path is activated, not duplicated", !!ownerWindow && ownerWindow.activeTabId === tabBId, JSON.stringify(ownerWindow));

    // --- path dedupe, from a second window: move fixtureB's tab out, then
    //     open the same path again — it must still resolve to that tab,
    //     wherever it now lives, not spawn a third one. ---
    const newWindowId = await shell(app.cdp, "moveTabToWindow", { tabId: tabBId, windowId: null });
    record(tag + ": the tab moved into a new window", typeof newWindowId === "string");
    await sendSecondInstance(fixtureB);
    listing = await shell(app.cdp, "listTargets", {});
    totalTabs = listing.windows.reduce((n, w) => n + w.tabs.length, 0);
    record(tag + ": opening the same path from a second window still dedupes (still 2 tabs, 2 windows)",
      totalTabs === 2 && listing.windows.length === 2, JSON.stringify(listing.windows));
    ownerWindow = listing.windows.find((w) => w.tabs.some((t) => t.tabId === tabBId));
    record(tag + ": the tab in the second window is the one activated",
      !!ownerWindow && ownerWindow.windowId === newWindowId && ownerWindow.activeTabId === tabBId, JSON.stringify(ownerWindow));
  } finally {
    if (cdpB) { try { cdpB.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* "middle-click/close-tab on a clean tab closes with no dialog consumed; a
   dirty tab honours 'cancel' then 'confirm'" + "close-tab affects only that
   tab" (a driver and a witness tab are never touched throughout). __testShell
   closeTab(tabId) IS the middle-click/Ctrl+W path (requestCloseTab) per
   TABSTRIP-BRIDGE's own comment — not a stand-in for it. */
async function caseCloseTabCleanAndDirty(target) {
  const tag = target.name + " close-tab (same path as middle-click): clean vs dirty, only that tab";
  let app = null;
  let cdpWitness = null, cdpDirty = null;
  try {
    app = await launchApp(target, { label: "close-tab-clean-dirty", dialogs: ["cancel", "confirm"] });
    await waitForRows(app.cdp, 20000);
    const tab1Id = await tabIdOfTarget(app.cdp); // driver — never closed

    const witnessId = await shell(app.cdp, "createTab", {});
    cdpWitness = await connectTab(app, witnessId);
    await waitForRows(cdpWitness, 20000);

    // --- a CLEAN tab closes immediately, no dialog consumed ---
    const cleanId = await shell(app.cdp, "createTab", {});
    await shell(app.cdp, "closeTab", { tabId: cleanId });
    let listing = await shell(app.cdp, "listTargets", {});
    let allTabIds = listing.windows.flatMap((w) => w.tabs.map((t) => t.tabId));
    record(tag + ": closing a clean tab removes it immediately, no dialog needed", allTabIds.indexOf(cleanId) === -1, JSON.stringify(allTabIds));
    record(tag + ": the app is still running", app.proc.exitCode === null);

    // --- a DIRTY tab: 'cancel' keeps it, 'confirm' closes it. The clean-tab
    //     close above touched nothing unsaved, so it consumed no dialog
    //     answer — dialogs[0] is still 'cancel' here, proving that. ---
    const dirtyId = await shell(app.cdp, "createTab", {});
    cdpDirty = await connectTab(app, dirtyId);
    await waitForRows(cdpDirty, 20000);
    await dirtyTabForTest(cdpDirty);

    await shell(app.cdp, "closeTab", { tabId: dirtyId });
    listing = await shell(app.cdp, "listTargets", {});
    allTabIds = listing.windows.flatMap((w) => w.tabs.map((t) => t.tabId));
    record(tag + ": 'cancel' keeps the dirty tab open", allTabIds.indexOf(dirtyId) !== -1, JSON.stringify(allTabIds));

    await shell(app.cdp, "closeTab", { tabId: dirtyId });
    listing = await shell(app.cdp, "listTargets", {});
    allTabIds = listing.windows.flatMap((w) => w.tabs.map((t) => t.tabId));
    record(tag + ": 'confirm' closes the dirty tab for real", allTabIds.indexOf(dirtyId) === -1, JSON.stringify(allTabIds));

    record(tag + ": the driver and witness tabs were never touched",
      allTabIds.indexOf(tab1Id) !== -1 && allTabIds.indexOf(witnessId) !== -1, JSON.stringify(allTabIds));
  } finally {
    if (cdpWitness) { try { cdpWitness.close(); } catch {} }
    if (cdpDirty) { try { cdpDirty.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* "close-tab affects only that tab; the last tab closes the window; the last
   window quits with exit 0." */
async function caseLastTabClosesWindowLastWindowQuits(target) {
  const tag = target.name + " close-tab: last tab closes the window; last window quit exits 0";
  let app = null;
  try {
    app = await launchApp(target, { label: "last-tab-closes-window" });
    await waitForRows(app.cdp, 20000);
    const tab1Id = await tabIdOfTarget(app.cdp);

    const tab2Id = await shell(app.cdp, "createTab", {});
    await shell(app.cdp, "closeTab", { tabId: tab2Id });
    const listing = await shell(app.cdp, "listTargets", {});
    record(tag + ": closing a non-last tab affects only that tab",
      listing.windows.length === 1 && listing.windows[0].tabs.length === 1 && listing.windows[0].tabs[0].tabId === tab1Id,
      JSON.stringify(listing.windows));
    record(tag + ": the app is still running", app.proc.exitCode === null);

    // Closing the LAST tab of the only window closes the window, which
    // (being the only window) quits the app — fire-and-forget: the reply
    // can never arrive once this tab's own context is gone (fireShell, same
    // reasoning as fireEval's own comment on window.close()).
    await fireShell(app.cdp, "closeTab", { tabId: tab1Id });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": the last tab closing takes the window, and the last window quit exits 0",
      exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* "a window with 2 dirty tabs and another window open → one dialog; 'review'
   focuses the first dirty tab and cancels; 'confirm' closes only that
   window." */
async function caseWindowCloseTwoDirtyTabs(target) {
  const tag = target.name + " window close: 2 dirty tabs + another window open (one dialog)";
  let ctx = null;
  try {
    ctx = await setupTwoDirtyWindows(target, { label: "window-close-2-dirty", dialogs: ["review", "confirm"] });
    const { app, tab1Id, window1Id, cdp1, cdp2, cdp3 } = ctx;

    await dirtyTabForTest(cdp1);
    await dirtyTabForTest(cdp2);

    // First close attempt on window1 (2 unsaved tabs -> the scoped 3-button
    // dialog, CLOSE-QUIT-LIFECYCLE): dialogs[0] = "review" -> the first
    // unsaved tab (tab1, listed first in strip order) is activated and the
    // close is cancelled.
    await fireEval(cdp1, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    const afterReview = await pollShellState(cdp3, (l) => {
      const w1 = l.windows.find((w) => w.windowId === window1Id);
      return w1 && w1.tabs.length === 2 ? l : null;
    }, 15000).catch(() => null);
    record(tag + ": 'review' keeps window1 open with both dirty tabs",
      !!afterReview, afterReview ? "" : "window1 lost a tab or vanished after review");
    record(tag + ": the app is still running after 'review'", app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);
    const w1 = afterReview && afterReview.windows.find((w) => w.windowId === window1Id);
    record(tag + ": 'review' activates the first unsaved tab", !!w1 && w1.activeTabId === tab1Id, JSON.stringify(w1));

    // Second close attempt: dialogs[1] = "confirm" -> window1 closes (both
    // tabs go with it); window2, never touched, stays open.
    await fireEval(cdp1, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    const afterConfirm = await pollShellState(cdp3, (l) => (l.windows.every((w) => w.windowId !== window1Id) ? l : null), 20000).catch(() => null);
    record(tag + ": 'confirm' closes only window1", !!afterConfirm, afterConfirm ? "" : "window1 still present after 'confirm'");
    record(tag + ": the app is still running (window2 survives)", app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);
  } finally {
    if (ctx) {
      try { ctx.cdp2.close(); } catch {}
      try { ctx.cdp3.close(); } catch {}
      await teardown(ctx.app, tag);
      rmrf(ctx.app.userDataDir);
    }
  }
}

/* "quit with dirty tabs in two windows → exactly one answer consumed;
   'review' does not quit; 'confirm' → exit 0." One dirty tab per window. */
async function caseQuitTwoWindowsDirty(target) {
  const tag = target.name + " quit: dirty tabs in two windows (one answer per attempt)";
  let ctx = null;
  try {
    ctx = await setupTwoDirtyWindows(target, { label: "quit-2-windows-dirty", dialogs: ["review", "confirm"] });
    const { app, cdp1, cdp2, cdp3 } = ctx;

    await dirtyTabForTest(cdp1); // window1
    await dirtyTabForTest(cdp3); // window2

    await fireEval(cdp1, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await sleep(2000);
    record(tag + ": 'review' does not quit", app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);

    // If before-quit had wrongly consumed more than one dialog answer on the
    // first attempt, this second attempt would not see dialogs[1] ===
    // "confirm" and the quit would not go through — this assertion is what
    // "exactly one answer consumed" actually proves.
    await fireEval(cdp1, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": 'confirm' quits for real (exactly one answer per attempt was consumed)",
      exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);
  } finally {
    if (ctx) {
      try { ctx.cdp2.close(); } catch {}
      try { ctx.cdp3.close(); } catch {}
      await teardown(ctx.app, tag);
      rmrf(ctx.app.userDataDir);
    }
  }
}

/* "--host + quit: the stop-sharing prompt fires once at quit, not when
   closing a non-last window." Exactly one dialog answer in the whole run: if
   the hosting prompt wrongly fired at the non-last window's close, it would
   consume that single answer there, leaving the real quit's own hosting
   prompt with an empty cursor -> TEST_MODE default (Cancel) -> the quit
   would wrongly abort, and the final assertion below would fail — which is
   exactly what this case is proving does not happen. */
async function caseHostQuitStopSharingOnce(target) {
  const tag = target.name + " --host: stop-sharing prompt fires once at quit, not at a non-last close";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "host-quit-once", flags: ["--host", "--pin", "3344"], dataDir, dialogs: ["confirm"] });
    await waitForRows(app.cdp, 20000);
    await poll(app.cdp, "window.splitpageDesktop.getSessionInfo().then(function(i){ return (i && i.hosting) ? i : null; })", 20000);

    const tab2Id = await shell(app.cdp, "createTab", {});
    cdp2 = await connectTab(app, tab2Id);
    await waitForRows(cdp2, 20000);
    await shell(app.cdp, "moveTabToWindow", { tabId: tab2Id, windowId: null });

    // Close window2 (non-last, nothing unsaved): must ask nothing at all.
    await fireEval(cdp2, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    const afterClose = await pollShellState(app.cdp, (l) => (l.windows.length === 1 ? l : null), 15000).catch(() => null);
    record(tag + ": closing a non-last window with nothing unsaved asks nothing and just closes",
      !!afterClose, afterClose ? "" : "window2 did not close cleanly");
    record(tag + ": the app is still running after the non-last close", app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);

    // Quit the now-last window: the hosting prompt fires exactly once here.
    await fireEval(app.cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": quitting the last window asks the stop-sharing prompt once, then exits cleanly",
      exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(dataDir);
  }
}

/* "tear-off preserves live state: edit, __testShell moveTabToWindow null →
   same tabId, same content, no reload (a window.__marker set before the move
   survives)." moveTabToWindow re-parents the WebContentsView; it must never
   recreate it (invariant #42). */
async function caseTearOffPreservesState(target) {
  const tag = target.name + " tear-off preserves live tab state (no reload)";
  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "tear-off" });
    await waitForRows(app.cdp, 20000);

    const tab2Id = await shell(app.cdp, "createTab", {});
    cdp2 = await connectTab(app, tab2Id);
    await waitForRows(cdp2, 20000);

    await evalPage(cdp2,
      "(function(){ var b = document.querySelector('.add-row-btn'); if (b) b.click(); return !!b; })()",
      { userGesture: true });
    await poll(cdp2, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
    const rowsBefore = await evalPage(cdp2, "window.__splitpageFormats.state().rows.length");
    const marker = "preserved-" + Date.now();
    await evalPage(cdp2, "window.__marker = " + JSON.stringify(marker) + "; true", { awaitPromise: false });

    const newWindowId = await shell(app.cdp, "moveTabToWindow", { tabId: tab2Id, windowId: null });
    record(tag + ": the move creates a new window", typeof newWindowId === "string" && newWindowId.length === 32, String(newWindowId));

    // Same tabId, over the SAME CDP connection: a reload would have torn
    // cdp2's execution context (and window.__marker) down.
    const tabIdAfter = await tabIdOfTarget(cdp2);
    record(tag + ": the tab keeps the same tabId after the move", tabIdAfter === tab2Id, "before=" + tab2Id + " after=" + tabIdAfter);
    const markerAfter = await evalPage(cdp2, "window.__marker");
    record(tag + ": a marker set before the move survives it (no reload)", markerAfter === marker, "before=" + marker + " after=" + markerAfter);
    const rowsAfter = await evalPage(cdp2, "window.__splitpageFormats.state().rows.length");
    record(tag + ": the edited content survives the move unchanged", rowsAfter === rowsBefore, "before=" + rowsBefore + " after=" + rowsAfter);

    const listing = await shell(app.cdp, "listTargets", {});
    const w2 = listing.windows.find((w) => w.windowId === newWindowId);
    record(tag + ": the strip records the tab under its new window", !!w2 && w2.tabs.some((t) => t.tabId === tab2Id), JSON.stringify(w2));
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* "restore at launch: two windows with tabs + a deleted file → the
   composition, order and active tab are reproduced; the missing file is
   skipped with a restore-notice toast." desktop-state.json is hand-written
   (DESKTOP-STATE-V2) rather than built live through the UI, so the exact
   session main has to restore is fully under this case's control. */
async function caseRestoreAtLaunch(target, fixturesDir) {
  const tag = target.name + " restore at launch: two windows, order, active tab, missing file skipped";
  // Both of window1's tabs are real, existing files — NOT a blank tab:
  // restoreSessionAtLaunch drops a blank tab with no crash draft outright
  // (there is nothing to restore), so a blank tab only survives when it is
  // the SOLE tab left in its window (the "window left with nothing" fallback
  // a few lines further down in main.js). Two real files exercise
  // composition/order/active-tab without depending on that fallback at all.
  const fixtureKeep1 = writeFixture(fixturesDir, "case-restore-keep1.splitpage", "Restore Keep One", [["a", "b"]]);
  const fixtureKeep2 = writeFixture(fixturesDir, "case-restore-keep2.splitpage", "Restore Keep Two", [["g", "h"]]);
  const missingName = "case-restore-missing.splitpage";
  const fixtureMissing = path.join(fixturesDir, missingName);
  writeFixture(fixturesDir, missingName, "Restore Missing Doc", [["c", "d"]]);
  fs.unlinkSync(fixtureMissing); // real basename, but gone before this launch

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const win1Id = newHexId(), win2Id = newHexId();
  const tab1Id = newHexId(), tab2Id = newHexId(), tab3Id = newHexId();
  writeDesktopStateFile(userDataDir, {
    version: 2,
    windows: [
      {
        windowId: win1Id, bounds: null, maximized: false, activeTabId: tab2Id,
        tabs: [
          { tabId: tab1Id, source: { kind: "file", absPath: fixtureKeep1 }, lastKnownTitle: "Restore Keep One" },
          { tabId: tab2Id, source: { kind: "file", absPath: fixtureKeep2 }, lastKnownTitle: "Restore Keep Two" }
        ]
      },
      {
        windowId: win2Id, bounds: null, maximized: false, activeTabId: tab3Id,
        tabs: [
          { tabId: tab3Id, source: { kind: "file", absPath: fixtureMissing }, lastKnownTitle: "Restore Missing Doc" }
        ]
      }
    ]
  });

  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "restore-at-launch", userDataDir });
    // window1's active tab (tab2) is where the launch's one restore notice
    // is delivered (DOCUMENT-STATE-AND-ROUTING-IPC).
    cdp2 = await connectTab(app, tab2Id);

    const notice = await poll(cdp2,
      "(function(){ var t=document.querySelectorAll('.toast'); for (var i=0;i<t.length;i++){ if (t[i].textContent.indexOf(" + JSON.stringify(missingName) + ")!==-1 && /missing/i.test(t[i].textContent)) return t[i].textContent; } return null; })()",
      20000).catch(() => null);
    record(tag + ": the missing file is skipped with a restore-notice toast naming it", !!notice, String(notice));

    const listing = await shell(cdp2, "listTargets", {});
    record(tag + ": both windows are reproduced", listing.windows.length === 2, JSON.stringify(listing.windows.map((w) => w.windowId)));

    const w1 = listing.windows.find((w) => w.windowId === win1Id);
    record(tag + ": window1's composition and order are reproduced (tab1 then tab2)",
      !!w1 && w1.tabs.length === 2 && w1.tabs[0].tabId === tab1Id && w1.tabs[1].tabId === tab2Id,
      JSON.stringify(w1));
    record(tag + ": window1's active tab is reproduced (tab2, not tab1)",
      !!w1 && w1.activeTabId === tab2Id, JSON.stringify(w1 && w1.activeTabId));

    const w2 = listing.windows.find((w) => w.windowId === win2Id);
    record(tag + ": window2 survives with a blank replacement for its missing-file tab",
      !!w2 && w2.tabs.length === 1 && w2.tabs[0].path === null, JSON.stringify(w2));

    const bothTitles = await pollNode(async () => {
      const l = await shell(cdp2, "listTargets", {});
      const w = l.windows.find((x) => x.windowId === win1Id);
      const t1 = w && w.tabs.find((x) => x.tabId === tab1Id);
      const t2 = w && w.tabs.find((x) => x.tabId === tab2Id);
      return t1 && t2 && t1.title === "Restore Keep One" && t2.title === "Restore Keep Two" ? { t1, t2 } : null;
    }, 20000).catch(() => null);
    record(tag + ": both restored file tabs load their documents and report their real titles",
      !!bothTitles, JSON.stringify(bothTitles));
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* "v1→v2 migration: a hand-written v1 file → one window/one tab, version 2
   on disk; corrupt JSON boots like a fresh install." */
async function caseV1MigrationAndCorruptJson(target, fixturesDir) {
  const tagA = target.name + " v1 -> v2 migration on read, and version 2 on disk";
  const fixtureV1 = writeFixture(fixturesDir, "case-v1-migrate.splitpage", "V1 Migrated Doc", [["e", "f"]]);
  const userDataDirA = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  writeDesktopStateFile(userDataDirA, {
    lastFilePath: fixtureV1,
    windowBounds: { x: 40, y: 40, width: 1200, height: 800 },
    windowMaximized: false
  });
  let appA = null;
  try {
    appA = await launchApp(target, { label: "v1-migrate", userDataDir: userDataDirA });
    await waitForRows(appA.cdp, 20000);
    const migratedTitle = await poll(appA.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("V1 Migrated Doc"), 20000).catch(() => null);
    record(tagA + ": the v1 file's document opens", !!migratedTitle);

    const listing = await shell(appA.cdp, "listTargets", {});
    record(tagA + ": migrates to exactly one window with one tab",
      listing.windows.length === 1 && listing.windows[0].tabs.length === 1, JSON.stringify(listing.windows));

    const onDiskAfter = await pollNode(async () => {
      const s = readDesktopStateFile(userDataDirA);
      return s && s.version === 2 ? s : null;
    }, 20000).catch(() => null);
    record(tagA + ": desktop-state.json on disk is version 2 after the migrated session is saved", !!onDiskAfter, JSON.stringify(onDiskAfter));
  } finally {
    if (appA) { await teardown(appA, tagA); rmrf(appA.userDataDir); }
    rmrf(userDataDirA);
  }

  const tagB = target.name + " corrupt desktop-state.json boots like a fresh install";
  const userDataDirB = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  fs.mkdirSync(userDataDirB, { recursive: true });
  fs.writeFileSync(path.join(userDataDirB, "desktop-state.json"), "{ this is not valid JSON", "utf8");
  let appB = null;
  try {
    appB = await launchApp(target, { label: "corrupt-state", userDataDir: userDataDirB });
    await waitForRows(appB.cdp, 20000);
    const listing = await shell(appB.cdp, "listTargets", {});
    record(tagB + ": one window, one blank tab, exactly like a fresh install",
      listing.windows.length === 1 && listing.windows[0].tabs.length === 1 &&
      listing.windows[0].tabs[0].path === null && !listing.windows[0].tabs[0].isServerDoc,
      JSON.stringify(listing.windows));
  } finally {
    if (appB) { await teardown(appB, tagB); rmrf(appB.userDataDir); }
    rmrf(userDataDirB);
  }
}

/* "window.close() canary: grep src/js for 'window.close(' finds nothing (fs
   read in Node)." Pure source-text check — no launch, no target-dependent
   behaviour; runs once per target invocation but is cheap and idempotent. */
async function caseWindowCloseCanary() {
  const tag = "src/js window.close() canary";
  const srcDir = path.join(DESKTOP_DIR, "..", "src", "js");
  let files = [];
  try {
    files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
  } catch (e) {
    record(tag + ": src/js is readable", false, "exception: " + (e && e.message ? e.message : String(e)));
    return;
  }
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(srcDir, f), "utf8");
    if (text.indexOf("window.close(") !== -1) offenders.push(f);
  }
  record(tag + ": no window.close( call anywhere in src/js", offenders.length === 0, offenders.join(", "));
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
    ["session restore", () => caseSessionRestore(target, fixturesDir)],
    ["--library", () => caseLibraryMode(target)],
    ["--host --pin", () => caseHostMode(target)],
    ["--host --pin (auto-generated)", () => caseHostModeAutoPin(target)],
    ["--host with no --pin (warning)", () => caseHostModeNoPinWarning(target)],
    ["update status", () => caseUpdateStatus(target)],
    ["unsaved-changes close", () => caseUnsavedChangesClose(target)],
    ["close authority (no user gesture)", () => caseCloseAuthorityNoGesture(target)],
    ["page-initiated window.close() (documented)", () => caseCloseFromPageIsUnguarded(target)],
    ["quit authority (no user gesture)", () => caseQuitAuthorityNoGesture(target)],
    ["--library quit cancelled keeps the server", () => caseQuitCancelKeepsServer(target)],
    ["clean close (regression)", () => caseCleanClose(target)],
    // --- step L2: the tab shell ---
    ["tabstrip origin", () => caseTabstripOrigin(target)],
    ["Ctrl+T new tab (__testShell createTab)", () => caseCtrlTNewTab(target)],
    ["routing: pristine reuse / dirty->new tab / path dedupe", () => caseTabRoutingRules(target, fixturesDir)],
    ["close-tab: clean vs dirty, only that tab", () => caseCloseTabCleanAndDirty(target)],
    ["close-tab: last tab closes window, last window quits", () => caseLastTabClosesWindowLastWindowQuits(target)],
    ["window close: 2 dirty tabs + another window (one dialog)", () => caseWindowCloseTwoDirtyTabs(target)],
    ["quit: dirty tabs in two windows (one answer per attempt)", () => caseQuitTwoWindowsDirty(target)],
    ["--host + quit: stop-sharing prompt fires once", () => caseHostQuitStopSharingOnce(target)],
    ["tear-off preserves live tab state", () => caseTearOffPreservesState(target)],
    ["restore at launch: two windows, missing file skipped", () => caseRestoreAtLaunch(target, fixturesDir)],
    ["v1->v2 migration; corrupt JSON boots fresh", () => caseV1MigrationAndCorruptJson(target, fixturesDir)],
    ["window.close() canary (src/js grep)", () => caseWindowCloseCanary()]
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
