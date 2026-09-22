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
 *   node test/smoke.mjs --only-target dev      # the dev target alone
 *
 * On Linux there is no display, so the run needs one of its own:
 *
 *   xvfb-run -a node test/smoke.mjs --only-target dev
 *
 * The dev target runs on every platform (#89) — that is what exercises
 * main.js and preload.js where they are actually being changed. The
 * packaged targets are Windows-only, because dist/win-unpacked and
 * dist/win-arm64-unpacked are the only packaged output anything builds.
 * A handful of assertions probe Windows itself (MainWindowHandle); those
 * are SKIPped by name off Windows and listed in the run summary, never
 * silently dropped and never rewritten into something weaker.
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
  const out = { exe: null, onlyTarget: null, onlyGroup: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exe") out.exe = argv[++i];
    // Debugging-only, undocumented: restrict a default (no --exe) run to a
    // single named target (dev | packaged-x64 | packaged-arm64) without
    // having to comment code out. Not part of the public CLI contract.
    if (argv[i] === "--only-target") out.onlyTarget = argv[++i];
    /* Same spirit, for one group out of ~60 when a full run is 55 minutes:
       a case-insensitive substring of the group's name in runTargetSuite.
       A filtered run prints a loud banner and carries "GROUP FILTER" into
       the summary, because a partial run that read like a full one is the
       thing this file is not allowed to do. */
    if (argv[i] === "--only-group") out.onlyGroup = argv[++i];
  }
  return out;
}

const IS_WINDOWS = process.platform === "win32";

/* The dev Electron's executable is named differently on every platform —
   electron.exe, a bare electron, or the binary buried in Electron.app. Its
   own installer already records which one it unpacked, in
   node_modules/electron/path.txt, so read that rather than keep a second
   copy of the mapping here that could drift; the per-platform names below
   are only the fallback for a tree whose path.txt is missing. */
function devElectronExe() {
  const pkgDir = path.join(DESKTOP_DIR, "node_modules", "electron");
  const distDir = path.join(pkgDir, "dist");
  try {
    const recorded = fs.readFileSync(path.join(pkgDir, "path.txt"), "utf8").trim();
    if (recorded) return path.join(distDir, recorded);
  } catch { /* not installed, or installed by something that wrote no path.txt */ }
  if (IS_WINDOWS) return path.join(distDir, "electron.exe");
  if (process.platform === "darwin") return path.join(distDir, "Electron.app", "Contents", "MacOS", "Electron");
  return path.join(distDir, "electron");
}

function resolveTargets(exeOverride) {
  if (exeOverride) {
    const abs = path.resolve(exeOverride);
    return [{ name: "custom:" + path.basename(abs), kind: "packaged", exe: abs }];
  }
  const targets = [];
  const devExe = devElectronExe();
  if (fs.existsSync(devExe)) targets.push({ name: "dev", kind: "dev", exe: devExe, appPath: DESKTOP_DIR });
  /* Packaged discovery stays Windows-only on purpose: dist/*-unpacked/ holds
     Splitpage.exe and nothing builds any other packaged shape. Looking for
     them elsewhere would only ever find nothing. */
  if (IS_WINDOWS) {
    const x64Exe = path.join(DESKTOP_DIR, "dist", "win-unpacked", "Splitpage.exe");
    if (fs.existsSync(x64Exe)) targets.push({ name: "packaged-x64", kind: "packaged", exe: x64Exe });
    const arm64Exe = path.join(DESKTOP_DIR, "dist", "win-arm64-unpacked", "Splitpage.exe");
    if (fs.existsSync(arm64Exe)) targets.push({ name: "packaged-arm64", kind: "packaged", exe: arm64Exe });
  }
  return targets;
}

/* Extra Chromium switches a target needs on THIS platform, prepended to
   every spawn of it (launchApp's own and the three raw second-instance
   spawns alike).

   --no-sandbox, on Linux, for the DEV target only. Chromium's Linux sandbox
   needs either a setuid chrome-sandbox helper or unprivileged user
   namespaces; a dev tree's node_modules/electron/dist/chrome-sandbox is not
   setuid, and the containers this suite runs in (the cloud dev container and
   the CI runner) provide neither. Without it Electron refuses to start at
   all, so the choice is this switch or no Linux run.

   It is deliberately scoped to the dev target so it can never reach a
   packaged binary, and it is a test-harness launch argument only — nothing
   in main.js, electron-builder.yml or the installer passes it, so how the
   app SHIPS is untouched. It does weaken a real boundary in the process it
   applies to, which is why it is not applied more widely than it has to be. */
function platformFlagsFor(target) {
  if (target.kind === "dev" && process.platform === "linux") return ["--no-sandbox"];
  return [];
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
  let body;
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
    let files;
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
 * 1a. Step N extras: crash-safe-draft helpers shared by the cases at the
 *     bottom of this file. Real content changes (never window.__desktopTest's
 *     markDirtyForTest, which sets the dirty flag with no document content
 *     behind it) go through the SAME DOM path a person typing would: click
 *     the real "+ Add row" button, then set one cell's text and dispatch a
 *     real 'input' event so onRootInput -> syncFieldFromDom -> markDirty()
 *     runs exactly as it does for a keystroke (05-render.js/21-events.js).
 *     That is what lets a case assert the RESTORED document still holds a
 *     specific marker string, not merely that some dirty flag survived.
 * -------------------------------------------------------------------- */

// Clicks "+ Add row", waits for the new row to render, then sets the LAST
// visualText cell's content to `marker` and dispatches a real 'input' event
// — a genuine content edit, indistinguishable on disk from a person typing.
// Waits for the dirty indicator so the caller never races noteDraftChange().
async function addMarkerRow(cdp, marker) {
  // Counts actual editable-cell rows, never '#rows > *' — a document with
  // ZERO rows (a freshly-created server doc, among others) still renders one
  // empty-state placeholder child, which addRow() REPLACES rather than
  // supplements: '#rows > *'.length can stay unchanged across the very add
  // this is waiting for.
  const before = await evalPage(cdp, "document.querySelectorAll('#rows .cell-editable[data-field=\"visualText\"]').length");
  await evalPage(cdp, "(function(){ var b = document.querySelector('.add-row-btn'); if (b) b.click(); return true; })()", { awaitPromise: false });
  await poll(cdp, "document.querySelectorAll('#rows .cell-editable[data-field=\"visualText\"]').length > " + before, 10000);
  const expr = "(function(){ var cells = document.querySelectorAll('#rows .cell-editable[data-field=\"visualText\"]'); " +
    "var cell = cells[cells.length - 1]; if (!cell) return false; cell.textContent = " + JSON.stringify(marker) + "; " +
    "cell.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
  const ok = await evalPage(cdp, expr, { awaitPromise: false });
  await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
  return ok;
}

// DRAFT-RENDERER-API's window.__desktopTest.drafts.flushNow() — the same
// path main's splitpage:draft-flush drives, called directly so a case never
// has to wait out draftTiming.idle/max just to get a write on disk.
async function flushDraft(cdp) {
  return evalPage(cdp, "window.__desktopTest.drafts.flushNow()");
}

// TEST_MODE's splitpage:test-draft-status (DRAFT-IPC-AND-SHAPES). With no
// tabId this asks about the CALLING page's own tab; a case driving a crashed
// tab from a witness connection passes the crashed tab's id explicitly.
async function draftStatusFor(cdp, tabId) {
  return evalPage(cdp, "window.splitpageDesktop.__testDraftStatus(" + (tabId ? JSON.stringify(tabId) : "") + ")");
}

// window.__splitpageFormats.state().rows — true if any row's visualText
// contains `marker`. Reads the document's real content, not just a dirty
// flag, so a restore case can prove the RIGHT text came back.
function markerExpr(marker) {
  return "(function(){ var s = window.__splitpageFormats.state(); if (!s || !s.rows) return false; " +
    "return s.rows.some(function(r){ return (r.visualText || '').indexOf(" + JSON.stringify(marker) + ") !== -1; }); })()";
}
async function markerPresent(cdp, marker) {
  return evalPage(cdp, markerExpr(marker));
}
// Polls until the marker shows up (a restore is asynchronous — the merge/
// adopt/etc. runs after takeDraft() resolves) or the timeout elapses, in
// which case it resolves false rather than throwing (poll()'s own error
// message would just say "false", which tells a failed assertion nothing).
async function waitForMarker(cdp, marker, timeoutMs) {
  return poll(cdp, markerExpr(marker), timeoutMs || 20000).catch(() => false);
}

// main.js counts every dialog it would have shown (getSessionInfo().
// testDialogsSeen, TEST_MODE only). Read it before firing a close/quit/
// Save As, then wait for it to move: that is the moment the pre-answered
// (or defaulted-to-Cancel) prompt has been consumed and the app has made
// its decision — which is what the old fixed sleeps were guessing at.
async function dialogsSeen(cdp) {
  const info = await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");
  return (info && typeof info.testDialogsSeen === "number") ? info.testDialogsSeen : 0;
}
async function waitForDialogAnswered(cdp, before, timeoutMs) {
  return poll(cdp, "window.splitpageDesktop.getSessionInfo().then(function(i){ return i && i.testDialogsSeen > " + before + "; })", timeoutMs || 10000)
    .catch(() => false);
}

// Same "•" convention dirtyTabForTest already polls for, exposed as a
// one-shot read for cases that need to assert clean vs dirty after a restore.
async function isDirty(cdp) {
  return evalPage(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent.indexOf('\\u2022') !== -1); })()");
}

// Polls for a .toast whose text contains `substr`, returning its full text
// (or null on timeout) — never throws, so a case can assert absence too.
async function toastContaining(cdp, substr, timeoutMs) {
  return poll(cdp, "(function(){ var t = document.querySelectorAll('.toast'); for (var i = 0; i < t.length; i++) { " +
    "if (t[i].textContent.indexOf(" + JSON.stringify(substr) + ") !== -1) return t[i].textContent; } return null; })()",
    timeoutMs || 20000).catch(() => null);
}

// splitpage:test-crash-renderer (DRAFT-IPC-AND-SHAPES): kills this tab's
// renderer the way a real crash does (no clean-exit reason), so main's
// render-process-gone path runs for real. Fire-and-forget like every other
// call that ends the very page issuing it (see fireEval's own comment) — the
// renderer dies mid-request, so a reply can never arrive.
function crashRenderer(cdp) {
  return fireEval(cdp, "window.splitpageDesktop.__testCrashRenderer()", { awaitPromise: false });
}

// Recursively scans every file under `dir` for a literal substring — used by
// caseDraftNoSecrets to prove a PIN, a server token or a launch URL never
// reaches disk anywhere under drafts/ (DRAFT-IPC-AND-SHAPES: "The header
// never contains a PIN, token, session info or fileId").
function dirContainsText(dir, needle) {
  let found = null;
  (function walk(d) {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (found) return;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      let text;
      try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (text.indexOf(needle) !== -1) { found = p; return; }
    }
  })(dir);
  return found;
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

/* ----------------------------------------------------------------------
 * 1c. Step M extras: DOC-CLAIMS + HISTORY-IPC helpers shared by the new
 *     cases below. Every history call goes straight at
 *     window.splitpageDesktop.history* (the real bridge/IPC, HISTORY-IPC)
 *     rather than through window.__historyTest (03a-history-store.js's
 *     backend-agnostic wrapper) — the point of these cases is proving the
 *     real main-process implementation (desktop/main.js section 8b), not
 *     the renderer's dispatch to it.
 * -------------------------------------------------------------------- */

// 32 lowercase hex after "d" (DOC-ID-FORMAT) — Node-side so a case can name
// a docId before any document carrying it exists.
function randDocId() { return "d" + crypto.randomBytes(16).toString("hex"); }

/* DOC-CLAIMS' homeKey for a file-backed document, predicted Node-side so a
   case can compute the replacement id the app is about to choose without
   asking the app for it. It mirrors main.js's own rule exactly, INCLUDING
   the part that is platform-dependent: the resolved path is lower-cased on
   win32 only, because an NTFS path is case-insensitive and an ext4 one is
   not (main.js: `process.platform === "win32" ? resolved.toLowerCase() :
   resolved`). Hard-coding the lower-case half here made the prediction
   silently wrong everywhere but Windows. */
function fileHomeKey(p) {
  const resolved = path.resolve(p);
  return "file:" + (IS_WINDOWS ? resolved.toLowerCase() : resolved);
}

// HISTORY_SNAP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/ — lowercase hex keeps
// every generated id inside that shape without thinking about it further.
function randSnapId(prefix) {
  return (prefix || "s") + crypto.randomBytes(6).toString("hex");
}

// A HISTORY-IPC snapshot meta with sane defaults, override anything. atMs is
// stamped forward by main anyway when it would not sort after the bucket's
// current newest (historyStampAfter) — callers that care about ordering
// still pass a monotonic atMs so intent is clear from the fixture itself.
function historyMeta(overrides) {
  var now = Date.now();
  return Object.assign({
    id: randSnapId(), label: "snap", at: new Date(now).toISOString(), atMs: now,
    by: "smoke", rows: 1, title: "Doc", sizeBytes: 0, kind: "snapshot"
  }, overrides || null);
}

// Calls window.splitpageDesktop.<method>(...args) in the page and returns
// its resolved value, or throws (awaitPromise already rejects evalPage's own
// promise on an invoke rejection — exactly what HISTORY-IPC's "an invalid
// docId/meta/body makes the invoke reject" needs a case to observe).
async function historyCall(cdp, method, args) {
  var argsJson = (args || []).map(function (a) { return JSON.stringify(a === undefined ? null : a); }).join(",");
  return evalPage(cdp, "window.splitpageDesktop." + method + "(" + argsJson + ")");
}

// true if the call rejected (an invalid id, a malformed meta, …), false if
// it resolved — never throws itself, so a validation case can assert
// rejection without its own try/catch at every call site.
async function historyCallRejects(cdp, method, args) {
  try { await historyCall(cdp, method, args); return false; } catch { return true; }
}

// HISTORY-STORAGE's on-disk layout, read directly (never through IPC) so a
// case can see what main actually wrote — the same reason readDraftDirs
// reads DRAFT-STORE's files straight off disk instead of asking the app.
function historyBucketDirOnDisk(userDataDir, bucket) {
  return bucket === "_older"
    ? path.join(userDataDir, "history", "older")
    : path.join(userDataDir, "history", "docs", "d-" + bucket);
}
function historyIndexPathOnDisk(userDataDir, bucket) {
  return path.join(historyBucketDirOnDisk(userDataDir, bucket), "index.json");
}
function historySnapPathOnDisk(userDataDir, bucket, snapId) {
  return path.join(historyBucketDirOnDisk(userDataDir, bucket), "s-" + snapId + ".snap");
}
function readHistoryIndexOnDisk(userDataDir, bucket) {
  try { return JSON.parse(fs.readFileSync(historyIndexPathOnDisk(userDataDir, bucket), "utf8")); }
  catch { return null; }
}
// HISTORY-STORAGE's .snap format: "splitpage-snapshot 1", the meta JSON
// (no document id in it — the folder is the document), then the state JSON
// verbatim. Hand-written so a case can pre-seed a bucket before any launch
// (caseHistoryCorruptIndex, caseHistoryNewerFormatReadOnly).
function historySnapText(meta, stateJson) {
  return "splitpage-snapshot 1\n" + JSON.stringify(meta) + "\n" + stateJson;
}
function writeHistorySnapOnDisk(userDataDir, bucket, meta, stateJson) {
  var dir = historyBucketDirOnDisk(userDataDir, bucket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(historySnapPathOnDisk(userDataDir, bucket, meta.id), historySnapText(meta, stateJson), "utf8");
}
function writeHistoryFormatOnDisk(userDataDir, version) {
  var dir = path.join(userDataDir, "history");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "FORMAT"), String(version) + "\n", "utf8");
}

// Second-instance send, scoped to one userDataDir — same technique
// caseTabRoutingRules uses locally, promoted here so the new DOC-CLAIMS case
// can open A.md and B.md into two tabs of the SAME launch without a
// dedicated test-shell op for "open this path".
async function sendSecondInstanceTo(target, userDataDir, filePath) {
  const port = await freePort();
  const flags = [...platformFlagsFor(target), `--remote-debugging-port=${port}`];
  const args = target.kind === "dev" ? [target.appPath, ...flags, filePath] : [...flags, filePath];
  const env = { ...process.env, SPLITPAGE_USER_DATA: userDataDir, SPLITPAGE_TEST: "1", SPLITPAGE_NO_UPDATE_CHECK: "1" };
  const proc = spawn(target.exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForExit(proc, 15000);
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

  const flags = [...platformFlagsFor(target), `--remote-debugging-port=${port}`, ...(opts.flags || [])];
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
        throw new Error("launchApp: CDP never came up after " + attempt + " attempt(s) on " + target.name + ": " + (lastErr && lastErr.message || lastErr), { cause: e });
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

function win32ProcessesMatching(substrings) {
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

/* The POSIX stand-in for Win32_Process: [{ pid, ppid, cmdline }] for every
   process this user can see. /proc is preferred where it exists (Linux) —
   no external command at all, so nothing to be missing from a minimal
   container image — with `ps` as the fallback everywhere else (macOS).
   `cmdline` is the same thing the Windows query matches on, which is what
   makes "a process tagged with THIS launch's user-data dir" mean the same
   on both: Chromium passes --user-data-dir=<dir> to every child it spawns. */
function posixProcessTable() {
  if (fs.existsSync("/proc")) {
    const rows = [];
    let entries;
    try { entries = fs.readdirSync("/proc"); } catch { return rows; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let cmdline;
      try { cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8"); } catch { continue; }
      cmdline = cmdline.replace(/\0/g, " ").trim();
      let ppid = 0;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        /* field 2 is the comm, in parentheses, and may itself contain spaces
           and parentheses — so split what follows the LAST ')': state, ppid. */
        const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        ppid = Number(after[1]) || 0;
      } catch { /* exited between readdir and here */ }
      rows.push({ pid: Number(entry), ppid, cmdline });
    }
    return rows;
  }
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmdline: m[3] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function psProcessesMatching(substrings) {
  if (IS_WINDOWS) return win32ProcessesMatching(substrings);
  const needles = substrings.map((s) => s.toLowerCase()).filter(Boolean);
  if (!needles.length) return [];
  return posixProcessTable()
    .filter((p) => p.cmdline && needles.some((n) => p.cmdline.toLowerCase().includes(n)))
    .map((p) => String(p.pid));
}

/* taskkill /T /F, and its POSIX equivalent. There is no single POSIX call
   for "this process and its descendants": killing the process GROUP is the
   usual stand-in, but these children are spawned without `detached`, so they
   share this test runner's own group and a group kill would take the suite
   down with them. So walk the tree from the process table and SIGKILL it
   leaf-first, which is the order taskkill /T uses too. Scoped to one pid's
   descendants exactly like the Windows path — never by image name, so a
   concurrent run is never touched. */
function killPid(pid) {
  if (!pid || pid <= 1) return;
  if (IS_WINDOWS) {
    try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 10000 }); } catch {}
    return;
  }
  const byParent = new Map();
  for (const p of posixProcessTable()) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p.pid);
  }
  const tree = [];
  const walk = (id) => {
    for (const child of byParent.get(id) || []) {
      if (child === id || tree.includes(child)) continue;
      tree.push(child);
      walk(child);
    }
  };
  walk(pid);
  for (const id of tree.reverse()) { try { process.kill(id, "SIGKILL"); } catch {} }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

// document.visibilityState reads "visible" even in TEST_MODE (backgroundThrottling:false
// makes Electron report that) — it proves nothing about the screen. The only honest way to
// confirm no visible top-level window exists is to ask the OS: a process with no visible
// window has MainWindowHandle 0. The BrowserWindow's native HWND belongs to Electron's
// browser (main) process, not a renderer subprocess, so checking the pid we spawned is right
// for both dev and packaged targets.
//
// Genuinely Windows-only, and with no honest equivalent elsewhere: the point
// of the assertion is "nothing appeared on the developer's screen", which X11
// cannot be asked in the same way (and under Xvfb the answer would be
// meaningless anyway). Its one caller SKIPs it by name off Windows rather
// than asserting something weaker that would read as the same coverage.
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

/* Always: CDP Browser.close first (the clean path), then killPid's
   force-kill of the tree as a fallback (taskkill /T /F on Windows, a
   leaf-first SIGKILL walk on POSIX), then confirm from the process table
   that nothing naming this launch's user-data dir survives.

   Also always records two checks under `tag` (case 15 in the harness
   design applies to EVERY case, so it lives here once instead of being
   repeated at each of the ~10 call sites): that teardown left no orphaned
   process, and that this launch's stderr never printed a
   "[splitpage-test] uncaught" line — a main-process crash must fail the
   suite loudly even when the case's own assertions all happened to pass
   before the crash. `app.getStderr()` reads a closure over already-
   captured output, so it's safe to call after the process has exited. */
// Polls the process table until nothing tagged with this launch's user-data
// dir is left, or the deadline passes; returns whatever is still there.
async function waitForNoProcesses(userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let left = psProcessesMatching([userDataDir]);
  while (left.length && Date.now() < deadline) {
    await sleep(200);
    left = psProcessesMatching([userDataDir]);
  }
  return left;
}

async function teardown(app, tag, opts) {
  opts = opts || {};
  const notes = [];
  try { app.cdp && app.cdp.close(); } catch {}
  if (app.cdp) await closeBrowserGracefully(app);
  let exited = await waitForExit(app.proc, 12000);
  if (!exited) {
    notes.push("did not exit after Browser.close; force-killed via killPid");
    killPid(app.proc.pid);
    /* 30 s, not 10: taskkill /F is authoritative, but an x64 Electron tree
       under ARM64 emulation on a loaded machine (an installer build or the
       browser suite running alongside) can take well over 10 s to REPORT
       its exit — which once failed a case whose processes were all gone. */
    exited = await waitForExit(app.proc, 30000);
    if (!exited) notes.push("process still reported alive after the force-kill");
  }
  // A packaged app's launcher exe can spawn a child renderer/utility process
  // tree under a different top pid than the one we spawned — search by the
  // user-data dir string (unique per launch) rather than trust one pid.
  // PID/userDataDir-scoped, same as killPid above — never by image name, so
  // a concurrent run (this tree's other targets, or the other tree's own
  // suite) is never touched.
  const leftover = await waitForNoProcesses(app.userDataDir, 3000);
  if (leftover.length) {
    notes.push("leftover processes after teardown: " + leftover.join(","));
    leftover.forEach(killPid);
    const stillThere = await waitForNoProcesses(app.userDataDir, 3000);
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
    /* The POSIX half of expectExitCode: a process that died from a real
       signal has no exit code at all, so "how did it die" has to be asked
       the other way round there. Same strength of assertion, named in the
       platform's own terms — see caseHistoryCrashAfterBody's call site. */
    if (opts.expectSignal !== undefined) {
      record(tag + ": killed by " + opts.expectSignal,
        app.proc.signalCode === opts.expectSignal,
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
const skippedLines = [];

function record(name, ok, detail) {
  totalChecks++;
  if (ok) passedChecks++;
  const line = (ok ? "PASS" : "FAIL") + " - " + name + (detail ? " :: " + detail : "");
  console.log(line);
  if (!ok) failureLines.push(name + (detail ? " :: " + detail : ""));
}

/* A check or a whole group that CANNOT run here, recorded by name with the
   reason (#89). Deliberately not counted as a pass and not counted in
   totalChecks: a skip is absent coverage, and a run that printed the same
   "ALL PASS - n/n" as a full one would be worse than no run at all. Every
   skip is echoed again in the summary, so the tail of the output says what
   this machine did not test even when nothing failed. */
function skip(name, reason) {
  skippedLines.push(name + " :: " + reason);
  console.log("SKIP - " + name + " :: " + reason);
}

// The reason string every off-Windows skip in this file shares, so the
// summary groups them at a glance.
const WINDOWS_ONLY = "Windows-only probe (PowerShell/Win32), this run is on " + process.platform;

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

async function caseBootAndSecurity(target) {
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
    const seenBeforeSaveAs = await dialogsSeen(cdp);
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    await waitForDialogAnswered(cdp, seenBeforeSaveAs); // the cancelled dialog has been consumed
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

/* The same thing, but a release that HAS an installer for this machine, plus
   the asset itself and a SHA256SUMS for it. That is what lets the in-app
   download be driven for real: main.js allows a download from the update
   API's own origin precisely so a fork — or this — can serve one.

   The "installer" is a few KB of deterministic bytes, never executed: this
   case stops at "downloaded and verified". Running it is what
   runUpdateInstaller does, and a test must never install anything. */
async function startTinyReleaseServer(opts) {
  const noSums = !!(opts && opts.noSums);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = process.platform === "win32" ? "exe" : (process.platform === "darwin" ? "dmg" : "AppImage");
  const assetName = `SplitpageDesktopSetup-99.0.0-${arch}.${ext}`;
  const payload = Buffer.alloc(4096, 0x5a);
  const digest = crypto.createHash("sha256").update(payload).digest("hex");

  let base = "";
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/asset")) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payload.length) });
      res.end(payload);
      return;
    }
    if (req.url.startsWith("/sums")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${digest}  ${assetName}\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      tag_name: "v99.0.0",
      html_url: "https://example.com/r",
      assets: noSums
        /* A release that published no checksum at all — see
           caseUpdateNoChecksum. */
        ? [{ name: assetName, size: payload.length, browser_download_url: base + "/asset" }]
        : [
          { name: assetName, size: payload.length, browser_download_url: base + "/asset" },
          { name: "SHA256SUMS", size: 64, browser_download_url: base + "/sums" }
        ]
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  return { server, url: `${base}/repos/x/releases/latest`, assetName, size: payload.length };
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

    // main pushes every status change to the page now (splitpage:update-status),
    // so the notice should appear WITHOUT a reload: the launch check answers
    // after the page has already loaded and read the status once, and having
    // to reload to see it was the bug. Assert that before reloading anything.
    const barWithoutReload = await poll(app.cdp,
      "(function(){ var b = document.getElementById('update-bar'); return b && b.hidden === false; })()", 15000);
    record(tag + ": the notice appears without a reload, from main's push", !!barWithoutReload);

    // It must also survive a reload, which re-reads the in-memory status.
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

/* The in-app update download: a release that HAS an installer for this
   platform and architecture is offered as "Download" rather than a link, and
   pressing it fetches and verifies the file inside the app.

   It deliberately stops short of installing. runUpdateInstaller() spawns the
   downloaded installer and quits the app, which a test on someone's working
   machine must never do (invariant #33) — and it already refuses to in
   TEST_MODE, which is the last assertion here. */
async function caseUpdateDownload(target) {
  const tag = target.name + " update download";
  const mini = await startTinyReleaseServer();
  let app = null;
  try {
    app = await launchApp(target, { label: "update-download", allowUpdateCheck: true, updateApi: mini.url });
    await waitForRows(app.cdp, 20000);

    const status = await poll(app.cdp,
      "window.splitpageDesktop.getUpdateStatus().then(function(s){ return s.checking ? null : s; })", 20000);
    record(tag + ": the launch check finds the release", !!status && status.updateAvailable === true, JSON.stringify(status));
    record(tag + ": ...and recognises an installer for this machine",
      !!status && status.canInstall === true, JSON.stringify(status));

    // The bar offers Download, not a link out.
    const label = await poll(app.cdp,
      "(function(){ var b = document.getElementById('update-bar-action'); return b && !b.hidden ? b.textContent : null; })()", 15000);
    record(tag + ": the notice offers Download", label === "Download", String(label));

    const result = await evalPage(app.cdp, "window.splitpageDesktop.downloadUpdate()");
    record(tag + ": the download succeeds", !!result && result.ok === true, JSON.stringify(result));

    const after = await evalPage(app.cdp, "window.splitpageDesktop.getUpdateStatus()");
    const dl = (after && after.download) || {};
    record(tag + ": ...and reports it ready", dl.state === "ready", JSON.stringify(dl));
    record(tag + ": ...having received the whole file", dl.received === mini.size, JSON.stringify(dl));
    record(tag + ": ...verified against the published checksum", dl.verified === true, JSON.stringify(dl));

    // The file is on disk, under this launch's own userData — nothing was
    // written next to the app, and the page never learned the path.
    const updatesDir = path.join(app.userDataDir, "updates");
    const onDisk = fs.existsSync(path.join(updatesDir, mini.assetName));
    record(tag + ": the installer is in userData/updates", onDisk, updatesDir);
    record(tag + ": the page is never told the path",
      !JSON.stringify(after).includes(app.userDataDir), JSON.stringify(after.download));

    // The bar now offers the install, and asking for it is a no-op in a test.
    const label2 = await poll(app.cdp,
      "(function(){ var b = document.getElementById('update-bar-action'); return b && !b.hidden ? b.textContent : null; })()", 15000);
    record(tag + ": the notice offers Install and restart", label2 === "Install and restart", String(label2));
    const install = await evalPage(app.cdp, "window.splitpageDesktop.installUpdate()");
    record(tag + ": installing is refused in test mode, not performed",
      !!install && install.ok === true && install.testMode === true, JSON.stringify(install));
  } finally {
    if (app) {
      await teardown(app, tag);
      rmrf(app.userDataDir);
    }
    await new Promise((resolve) => mini.server.close(resolve));
  }
}

/* A release with no published checksum is REFUSED (#64).

   The downloaded file is the one thing this app will execute and it is not
   code-signed, so the checksum is the whole chain of trust. It used to be
   optional: no SHA256SUMS asset meant the download was simply accepted, on
   the strength of HTTPS to GitHub alone. Same fixture as the case above,
   minus the sums asset. */
async function caseUpdateNoChecksum(target) {
  const tag = target.name + " update without a checksum";
  const mini = await startTinyReleaseServer({ noSums: true });
  let app = null;
  try {
    app = await launchApp(target, { label: "update-no-sums", allowUpdateCheck: true, updateApi: mini.url });
    await waitForRows(app.cdp, 20000);

    const status = await poll(app.cdp,
      "window.splitpageDesktop.getUpdateStatus().then(function(s){ return s.checking ? null : s; })", 20000);
    record(tag + ": the launch check still finds the release", !!status && status.updateAvailable === true, JSON.stringify(status));

    const result = await evalPage(app.cdp, "window.splitpageDesktop.downloadUpdate()");
    record(tag + ": the download is refused", !!result && result.ok === false, JSON.stringify(result));
    record(tag + ": ...saying it has no published checksum",
      !!result && String(result.message || "").indexOf("checksum") !== -1, JSON.stringify(result));

    const after = await evalPage(app.cdp, "window.splitpageDesktop.getUpdateStatus()");
    const dl = (after && after.download) || {};
    record(tag + ": ...and the state is failed, never ready", dl.state === "failed", JSON.stringify(dl));

    /* Nothing executable is left behind: "ready" is the only state that lets
       the file be run, and a refused download is cleaned off disk. */
    const stillThere = fs.existsSync(path.join(app.userDataDir, "updates", mini.assetName));
    record(tag + ": ...and the file it fetched is not left on disk", !stillThere);

    const install = await evalPage(app.cdp, "window.splitpageDesktop.installUpdate()");
    record(tag + ": installing it is refused outright",
      !!install && install.ok === false && install.error === "not-downloaded", JSON.stringify(install));
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
    const seenBeforeClose = await dialogsSeen(cdp);
    await fireEval(cdp, "window.close()", { awaitPromise: false, userGesture: true });
    await waitForDialogAnswered(cdp, seenBeforeClose);
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

    const seenBeforeClose2 = await dialogsSeen(cdp2);
    await fireEval(cdp2, "window.close()", { awaitPromise: false, userGesture: true });
    await waitForDialogAnswered(cdp2, seenBeforeClose2); // the un-answered prompt defaulted to Stay
    const stillAlive2 = app2.proc.exitCode === null;
    record(tag + ": dirty close with NO pre-answered dialog stays open (test-mode default = Stay)",
      stillAlive2, "exitCode=" + app2.proc.exitCode);

    const checkName = tag + ": no visible top-level window appeared during the whole case (MainWindowHandle=0)";
    if (IS_WINDOWS) {
      const handle = getMainWindowHandle(app2.proc.pid);
      record(checkName, handle === 0, "handle=" + handle);
    } else {
      skip(checkName, WINDOWS_ONLY + " — MainWindowHandle has no X11 equivalent, and under Xvfb there is no real screen to have appeared on");
    }
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
    const seenBeforeClose = await dialogsSeen(cdp);
    await fireEval(cdp, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    await waitForDialogAnswered(cdp, seenBeforeClose);
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
    const seenBeforeQuit = await dialogsSeen(cdp);
    await fireEval(cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await waitForDialogAnswered(cdp, seenBeforeQuit);
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
    const seenBeforeQuit = await dialogsSeen(cdp);
    await fireEval(cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await waitForDialogAnswered(cdp, seenBeforeQuit);
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
    const flags = [...platformFlagsFor(target), `--remote-debugging-port=${port}`];
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
   fetch('splitpage://tabstrip/api/health') is refused or 404" — TABSTRIP-BRIDGE. */
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

    /* TABSTRIP-BRIDGE asked for a 404 here: /api/* is deliberately not
       special-cased for the strip's host in registerProtocol(), so the
       request falls through to "not found" and the strip has no proxy to the
       document server. Since #65 the strip's own response headers also carry
       connect-src 'none', so the request is refused one layer EARLIER — it
       never leaves the page, and the fetch REJECTS instead of resolving with
       a status. That is strictly more than the original check claimed, so it
       is asserted as what it now is (the violated directive, read off the
       page's own securitypolicyviolation event) rather than relaxed into
       "didn't come back 200". Nothing had run this assertion since #65
       landed the header — that is the gap #89 is about. */
    const apiAttempt = await evalPage(stripCdp,
      "new Promise(function(resolve){" +
      "  var out = { outcome: null, violated: null, blocked: null };" +
      "  document.addEventListener('securitypolicyviolation', function(e){" +
      "    out.violated = e.violatedDirective; out.blocked = e.blockedURI;" +
      "  }, { once: true });" +
      "  fetch('splitpage://tabstrip/api/health').then(" +
      "    function(r){ out.outcome = 'status:' + r.status; }," +
      "    function(){ out.outcome = 'refused'; });" +
      "  setTimeout(function(){ resolve(out); }, 2000);" +
      "})");
    record(tag + ": fetch('splitpage://tabstrip/api/health') never leaves the strip — refused by its own connect-src 'none' (#65)",
      !!apiAttempt && apiAttempt.outcome === "refused" && apiAttempt.violated === "connect-src",
      JSON.stringify(apiAttempt));
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
    const flags = [...platformFlagsFor(target), `--remote-debugging-port=${port}`];
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
    const { app, cdp1, cdp3 } = ctx;

    await dirtyTabForTest(cdp1); // window1
    await dirtyTabForTest(cdp3); // window2

    const seenBeforeReview = await dialogsSeen(cdp1);
    await fireEval(cdp1, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await waitForDialogAnswered(cdp1, seenBeforeReview);
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

/* Recent documents (DESKTOP-RECENTS, issue #15): the list the New Tab page's
   third column draws. Restoring two file tabs records both; the bridge lists
   them with a name, a title and an opaque id but NO PATH (invariant #34);
   per-entry remove and "clear" both land on disk; the cap, the de-duplication
   and a relative path are enforced on read; and reopening an entry whose file
   has since been deleted rejects rather than failing silently. */
async function caseRecentDocuments(target, fixturesDir) {
  const tag = target.name + " recents: recorded, listed without paths, removable, capped";
  const fixtureA = writeFixture(fixturesDir, "case-recent-a.splitpage", "Recent Doc A", [["a", "b"]]);
  const fixtureB = writeFixture(fixturesDir, "case-recent-b.splitpage", "Recent Doc B", [["c", "d"]]);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const winId = newHexId();
  const tabAId = newHexId(), tabBId = newHexId();
  writeDesktopStateFile(userDataDir, {
    version: 2,
    windows: [{
      windowId: winId, bounds: null, maximized: false, activeTabId: tabAId,
      tabs: [
        { tabId: tabAId, source: { kind: "file", absPath: fixtureA }, lastKnownTitle: "Recent Doc A" },
        { tabId: tabBId, source: { kind: "file", absPath: fixtureB }, lastKnownTitle: "Recent Doc B" }
      ]
    }]
  });

  let app = null;
  let cdp = null;
  try {
    app = await launchApp(target, { label: "recents", userDataDir });
    cdp = await connectTab(app, tabAId);

    // Both restored tabs report their documents, so both are recorded with
    // their real titles. Most recent first — whichever loaded last is in
    // front, so this asserts the SET and the titles, not the order.
    const listed = await poll(cdp,
      "window.splitpageDesktop.listRecents().then(function(r){ return r.length === 2 ? r : null; })", 20000);
    const names = listed.map((r) => r.name).sort();
    record(tag + ": both restored documents are on the list, by file name",
      names.length === 2 && names[0] === "case-recent-a.splitpage" && names[1] === "case-recent-b.splitpage",
      JSON.stringify(names));

    const titles = await pollNode(async () => {
      const r = await evalPage(cdp, "window.splitpageDesktop && window.splitpageDesktop.listRecents()");
      if (!Array.isArray(r)) return null;
      const t = r.map((x) => x.title).sort();
      return t[0] === "Recent Doc A" && t[1] === "Recent Doc B" ? t : null;
    }, 20000).catch(() => null);
    record(tag + ": each entry carries the title the document actually reported",
      !!titles, JSON.stringify(titles));

    // INVARIANT #34: an entry is a name, a title, a time and an opaque id.
    // Nothing in it may be (or contain) a path — not even the fixtures dir.
    // Polled, not a bare evalPage: on a loaded machine the view can still be
    // swapping in a fresh document when this runs, and `window.splitpageDesktop`
    // is momentarily undefined — the same reason every other read in this
    // case goes through poll/pollNode.
    const current = await poll(cdp,
      "window.splitpageDesktop && window.splitpageDesktop.listRecents().then(function(r){ return r.length ? r : null; })", 20000);
    const keys = Object.keys(current[0] || {}).sort().join(",");
    record(tag + ": an entry is exactly {at, fileId, name, title} and nothing else",
      keys === "at,fileId,name,title", keys);
    const serialized = JSON.stringify(current);
    record(tag + ": no path, and no fragment of one, reaches the page",
      serialized.indexOf(fixturesDir) === -1 && serialized.indexOf(path.sep + "case-recent-a") === -1,
      serialized.slice(0, 400));
    record(tag + ": each fileId is an opaque 32-hex registry key, never a name",
      current.every((r) => /^[0-9a-f]{32}$/.test(r.fileId)), JSON.stringify(current.map((r) => r.fileId)));

    // It is on disk, in desktop-state.json beside the windows.
    const onDisk = await pollNode(async () => {
      const st = readDesktopStateFile(userDataDir);
      return st && Array.isArray(st.recents) && st.recents.length === 2 ? st : null;
    }, 20000).catch(() => null);
    record(tag + ": the list is persisted in desktop-state.json", !!onDisk,
      JSON.stringify(onDisk && onDisk.recents));

    // Per-entry remove: the call answers with the list as it stands after.
    const targetId = current.find((r) => r.name === "case-recent-a.splitpage").fileId;
    const afterRemove = await pollNode(async () =>
      evalPage(cdp, "window.splitpageDesktop.removeRecent(" + JSON.stringify(targetId) + ")"), 20000);
    record(tag + ": removing one entry leaves the other",
      afterRemove.length === 1 && afterRemove[0].name === "case-recent-b.splitpage",
      JSON.stringify(afterRemove));
    const diskAfterRemove = await pollNode(async () => {
      const st = readDesktopStateFile(userDataDir);
      return st && Array.isArray(st.recents) && st.recents.length === 1 ? st : null;
    }, 15000).catch(() => null);
    record(tag + ": the removal reaches disk", !!diskAfterRemove,
      JSON.stringify(diskAfterRemove && diskAfterRemove.recents));

    // An id main does not know removes nothing and does not throw.
    const forged = await pollNode(async () =>
      evalPage(cdp, "window.splitpageDesktop.removeRecent(" + JSON.stringify("f".repeat(32)) + ")"), 20000)
      .catch(() => null);
    record(tag + ": an unknown fileId removes nothing and does not throw",
      Array.isArray(forged) && forged.length === 1, JSON.stringify(forged));

    // Reopening an entry whose file is gone rejects — the case the column
    // turns into "that file isn't there any more".
    const goneId = afterRemove[0].fileId;
    fs.unlinkSync(fixtureB);
    const rejected = await poll(cdp,
      "window.splitpageDesktop && window.splitpageDesktop.routeOpen({kind:'file', fileId:" + JSON.stringify(goneId) + "})" +
      ".then(function(){ return 'resolved'; }, function(){ return 'rejected'; })", 20000);
    record(tag + ": reopening a deleted file rejects rather than opening nothing",
      rejected === "rejected", String(rejected));

    // Clear everything.
    const afterClear = await pollNode(async () => {
      const r = await evalPage(cdp, "window.splitpageDesktop.clearRecents()");
      return Array.isArray(r) ? { r } : null;
    }, 20000).then((x) => x.r);
    record(tag + ": clear empties the list", Array.isArray(afterClear) && afterClear.length === 0,
      JSON.stringify(afterClear));
    const diskAfterClear = await pollNode(async () => {
      const st = readDesktopStateFile(userDataDir);
      return st && Array.isArray(st.recents) && st.recents.length === 0 ? st : null;
    }, 15000).catch(() => null);
    record(tag + ": the clear reaches disk", !!diskAfterClear,
      JSON.stringify(diskAfterClear && diskAfterClear.recents));
  } finally {
    if (cdp) { try { cdp.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }

  // --- the read-side rules, from a hand-written file -----------------------
  const tagB = target.name + " recents: capped at 20, de-duplicated, relative paths dropped";
  const userDataDirB = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const winIdB = newHexId(), tabIdB = newHexId();
  const many = [];
  for (let i = 0; i < 25; i++) {
    many.push({ absPath: path.join(fixturesDir, "many-" + i + ".splitpage"), title: "Many " + i, at: 1000 + i });
  }
  // A duplicate of the first, a relative path, and two shapes that are not
  // entries at all — none of which may survive the read.
  many.splice(3, 0, { absPath: many[0].absPath, title: "Duplicate", at: 9999 });
  many.push({ absPath: "not-absolute.splitpage", title: "Relative", at: 9999 });
  many.push(null, { title: "No path at all" });
  writeDesktopStateFile(userDataDirB, {
    version: 2,
    windows: [{
      windowId: winIdB, bounds: null, maximized: false, activeTabId: tabIdB,
      tabs: [{ tabId: tabIdB, source: { kind: "blank" }, lastKnownTitle: "" }]
    }],
    recents: many
  });

  let appB = null;
  let cdpB = null;
  try {
    appB = await launchApp(target, { label: "recents-cap", userDataDir: userDataDirB });
    cdpB = await connectTab(appB, tabIdB);
    const read = await poll(cdpB,
      "window.splitpageDesktop && window.splitpageDesktop.listRecents().then(function(r){ return r.length ? r : null; })", 20000);
    record(tagB + ": capped at 20 entries", read.length === 20, String(read.length));
    const readNames = read.map((r) => r.name);
    record(tagB + ": the duplicate is collapsed to its first (most recent) entry",
      readNames.filter((n) => n === "many-0.splitpage").length === 1, JSON.stringify(readNames));
    record(tagB + ": file order is preserved (most recent first)",
      readNames[0] === "many-0.splitpage" && readNames[1] === "many-1.splitpage",
      JSON.stringify(readNames.slice(0, 3)));
    record(tagB + ": a relative path and a malformed entry are dropped",
      readNames.indexOf("not-absolute.splitpage") === -1 && read.every((r) => !!r.name),
      JSON.stringify(readNames));
  } finally {
    if (cdpB) { try { cdpB.close(); } catch {} }
    if (appB) { await teardown(appB, tagB); rmrf(appB.userDataDir); }
    rmrf(userDataDirB);
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

/* ----------------------------------------------------------------------
 * 5b. Step M: document id + desktop history smoke cases.
 * -------------------------------------------------------------------- */

/* caseAtomicSaveKeepsBirthtime. Measured, then held against the code.
   chooseDuplicateLoser's win32 rule (DOC-CLAIMS) used to judge "which of two
   identical files is the copy" on birthtime, which only works if an ordinary
   Save-in-place — atomicWrite's write-a-temp-then-rename-over — leaves the
   file's creation time alone. NTFS is documented to carry the destination's
   creation time across such a rename (file tunnelling); on Windows 11 here
   it does not, and every save moves birthtime forward by the elapsed time.
   The rule is therefore gone — #76 deleted the branch and the stat that fed
   it, so shared/doc-id-policy.js's chooseDuplicateLoser decides on the seq
   alone — and this case no longer asserts the filesystem behaves one way. It
   asserts the two AGREE: whatever the filesystem does to birthtime, the real
   verdict must not be fooled by it. That is the guard against a birthtime
   rule being written back in on a machine where saves still re-date files.
   The claims below still carry a birthtimeMs for exactly that reason: the
   hook drops it, and a rule that started reading one again would fail here. */
async function caseAtomicSaveKeepsBirthtime(target, fixturesDir) {
  /* The function keeps step M's name for traceability; the reported tag says
     what it actually asserts now, so a PASS line never reads as a claim that
     birthtime was preserved when the measurement below says it was not. */
  const tag = target.name + " save-in-place birthtime agrees with the duplicate rule";
  const aPath = path.join(fixturesDir, "case-m-birthtime-a.md");
  let app = null;
  try {
    app = await launchApp(target, { label: "atomic-save-birthtime", dialogs: [aPath] });
    await waitForRows(app.cdp, 20000);

    // "open A.md": create it through the app's own Save As (guarantees a
    // byte-exact Markdown project — a hand-written fixture risks the table
    // and the data block's row counts disagreeing, which pops the real
    // #md-rows-modal in-page confirm and would hang this case, invariant
    // #33's "never trigger one" included), then treat this tab exactly as
    // "A.md is open": the tab's "file" home is bound to aPath from here on,
    // same as if the file had been opened from disk.
    await evalPage(app.cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    let saveAsOk = false;
    for (let i = 0; i < 30 && !saveAsOk; i++) {
      if (fs.existsSync(aPath)) saveAsOk = true; else await sleep(250);
    }
    record(tag + ": setup — Save As creates A.md", saveAsOk);
    if (!saveAsOk) return;
    await sleep(300); // let the save fully settle (file home retargeted, clean)

    const stBefore = fs.statSync(aPath);
    const birthtimeBefore = stBefore.birthtimeMs;

    await sleep(2500);

    // Save in place: no saveAs, reuses the handle Save As just retargeted to.
    await evalPage(app.cdp, "window.__splitpageFormats.save()");
    let onDiskAfter = null;
    for (let i = 0; i < 20 && onDiskAfter === null; i++) {
      try { onDiskAfter = fs.readFileSync(aPath, "utf8"); } catch { await sleep(250); }
    }
    record(tag + ": save-in-place writes A.md again", !!onDiskAfter);

    const stAfter = fs.statSync(aPath);
    const birthtimeAfter = stAfter.birthtimeMs;
    const preserved = birthtimeBefore === birthtimeAfter;

    /* Ask the real function what it would do with two claims on one docId
       whose birthtimes say the opposite of their seq order: file A was
       created first and adopted the id first (seq 1) but was saved since, so
       it now carries the LATER birthtime. Trusting birthtime here names A —
       the document the user has been working in — as the copy. */
    const older = { docId: "d" + "a".repeat(32), homeKey: "file:c:\\x\\a.md", seq: 1, birthtimeMs: 2_000_000 };
    const newer = { docId: "d" + "a".repeat(32), homeKey: "file:c:\\x\\b.md", seq: 2, birthtimeMs: 1_000_000 };
    const verdict = await evalPage(app.cdp,
      "window.splitpageDesktop.__testDupLoser(" + JSON.stringify(older) + "," + JSON.stringify(newer) + ")");
    const mirrored = await evalPage(app.cdp,
      "window.splitpageDesktop.__testDupLoser(" + JSON.stringify(newer) + "," + JSON.stringify(older) + ")");

    record(tag + ": save-in-place " + (preserved ? "PRESERVES" : "MOVES") +
      " the file's birthtime on this filesystem, and chooseDuplicateLoser's rule " +
      "is consistent with that (a rule that trusts birthtime needs it preserved)",
      preserved || verdict === "b",
      "before=" + birthtimeBefore + " after=" + birthtimeAfter + " loser=" + verdict);

    /* Symmetry is the property that keeps BOTH tabs from re-iding, so it is
       worth asserting on the same pair from both sides. */
    record(tag + ": the verdict is symmetric — the same claim loses whichever way round it is asked",
      verdict !== null && mirrored !== null && verdict !== mirrored,
      "a,b=" + verdict + " b,a=" + mirrored);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* caseDuplicateDocIdAcrossTabs. DOC-CLAIMS end to end against a real main
   process: two tabs open byte-identical files (one a real fs.copyFileSync of
   the other, exactly like copying a file in Explorer), the copy is told to
   re-id, and — orchestrator override §1 — nothing is written to disk on its
   own. */
async function caseDuplicateDocIdAcrossTabs(target, fixturesDir) {
  const tag = target.name + " duplicate document id across tabs (DOC-CLAIMS)";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const aPath = path.join(fixturesDir, "case-m-dup-a.md");
  const bPath = path.join(fixturesDir, "case-m-dup-b.md");
  let app = null;
  let cdpB = null;
  try {
    app = await launchApp(target, { label: "dup-doc-id", userDataDir, dialogs: [aPath] });
    await waitForRows(app.cdp, 20000);
    const tabAId = await tabIdOfTarget(app.cdp);

    // "save A.md through the app": Save As from the launch's own blank
    // pristine tab, for the same "must be a byte-exact project file" reason
    // as caseAtomicSaveKeepsBirthtime above.
    await evalPage(app.cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    let saveAsOk = false;
    for (let i = 0; i < 30 && !saveAsOk; i++) {
      if (fs.existsSync(aPath)) saveAsOk = true; else await sleep(250);
    }
    record(tag + ": setup — Save As creates A.md", saveAsOk);
    if (!saveAsOk) { await teardown(app, tag); rmrf(app.userDataDir); rmrf(userDataDir); return; }
    await sleep(300);
    const idA = await poll(app.cdp, "window.__splitpageFormats.docId()", 10000);

    // The 2.5 s gap used to matter because it put the copy's birthtime
    // outside chooseDuplicateLoser's 2 s noise window. That rule is gone
    // (#76 — see caseAtomicSaveKeepsBirthtime), so the seq tie-break names B
    // either way; the gap is kept only so the two files are unambiguously
    // distinguishable on disk to anything reading this fixture, and so Save
    // As has fully settled before the copy is taken.
    await sleep(2500);
    fs.copyFileSync(aPath, bPath);
    const aBytesOriginal = fs.readFileSync(aPath);
    const bBytesAfterCopy = fs.readFileSync(bPath);

    // Open B.md into a new tab: tab A is no longer pristine (it has a real
    // file), so routeOpenPath's pristine-reuse rule does not apply and this
    // lands in a fresh tab (TAB-IDENTITY / DOCUMENT-STATE-AND-ROUTING-IPC).
    await sendSecondInstanceTo(target, userDataDir, bPath);
    const tabBTarget = await pollNode(async () => {
      const { tabTargets } = await findTargetsByKind(app.port);
      const extra = tabTargets.filter((t) => t.tabId && t.tabId !== tabAId);
      return extra.length ? extra[0] : null;
    }, 20000).catch(() => null);
    record(tag + ": B.md opens into a new tab", !!tabBTarget);
    if (!tabBTarget) { await teardown(app, tag); rmrf(app.userDataDir); rmrf(userDataDir); return; }
    const tabBId = tabBTarget.tabId;
    cdpB = await connectTarget(tabBTarget);
    await waitForRows(cdpB, 20000);

    // The predicted replacement id (DOC-CLAIMS' Reassignment), computed
    // independently of the app: 'd' + sha256('splitpage-dup\n'+idA+'\n'+
    // fileHomeKey(absB)).slice(0,32) — byte-identical to both
    // replacementDocId (main.js) and deriveDocId (02b-doc-id.js). See
    // fileHomeKey for the one part of that string that is platform-
    // dependent.
    const homeKeyB = fileHomeKey(bPath);
    const toId = "d" + crypto.createHash("sha256")
      .update("splitpage-dup\n" + idA + "\n" + homeKeyB, "utf8").digest("hex").slice(0, 32);

    // Read the pre-reassignment id only as a courtesy — per step G's own
    // report the re-id can land inside a second, faster than a poll can
    // catch it "still idA". The authoritative proof is the docIdEvents()
    // copy entry checked below, not this snapshot.
    const bIdEarly = await evalPage(cdpB, "window.__splitpageFormats.docId()").catch(() => null);

    const reassigned = await poll(cdpB, "window.__splitpageFormats.docId() === " + JSON.stringify(toId), 20000).catch(() => null);
    record(tag + ": B's docId is reassigned to the predicted replacement id", !!reassigned,
      "idA=" + idA + " bIdEarly=" + bIdEarly + " toId=" + toId);

    const idAAfter = await evalPage(app.cdp, "window.__splitpageFormats.docId()");
    record(tag + ": A's docId is unchanged", idAAfter === idA, "idA=" + idA + " idAAfter=" + idAAfter);

    const eventsB = await evalPage(cdpB, "window.__splitpageFormats.docIdEvents()");
    const hasCopyEvent = Array.isArray(eventsB) &&
      eventsB.some((e) => e && e.type === "copy" && e.from === idA && e.to === toId);
    record(tag + ": B logged a history-copy event from idA to toId", hasCopyEvent, JSON.stringify(eventsB));

    const writtenOut = await evalPage(cdpB, "window.__splitpageFormats.writtenOut()");
    record(tag + ": docIdWrittenOut is false right after the reassignment (override §1 — no autosave)",
      writtenOut === false, String(writtenOut));

    const toastText = await evalPage(cdpB,
      "(function(){ var t=document.querySelectorAll('.toast'); for (var i=0;i<t.length;i++){ " +
      "if (t[i].textContent.indexOf('is a copy of')!==-1) return t[i].textContent; } return null; })()");
    record(tag + ": B shows the sticky \"is a copy of\" toast", !!toastText, String(toastText));

    // Override §1: reassignment never calls markDirty/queueAutoSave — B.md's
    // bytes must be untouched on disk right after the id changed in memory.
    record(tag + ": B.md's bytes are unchanged on disk immediately after the reassignment (no autosave)",
      fs.readFileSync(bPath).equals(bBytesAfterCopy));
    record(tag + ": A.md's bytes are unchanged on disk", fs.readFileSync(aPath).equals(aBytesOriginal));

    // "Once a save is made through the app in B's tab, B.md contains the new
    // id, and A.md's bytes are unchanged throughout" (override §1).
    await evalPage(cdpB, "window.__splitpageFormats.save()");
    let bTextAfterSave = null;
    for (let i = 0; i < 30 && bTextAfterSave === null; i++) {
      try {
        const t = fs.readFileSync(bPath, "utf8");
        if (t.indexOf(toId) !== -1) bTextAfterSave = t; else await sleep(250);
      } catch { await sleep(250); }
    }
    record(tag + ": after an explicit save through B's tab, B.md contains the new id on disk", !!bTextAfterSave);
    record(tag + ": A.md's bytes are STILL unchanged after B's save", fs.readFileSync(aPath).equals(aBytesOriginal));

    // "close and reopen B → no reassignment": B is clean (just saved), so
    // closeTab needs no dialog. Route the same path back in — a brand new
    // tab, since the closed one's pathToTabId entry is gone.
    await shell(app.cdp, "closeTab", { tabId: tabBId });
    await pollNode(async () => {
      const { tabTargets } = await findTargetsByKind(app.port);
      return tabTargets.some((t) => t.tabId === tabBId) ? null : true;
    }, 15000).catch(() => null);

    await sendSecondInstanceTo(target, userDataDir, bPath);
    const reopenTarget = await pollNode(async () => {
      const { tabTargets } = await findTargetsByKind(app.port);
      const extra = tabTargets.filter((t) => t.tabId && t.tabId !== tabAId && t.tabId !== tabBId);
      return extra.length ? extra[0] : null;
    }, 20000).catch(() => null);
    record(tag + ": B.md reopens", !!reopenTarget);
    let cdpReopen = null;
    if (reopenTarget) {
      cdpReopen = await connectTarget(reopenTarget);
      await waitForRows(cdpReopen, 20000);
      /* Polled for the expected id, not read once — the same shape as the
         first reassignment assertion above, and for a sharper reason here.
         routeOpenPath creates the tab with a pendingPayload and the renderer
         boots a blank seed document FIRST; the file is delivered after it
         reports ready. waitForRows is therefore satisfied while the page is
         still showing the seed, whose own random docId is what a single read
         catches (measured: it did, on Linux, where nothing else in the case
         was slow enough to hide the gap). A second reassignment — the thing
         this assertion exists to catch — settles on some OTHER id, so the
         poll still times out and still fails. */
      const keptItsId = await poll(cdpReopen,
        "window.__splitpageFormats.docId() === " + JSON.stringify(toId), 15000).catch(() => null);
      const reopenedId = await evalPage(cdpReopen, "window.__splitpageFormats.docId()").catch(() => null);
      record(tag + ": reopening B.md keeps its (already reassigned) id — no further reassignment",
        !!keptItsId, "reopenedId=" + reopenedId + " toId=" + toId);
      const reopenedEvents = await evalPage(cdpReopen, "window.__splitpageFormats.docIdEvents()").catch(() => null);
      record(tag + ": no new copy event fires on reopen (its id no longer collides with A's)",
        Array.isArray(reopenedEvents) && reopenedEvents.length === 0, JSON.stringify(reopenedEvents));
      try { cdpReopen.close(); } catch {}
    }

    try { if (cdpB) cdpB.close(); } catch {}
    cdpB = null;

    // "quit and restore → no reassignment": a graceful teardown persists the
    // session (both tabs), then a fresh launch on the same userDataDir
    // restores it — B's id is already unique, so nothing re-fires.
    /* Evidence for the restore assertion below, captured because it failed
       once on CI's fast runner (A came back as an untitled pristine tab, B
       came back fine) and could not be reproduced here in eight runs. Main's
       own view of every tab just before the quit, and the session file the
       quit actually wrote, are what tell a race in A's last document-state
       report apart from a race in the write. Printed only on failure. */
    const preQuitListing = await shell(app.cdp, "listTargets", {}).catch((e) => ({ error: String(e && e.message || e) }));
    await teardown(app, tag + " (pre-quit)");
    app = null;
    let persistedAtQuit = null;
    try { persistedAtQuit = JSON.parse(fs.readFileSync(path.join(userDataDir, "desktop-state.json"), "utf8")); }
    catch (e) { persistedAtQuit = { error: String(e && e.message || e) }; }

    const appRestored = await launchApp(target, { label: "dup-doc-id-restore", userDataDir });
    try {
      await waitForRows(appRestored.cdp, 20000);
      const listing = await shell(appRestored.cdp, "listTargets", {});
      const w = listing.windows[0];
      const restoredA = w && w.tabs.find((t) => t.path && path.resolve(t.path).toLowerCase() === path.resolve(aPath).toLowerCase());
      const restoredB = w && w.tabs.find((t) => t.path && path.resolve(t.path).toLowerCase() === path.resolve(bPath).toLowerCase());
      record(tag + ": quit + relaunch restores both A.md and B.md tabs", !!restoredA && !!restoredB,
        JSON.stringify(w) + (restoredA && restoredB ? "" :
          " || before quit, main held: " + JSON.stringify(preQuitListing) +
          " || desktop-state.json after quit: " + JSON.stringify(persistedAtQuit)));
      if (restoredA && restoredB) {
        const cdpRA = await connectTab(appRestored, restoredA.tabId);
        const cdpRB = await connectTab(appRestored, restoredB.tabId);
        await waitForRows(cdpRA, 20000);
        await waitForRows(cdpRB, 20000);
        const idARestored = await poll(cdpRA, "window.__splitpageFormats.docId()", 15000).catch(() => null);
        const idBRestored = await poll(cdpRB, "window.__splitpageFormats.docId()", 15000).catch(() => null);
        record(tag + ": after quit+restore, A keeps its id", idARestored === idA, String(idARestored));
        record(tag + ": after quit+restore, B keeps its reassigned id with no further reassignment",
          idBRestored === toId, String(idBRestored));
        const eventsRB = await evalPage(cdpRB, "window.__splitpageFormats.docIdEvents()").catch(() => null);
        record(tag + ": no new copy event after quit+restore",
          Array.isArray(eventsRB) && eventsRB.length === 0, JSON.stringify(eventsRB));
        try { cdpRA.close(); } catch {}
        try { cdpRB.close(); } catch {}
      }
    } finally {
      await teardown(appRestored, tag + " (post-restore)");
      rmrf(appRestored.userDataDir);
    }
  } finally {
    if (cdpB) { try { cdpB.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryRoundTripAndRelaunch. put/list/get/copy/touch/import-older/usage
   against the real main process, the on-disk layout HISTORY-STORAGE
   documents, and that all of it survives a relaunch (not just this
   process's in-memory historyIndexes Map). */
async function caseHistoryRoundTripAndRelaunch(target) {
  const tag = target.name + " history: put/list/get/copy/touch/import-older/usage + relaunch";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const docId = randDocId();
  const docId2 = randDocId();
  let app = null;
  try {
    app = await launchApp(target, { label: "history-roundtrip", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const bodyA = JSON.stringify({ rows: [{ id: "r1" }], title: "First" });
    const metaA = historyMeta({ label: "First", title: "First" });
    const putA = await historyCall(cdp, "historyPut", [docId, metaA, bodyA]);
    record(tag + ": first put succeeds, not a duplicate",
      putA && putA.ok === true && putA.duplicate === false, JSON.stringify(putA));

    const putADup = await historyCall(cdp, "historyPut", [docId, metaA, bodyA]);
    record(tag + ": putting the same snapshot id again is idempotent (duplicate:true)",
      putADup && putADup.ok === true && putADup.duplicate === true, JSON.stringify(putADup));

    const bodyB = JSON.stringify({ rows: [{ id: "r1" }, { id: "r2" }], title: "Second" });
    const metaB = historyMeta({ label: "Second", title: "Second", atMs: metaA.atMs });
    const putB = await historyCall(cdp, "historyPut", [docId, metaB, bodyB]);
    record(tag + ": second put succeeds", putB && putB.ok === true, JSON.stringify(putB));

    const list1 = await historyCall(cdp, "historyList", [docId]);
    record(tag + ": list returns both snapshots, newest first",
      Array.isArray(list1.entries) && list1.entries.length === 2 &&
      list1.entries[0].id === metaB.id && list1.entries[1].id === metaA.id, JSON.stringify(list1));
    record(tag + ": a put stamped at/before the bucket's newest is bumped strictly after it (historyStampAfter)",
      list1.entries[0].atMs > list1.entries[1].atMs, JSON.stringify(list1.entries.map((e) => e.atMs)));

    const got = await historyCall(cdp, "historyGet", [{ docId }, metaA.id]);
    record(tag + ": get returns the body verbatim",
      !!got && got.stateJson === bodyA && got.meta.id === metaA.id, JSON.stringify(got && got.meta));
    const missingGet = await historyCall(cdp, "historyGet", [{ docId }, randSnapId()]);
    record(tag + ": get of an unknown snapshot id returns null", missingGet === null, JSON.stringify(missingGet));

    const copy1 = await historyCall(cdp, "historyCopy", [docId, docId2]);
    record(tag + ": copy copies both snapshots into a fresh document",
      copy1 && copy1.ok === true && copy1.copied === 2, JSON.stringify(copy1));
    const copy2 = await historyCall(cdp, "historyCopy", [docId, docId2]);
    record(tag + ": a second copy is idempotent (0 copied, ids kept)",
      copy2 && copy2.ok === true && copy2.copied === 0, JSON.stringify(copy2));
    const list2 = await historyCall(cdp, "historyList", [docId2]);
    record(tag + ": the copy's target lists both snapshots too",
      Array.isArray(list2.entries) && list2.entries.length === 2, JSON.stringify(list2));

    await historyCall(cdp, "historyTouch", [docId, "Touched Title"]);
    const idxAfterTouch = readHistoryIndexOnDisk(userDataDir, docId);
    record(tag + ": touch updates the on-disk index title",
      !!idxAfterTouch && idxAfterTouch.title === "Touched Title", JSON.stringify(idxAfterTouch));
    const untouchedDocId = randDocId();
    await historyCall(cdp, "historyTouch", [untouchedDocId, "Should not exist"]);
    record(tag + ": touch never creates a record for a document with no history",
      readHistoryIndexOnDisk(userDataDir, untouchedDocId) === null, "");

    const olderEntries = [
      { meta: historyMeta({ id: randSnapId("l"), label: "legacy1" }), stateJson: JSON.stringify({ rows: [] }) },
      { meta: historyMeta({ id: randSnapId("l"), label: "legacy2" }), stateJson: JSON.stringify({ rows: [] }) }
    ];
    const imp = await historyCall(cdp, "historyImportOlder", [olderEntries]);
    record(tag + ": import-older adds both entries", imp && imp.ok === true && imp.added === 2, JSON.stringify(imp));
    const listOlder = await historyCall(cdp, "historyList", [null]);
    record(tag + ": list(null) reports the Older bucket",
      Array.isArray(listOlder.older) && listOlder.older.length === 2 && typeof listOlder.olderExpiresAt === "number",
      JSON.stringify(listOlder));

    const usage = await historyCall(cdp, "historyUsage", []);
    record(tag + ": usage reports non-zero totalBytes, docCount>=2, not read-only",
      usage && usage.totalBytes > 0 && usage.docCount >= 2 && usage.readOnly === false, JSON.stringify(usage));

    // ---- on-disk layout (HISTORY-STORAGE) ----
    const formatText = fs.readFileSync(path.join(userDataDir, "history", "FORMAT"), "utf8").trim();
    record(tag + ": FORMAT is \"1\" on disk", formatText === "1", formatText);
    const idxOnDisk = readHistoryIndexOnDisk(userDataDir, docId);
    record(tag + ": index.json has the documented shape, snapshots oldest first",
      !!idxOnDisk && idxOnDisk.formatVersion === 1 && idxOnDisk.docId === docId &&
      Array.isArray(idxOnDisk.snapshots) && idxOnDisk.snapshots.length === 2 &&
      idxOnDisk.snapshots[0].id === metaA.id && idxOnDisk.snapshots[1].id === metaB.id,
      JSON.stringify(idxOnDisk));
    const snapText = fs.readFileSync(historySnapPathOnDisk(userDataDir, docId, metaA.id), "utf8");
    const nl1 = snapText.indexOf("\n"), nl2 = snapText.indexOf("\n", nl1 + 1);
    record(tag + ": a .snap file is the 3-line magic/meta/body format with the body verbatim",
      snapText.slice(0, nl1) === "splitpage-snapshot 1" && snapText.slice(nl2 + 1) === bodyA, snapText.slice(0, nl1));
    let metaOnDisk = null;
    try { metaOnDisk = JSON.parse(snapText.slice(nl1 + 1, nl2)); } catch { /* recorded below */ }
    record(tag + ": the .snap meta line carries no document id (the folder is the document)",
      !!metaOnDisk && !("docId" in metaOnDisk), JSON.stringify(metaOnDisk));

    // ---- relaunch: everything above must be ON DISK, not just this process's memory ----
    await teardown(app, tag + " (pre-relaunch)");
    app = null;
    const app2 = await launchApp(target, { label: "history-roundtrip-relaunch", userDataDir });
    try {
      await waitForRows(app2.cdp, 20000);
      const listAfterRelaunch = await historyCall(app2.cdp, "historyList", [docId]);
      record(tag + ": after a relaunch, both snapshots are still listed",
        Array.isArray(listAfterRelaunch.entries) && listAfterRelaunch.entries.length === 2, JSON.stringify(listAfterRelaunch));
      const gotAfterRelaunch = await historyCall(app2.cdp, "historyGet", [{ docId }, metaA.id]);
      record(tag + ": after a relaunch, get still returns the body verbatim",
        !!gotAfterRelaunch && gotAfterRelaunch.stateJson === bodyA, "");
    } finally {
      await teardown(app2, tag + " (post-relaunch)");
      rmrf(app2.userDataDir);
    }
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryIdValidation. Every bad docId/snapshot id HISTORY-IPC's
   handlers see must reject the invoke rather than quietly doing something
   with it (invariant #38 — the renderer can never name a folder), a valid
   positive control proves the validator isn't simply rejecting everything,
   and nothing any of this touches leaks outside history/ or perturbs
   desktop-state.json. */
async function caseHistoryIdValidation(target) {
  const tag = target.name + " history: id validation — nothing outside history/, desktop-state.json untouched";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "history-id-validation", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const goodDocId = randDocId();
    const goodMeta = historyMeta({ label: "control" });
    const putGood = await historyCall(cdp, "historyPut", [goodDocId, goodMeta, "{}"]);
    record(tag + ": positive control — a valid docId/meta put succeeds", putGood && putGood.ok === true, JSON.stringify(putGood));
    const getGoodRejects = await historyCallRejects(cdp, "historyGet", [{ docId: goodDocId }, goodMeta.id]);
    record(tag + ": positive control — get of that real snapshot does not reject", getGoodRejects === false, "");

    const stateFile = path.join(userDataDir, "desktop-state.json");
    const stateBefore = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
    const topLevelBefore = fs.readdirSync(userDataDir).sort();

    const badDocIds = ["../x", "..", "a/b", "a\\b", "CON", goodDocId.toUpperCase(),
      "d" + "a".repeat(31), "d" + "a".repeat(33), 42, null, "_older", ""];
    for (const bad of badDocIds) {
      const rejected = await historyCallRejects(cdp, "historyPut", [bad, historyMeta(), "{}"]);
      record(tag + ": historyPut(" + JSON.stringify(bad) + ", …) rejects", rejected, "");
    }
    for (const bad of badDocIds) {
      if (bad === null) continue; // historyList(null) is the documented "Older bucket only" call, not invalid
      const rejected = await historyCallRejects(cdp, "historyList", [bad]);
      record(tag + ": historyList(" + JSON.stringify(bad) + ") rejects", rejected, "");
    }

    const badSnapIds = ["AB-uppercase", "-leadingdash", "a b", "a/b", "..", "", "x".repeat(65), null, 42];
    for (const bad of badSnapIds) {
      const rejected = await historyCallRejects(cdp, "historyGet", [{ docId: goodDocId }, bad]);
      record(tag + ": historyGet with snapshot id " + JSON.stringify(bad) + " rejects", rejected, "");
    }

    const olderBypassRejects = await historyCallRejects(cdp, "historyGet", [{ docId: "_older" }, goodMeta.id]);
    record(tag + ": historyGet with docId '_older' (bypassing the older:true query) rejects", olderBypassRejects, "");

    const stateAfter = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
    const topLevelAfter = fs.readdirSync(userDataDir).sort();
    record(tag + ": desktop-state.json is byte-identical after every rejected call",
      (stateBefore === null && stateAfter === null) || (!!stateBefore && !!stateAfter && stateBefore.equals(stateAfter)),
      "before=" + (stateBefore ? stateBefore.length : "null") + " after=" + (stateAfter ? stateAfter.length : "null"));
    record(tag + ": nothing new appears at the top of userData (no traversal escape out of history/)",
      JSON.stringify(topLevelBefore) === JSON.stringify(topLevelAfter),
      JSON.stringify(topLevelBefore) + " vs " + JSON.stringify(topLevelAfter));

    const historyEntries = [];
    const historyRoot = path.join(userDataDir, "history");
    if (fs.existsSync(historyRoot)) {
      (function walk(dir) {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          historyEntries.push(path.relative(historyRoot, p));
          if (fs.statSync(p).isDirectory()) walk(p);
        }
      })(historyRoot);
    }
    const suspicious = historyEntries.filter((e) => (/\.\.|CON|[A-Z]/.test(e)) && e !== "FORMAT");
    record(tag + ": history/ contains nothing named after a rejected id", suspicious.length === 0, JSON.stringify(historyEntries));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryCrashAfterBody. SPLITPAGE_TEST_HISTORY_FAULT=exit-after-body
   kills the process between the body write and the index write — the exact
   state a power cut mid-snapshot leaves (HISTORY-IPC / overrides §2b). A
   relaunch's fsck must adopt the orphan. */
async function caseHistoryCrashAfterBody(target) {
  const tag = target.name + " history: exit-after-body fault — relaunch adopts the orphan";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const docId = randDocId();
  const meta = historyMeta({ label: "orphan" });
  const body = JSON.stringify({ rows: [{ id: "r1" }], title: "Orphan" });
  let app = null;
  try {
    app = await launchApp(target, {
      label: "history-crash-after-body", userDataDir,
      env: { SPLITPAGE_TEST_HISTORY_FAULT: "exit-after-body" }
    });
    await waitForRows(app.cdp, 20000);

    // The reply never arrives — the process kills itself mid-put — so this
    // is fire-and-forget, same reasoning as fireEval's own comment.
    await fireEval(app.cdp,
      "window.splitpageDesktop.historyPut(" + JSON.stringify(docId) + "," + JSON.stringify(meta) + "," + JSON.stringify(body) + ")",
      { awaitPromise: false });

    const exited = await waitForExit(app.proc, 20000);
    record(tag + ": the process actually exits (the fault fired)", exited);
    // Empirically, process.kill(pid,'SIGKILL') from inside a Windows process
    // reports exit code 1 (no POSIX signals on Windows; libuv maps a
    // self-inflicted SIGKILL to TerminateProcess(1)) — not a code this
    // process chose, so it's pinned and explained rather than left to guess.
    // On POSIX the very same call in main.js is a real signal: no exit code
    // at all, signalCode 'SIGKILL'. One event, two ways of reporting it, so
    // the expectation is written in each platform's own terms rather than
    // loosened to "died somehow" — which would stop noticing a main process
    // that exited cleanly when the fault was supposed to kill it.
    await teardown(app, tag + " (post-crash)", IS_WINDOWS ? { expectExitCode: 1 } : { expectSignal: "SIGKILL" });
    app = null;

    const orphanPath = historySnapPathOnDisk(userDataDir, docId, meta.id);
    record(tag + ": the snapshot body reached disk before the crash", fs.existsSync(orphanPath), orphanPath);
    const idxBeforeRelaunch = readHistoryIndexOnDisk(userDataDir, docId);
    const orphanIndexed = !!idxBeforeRelaunch && Array.isArray(idxBeforeRelaunch.snapshots) &&
      idxBeforeRelaunch.snapshots.some((s) => s.id === meta.id);
    record(tag + ": …but the index does not name it yet (crashed before that write)", !orphanIndexed, JSON.stringify(idxBeforeRelaunch));

    // Relaunch WITHOUT the fault env — otherwise the next put would crash again.
    const app2 = await launchApp(target, { label: "history-crash-after-body-relaunch", userDataDir });
    try {
      await waitForRows(app2.cdp, 20000);
      const list = await historyCall(app2.cdp, "historyList", [docId]);
      record(tag + ": relaunch's fsck adopts the orphan — it is listed",
        Array.isArray(list.entries) && list.entries.some((e) => e.id === meta.id), JSON.stringify(list));
      const idxAfterRelaunch = readHistoryIndexOnDisk(userDataDir, docId);
      record(tag + ": the on-disk index is rebuilt to name the adopted snapshot",
        !!idxAfterRelaunch && idxAfterRelaunch.snapshots.some((s) => s.id === meta.id), JSON.stringify(idxAfterRelaunch));
    } finally {
      await teardown(app2, tag + " (post-relaunch)");
      rmrf(app2.userDataDir);
    }
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryCorruptIndex. A pre-seeded '{broken' index.json alongside 3
   readable .snap bodies and 1 truncated one — the fsck (ensureHistoryTable /
   fsckHistoryBucket) must rebuild the index from the readable bodies,
   quarantine the truncated one as *.corrupt (never adopt it, never silently
   drop it), and preserve the broken index as index.json.corrupt. */
async function caseHistoryCorruptIndex(target) {
  const tag = target.name + " history: corrupt index.json is rebuilt from the bodies (fsck)";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const docId = randDocId();
  const validMetas = [
    historyMeta({ label: "v1", atMs: 1000 }),
    historyMeta({ label: "v2", atMs: 2000 }),
    historyMeta({ label: "v3", atMs: 3000 })
  ];
  const truncatedId = randSnapId();

  writeHistoryFormatOnDisk(userDataDir, 1);
  for (const m of validMetas) {
    writeHistorySnapOnDisk(userDataDir, docId, m, JSON.stringify({ rows: [], title: m.label }));
  }
  const dir = historyBucketDirOnDisk(userDataDir, docId);
  // Truncated: the magic line only, no second newline at all — unreadable as
  // a header (readHistorySnapHeader requires one), so the fsck must
  // quarantine it rather than adopt or silently drop it.
  fs.writeFileSync(path.join(dir, "s-" + truncatedId + ".snap"), "splitpage-snapshot 1\n", "utf8");
  fs.writeFileSync(path.join(dir, "index.json"), "{broken", "utf8");

  let app = null;
  try {
    app = await launchApp(target, { label: "history-corrupt-index", userDataDir });
    await waitForRows(app.cdp, 20000);

    const list = await historyCall(app.cdp, "historyList", [docId]);
    const ids = (list.entries || []).map((e) => e.id).sort();
    record(tag + ": the fsck adopts exactly the 3 valid snapshots",
      ids.length === 3 && JSON.stringify(ids) === JSON.stringify(validMetas.map((m) => m.id).sort()), JSON.stringify(list));

    const idxOnDisk = readHistoryIndexOnDisk(userDataDir, docId);
    record(tag + ": index.json is rebuilt as valid JSON with all 3 snapshots",
      !!idxOnDisk && idxOnDisk.formatVersion === 1 && idxOnDisk.snapshots.length === 3, JSON.stringify(idxOnDisk));
    record(tag + ": the broken index.json is preserved as index.json.corrupt",
      fs.existsSync(path.join(dir, "index.json.corrupt")));
    record(tag + ": the truncated body is renamed *.corrupt, not adopted and not silently dropped",
      fs.existsSync(path.join(dir, "s-" + truncatedId + ".snap.corrupt")) &&
      !fs.existsSync(path.join(dir, "s-" + truncatedId + ".snap")));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryCapEviction. SPLITPAGE_TEST_HISTORY_CAP_BYTES lets a case reach
   the eviction planner's cap without writing hundreds of megabytes: the
   per-document 50-snapshot trim, and cap-driven eviction across documents by
   lastOpenedAt ascending, a document's newest snapshot never deleted. */
async function caseHistoryCapEviction(target) {
  const tag = target.name + " history: cap-driven eviction + 50-per-document trim";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const CAP = 3000000;
  let app = null;
  try {
    app = await launchApp(target, {
      label: "history-cap-eviction", userDataDir,
      env: { SPLITPAGE_TEST_HISTORY_CAP_BYTES: String(CAP) }
    });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    // ---- per-document trim to HISTORY_PER_DOC (50) ----
    const trimDocId = randDocId();
    let firstSnapId = null, lastSnapId = null;
    for (let i = 0; i < 55; i++) {
      const m = historyMeta({ id: randSnapId("t"), label: "seq-" + i, atMs: 1000 + i });
      await historyCall(cdp, "historyPut", [trimDocId, m, "{}"]);
      if (i === 0) firstSnapId = m.id;
      if (i === 54) lastSnapId = m.id;
    }
    const trimList = await historyCall(cdp, "historyList", [trimDocId]);
    record(tag + ": 55 puts to one document trim to exactly HISTORY_PER_DOC (50)",
      Array.isArray(trimList.entries) && trimList.entries.length === 50,
      "count=" + (trimList.entries && trimList.entries.length));
    const trimIds = (trimList.entries || []).map((e) => e.id);
    record(tag + ": the oldest is evicted, the newest survives",
      trimIds.indexOf(firstSnapId) === -1 && trimIds.indexOf(lastSnapId) !== -1, "");

    // ---- cap-driven eviction across two documents ----
    const bigBody = JSON.stringify({ blob: "x".repeat(900000) }); // ≈900 KB
    const docOld = randDocId(), docNew = randDocId();
    const oldSnap1 = historyMeta({ id: randSnapId("o"), atMs: 10000 });
    const oldSnap2 = historyMeta({ id: randSnapId("o"), atMs: 10001 });
    await historyCall(cdp, "historyPut", [docOld, oldSnap1, bigBody]);
    await historyCall(cdp, "historyPut", [docOld, oldSnap2, bigBody]);
    const newSnap1 = historyMeta({ id: randSnapId("n"), atMs: 20000 });
    await historyCall(cdp, "historyPut", [docNew, newSnap1, bigBody]);
    const newSnap2 = historyMeta({ id: randSnapId("n"), atMs: 20001 });
    const lastCapPut = await historyCall(cdp, "historyPut", [docNew, newSnap2, bigBody]);

    const usage = await historyCall(cdp, "historyUsage", []);
    record(tag + ": usage stays at or under the TEST_MODE cap after eviction",
      usage.totalBytes <= CAP, "totalBytes=" + usage.totalBytes + " cap=" + CAP);
    record(tag + ": the put that crossed the cap reports it evicted something, and is no longer overCap",
      lastCapPut.evicted > 0 && lastCapPut.overCap === false, JSON.stringify(lastCapPut));

    const listOld = await historyCall(cdp, "historyList", [docOld]);
    const listNew = await historyCall(cdp, "historyList", [docNew]);
    record(tag + ": the document touched EARLIER (docOld) loses its oldest snapshot first, keeps its newest",
      listOld.entries.length === 1 && listOld.entries[0].id === oldSnap2.id, JSON.stringify(listOld));
    record(tag + ": the document touched LATER (docNew) keeps both of its snapshots",
      listNew.entries.length === 2, JSON.stringify(listNew));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryConcurrentPuts. historyExclusive is ONE promise chain across
   every sender — 60+10 puts and a copy, fired without awaiting each one, and
   the same stress repeated from two different tabs (two different
   webContents) of the same launch, proves the queue serializes across pages
   too, not just within one. */
async function caseHistoryConcurrentPuts(target) {
  const tag = target.name + " history: concurrent puts + a copy are serialized correctly (one queue)";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));

  async function stressFrom(cdps, docId, copyToId, label) {
    const jobs = [];
    for (let i = 0; i < 70; i++) {
      const m = historyMeta({ id: randSnapId("c"), label: "c" + i, atMs: 100000 + i });
      jobs.push(historyCall(cdps[i % cdps.length], "historyPut", [docId, m, "{}"]));
    }
    jobs.push(historyCall(cdps[0], "historyCopy", [docId, copyToId]));

    const settled = await Promise.allSettled(jobs);
    const rejected = settled.filter((r) => r.status === "rejected");
    record(tag + " (" + label + "): none of the 70 concurrent puts + the concurrent copy reject",
      rejected.length === 0, JSON.stringify(rejected.map((r) => String(r.reason))));

    const list = await historyCall(cdps[0], "historyList", [docId]);
    const ids = (list.entries || []).map((e) => e.id);
    record(tag + " (" + label + "): the source document ends trimmed to exactly 50, no duplicates",
      ids.length === 50 && new Set(ids).size === 50, "count=" + ids.length);

    const copyResult = settled[settled.length - 1];
    const copyValue = copyResult.status === "fulfilled" ? copyResult.value : null;
    record(tag + " (" + label + "): the concurrent copy still reports ok with a sane copied count",
      !!copyValue && copyValue.ok === true && copyValue.copied >= 0 && copyValue.copied <= 70, JSON.stringify(copyValue));
    const listCopy = await historyCall(cdps[0], "historyList", [copyToId]);
    record(tag + " (" + label + "): the copy's target lists exactly what the copy itself reported (self-consistent)",
      Array.isArray(listCopy.entries) && listCopy.entries.length === (copyValue ? copyValue.copied : -1),
      "listed=" + (listCopy.entries && listCopy.entries.length) + " copied=" + (copyValue && copyValue.copied));
  }

  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "history-concurrent", userDataDir });
    await waitForRows(app.cdp, 20000);

    await stressFrom([app.cdp], randDocId(), randDocId(), "one tab");

    const tab2Id = await shell(app.cdp, "createTab", {});
    cdp2 = await connectTab(app, tab2Id);
    await waitForRows(cdp2, 20000);
    await stressFrom([app.cdp, cdp2], randDocId(), randDocId(), "two tabs");
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryLegacyMigration. The one-time migration of the shared
   localStorage 'splitpage-snapshots' key into the desktop Older bucket
   (startHistoryMigration, HISTORY-STORAGE's "Legacy migration"): put-if-
   absent, and a repeat leaves the bucket's expiresAt untouched (it was not
   re-created). */
async function caseHistoryLegacyMigration(target) {
  const tag = target.name + " history: legacy localStorage migration into Older (put-if-absent, expiresAt stable)";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "history-legacy-migration", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const legacy = JSON.stringify([
      { id: "legacy-a", at: new Date(1700000000000).toISOString(), label: "Legacy A", state: { rows: [{ id: "r1" }], title: "Legacy A" } },
      { id: "legacy-b", at: new Date(1700000001000).toISOString(), label: "Legacy B", state: { rows: [{ id: "r1" }], title: "Legacy B" } }
    ]);

    async function seedLegacyKeyAndReload() {
      await evalPage(cdp, "localStorage.setItem('splitpage-snapshots'," + JSON.stringify(legacy) + "); true");
      await evalPage(cdp, "location.reload()", { awaitPromise: false });
      await waitForRows(cdp, 20000);
      await poll(cdp, "localStorage.getItem('splitpage-snapshots') === null", 20000).catch(() => null);
      return pollNode(async () => {
        const list = await historyCall(cdp, "historyList", [null]);
        return Array.isArray(list.older) && list.older.length === 2 ? list : null;
      }, 20000).catch(() => null);
    }

    const list1 = await seedLegacyKeyAndReload();
    record(tag + ": older/index.json has both legacy entries after migration", !!list1, JSON.stringify(list1));
    const olderIds = list1 ? (list1.older || []).map((e) => e.id).sort() : [];
    record(tag + ": the migrated entries carry kind:'legacy' and the original ids",
      !!list1 && list1.older.every((e) => e.kind === "legacy") && JSON.stringify(olderIds) === JSON.stringify(["legacy-a", "legacy-b"]),
      JSON.stringify(list1 && list1.older));
    const expiresAt1 = list1 && list1.olderExpiresAt;
    record(tag + ": Older has an expiresAt set, in the future (90-day TTL from the migration)",
      typeof expiresAt1 === "number" && expiresAt1 > Date.now(), String(expiresAt1));

    // ---- repeat: the key reappears with the SAME two entries ----
    const list2 = await seedLegacyKeyAndReload();
    record(tag + ": a repeat migration stays at 2 (put-if-absent, no duplicates)", !!list2, JSON.stringify(list2));
    record(tag + ": expiresAt is unchanged by the repeat (the bucket was not re-created)",
      !!list2 && list2.olderExpiresAt === expiresAt1, "before=" + expiresAt1 + " after=" + (list2 && list2.olderExpiresAt));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseHistoryNewerFormatReadOnly. A FORMAT number ahead of ours means a
   newer build wrote this folder — history goes read-only rather than let
   this build rewrite an index shape it does not understand (HISTORY-STORAGE). */
async function caseHistoryNewerFormatReadOnly(target) {
  const tag = target.name + " history: FORMAT ahead of ours goes read-only";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const docId = randDocId();
  const seedMeta = historyMeta({ label: "pre-existing" });
  const seedBody = JSON.stringify({ rows: [], title: "Pre-existing" });

  writeHistorySnapOnDisk(userDataDir, docId, seedMeta, seedBody);
  const dir = historyBucketDirOnDisk(userDataDir, docId);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({
    formatVersion: 1, docId, title: "Pre-existing", lastOpenedAt: Date.now(),
    bytes: Buffer.byteLength(seedBody, "utf8"), snapshots: [seedMeta]
  }), "utf8");
  writeHistoryFormatOnDisk(userDataDir, 2); // a newer build's format

  const snapPath = historySnapPathOnDisk(userDataDir, docId, seedMeta.id);
  const mtimeBefore = fs.statSync(snapPath).mtimeMs;
  const formatPath = path.join(userDataDir, "history", "FORMAT");
  const formatBytesBefore = fs.readFileSync(formatPath);

  let app = null;
  try {
    app = await launchApp(target, { label: "history-newer-format", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const list = await historyCall(cdp, "historyList", [docId]);
    record(tag + ": list still works read-only — the pre-existing snapshot is there",
      Array.isArray(list.entries) && list.entries.length === 1 && list.entries[0].id === seedMeta.id, JSON.stringify(list));

    const put = await historyCall(cdp, "historyPut", [docId, historyMeta({ label: "should not land" }), "{}"]);
    record(tag + ": put on a newer-FORMAT folder refuses with code 'read-only'",
      put && put.ok === false && put.code === "read-only", JSON.stringify(put));

    const usage = await historyCall(cdp, "historyUsage", []);
    record(tag + ": usage reports readOnly:true", usage && usage.readOnly === true, JSON.stringify(usage));
    record(tag + ": the pre-existing .snap file's mtime is untouched", fs.statSync(snapPath).mtimeMs === mtimeBefore, "");
    record(tag + ": FORMAT itself is never rewritten back down to our own version",
      fs.readFileSync(formatPath).equals(formatBytesBefore), "");
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* "window.close() canary: grep src/js for 'window.close(' finds nothing (fs
   read in Node)." Pure source-text check — no launch, no target-dependent
   behaviour; runs once per target invocation but is cheap and idempotent. */
/* ----------------------------------------------------------------------
 * 5c. Step N: crash-safe drafts smoke cases (single and multi tab), against
 *     the real main process, the real preload bridge and a real crash — see
 *     DRAFT-STORE, DRAFT-IPC-AND-SHAPES, DRAFT-RENDERER-API and
 *     CLOSE-QUIT-LIFECYCLE. Every content edit goes through addMarkerRow (a
 *     real DOM edit, never markDirtyForTest) so a case can assert the exact
 *     text that comes back, not merely that a dirty flag survived.
 * -------------------------------------------------------------------- */

/* caseDraftCrashUntitled. Marker row, flush, crash, relaunch: the document
   is restored (title, marker row), dirty, with a recovery toast, onboarding
   stays hidden, and the draft folder survives (nothing has been saved) until
   Save As gives it a home, at which point invariant #40 discards it. */
async function caseDraftCrashUntitled(target) {
  const tag = target.name + " draft crash-recovery: untitled document";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-save-"));
  const savePath = path.join(saveDir, "case-n-untitled-saved.md");
  const marker = "MARKER-UNTITLED-" + Date.now();
  let appA = null, appB = null;
  try {
    appA = await launchApp(target, { label: "draft-untitled-crash-a", userDataDir });
    await waitForRows(appA.cdp, 20000);
    const tabId = await tabIdOfTarget(appA.cdp);

    await addMarkerRow(appA.cdp, marker);
    const write = await flushDraft(appA.cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));

    const dirs = readDraftDirs(userDataDir);
    record(tag + ": a draft folder for this tab exists on disk after the flush", !!dirs[tabId], JSON.stringify(Object.keys(dirs)));

    const session = readSession(userDataDir);
    record(tag + ": session.json still says 'running' (no clean exit yet)", !!session && session.state === "running", JSON.stringify(session));

    const crashed = await crashApp(appA);
    record(tag + ": crashApp actually kills the process", crashed === true);
    appA = null;

    appB = await launchApp(target, { label: "draft-untitled-crash-b", userDataDir, dialogs: [savePath] });
    await waitForRows(appB.cdp, 20000);
    const cdp = appB.cdp;

    const gotMarker = await waitForMarker(cdp, marker, 20000);
    record(tag + ": the marker row is restored", !!gotMarker);

    const dirtyAfter = await isDirty(cdp);
    record(tag + ": the restored document is dirty", !!dirtyAfter);

    const toast = await toastContaining(cdp, "Restored your unsaved script", 15000);
    record(tag + ": a recovery toast names the restored, never-saved document", !!toast, String(toast));

    const onboardingHidden = await evalPage(cdp, "(function(){ var m = document.getElementById('onboarding-modal'); return !m || m.hidden === true; })()");
    record(tag + ": onboarding is not shown over a crash-recovered document", !!onboardingHidden);

    const dirsAfter = readDraftDirs(userDataDir);
    record(tag + ": the draft folder is KEPT (the document is still unsaved)", !!dirsAfter[tabId], JSON.stringify(Object.keys(dirsAfter)));

    await evalPage(cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    const gone = await pollNode(async () => {
      const d = readDraftDirs(userDataDir);
      return !d[tabId] ? true : null;
    }, 5000).catch(() => false);
    record(tag + ": Save As removes the draft folder within ~3s (nothing left to protect once saved)",
      gone === true, JSON.stringify(Object.keys(readDraftDirs(userDataDir))));
  } finally {
    if (appA) await teardown(appA, tag + " (first launch)");
    if (appB) await teardown(appB, tag + " (second launch)");
    rmrf(userDataDir);
    rmrf(saveDir);
  }
}

/* caseDraftCrashDirtyFile (F1F2-01). A RENDERER crash (not a whole-process
   one) of a dirty file tab: the reloaded tab still holds the unsaved edit,
   and splitpage:test-draft-status reports hasDraft:true. */
async function caseDraftCrashDirtyFile(target, fixturesDir) {
  const tag = target.name + " draft crash-recovery: renderer crash of a dirty file tab";
  const filePath = writeFixture(fixturesDir, "case-n-dirty-file-" + Date.now() + ".splitpage", "Dirty File Doc", [["a", "b"]]);
  const marker = "MARKER-DIRTYFILE-" + Date.now();
  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "draft-crash-dirty-file", fixtures: [filePath] });
    await waitForRows(app.cdp, 20000);
    const tabId = await tabIdOfTarget(app.cdp);
    const cdp = app.cdp;

    await addMarkerRow(cdp, marker);
    const write = await flushDraft(cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));

    await crashRenderer(cdp);
    // Kept as a fixed wait on purpose: the reload reuses the same WebContents,
    // so the target id does not change and there is no "new target" to poll for.
    await sleep(1000); // let render-process-gone's hold + reload run

    const reconnected = await findPageTarget(app.port, 30000, { tabId });
    cdp2 = new CDPConn(reconnected.webSocketDebuggerUrl);
    await cdp2.open();
    await waitForRows(cdp2, 20000);

    const gotMarker = await waitForMarker(cdp2, marker, 20000);
    record(tag + ": the reloaded tab still holds the unsaved edit", !!gotMarker);

    const status = await draftStatusFor(cdp2);
    record(tag + ": splitpage:test-draft-status reports hasDraft:true after the crash reload", !!status && status.hasDraft === true, JSON.stringify(status));
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* caseDraftFileChangedOnDisk. The open file moved on while the app was
   down: a real three-way merge, nothing autosaved, the file on disk left
   exactly as the "other editor" wrote it. */
async function caseDraftFileChangedOnDisk(target, fixturesDir) {
  const tag = target.name + " draft crash-recovery: file changed on disk while down (merge)";
  const fileName = "case-n-changed-" + Date.now() + ".splitpage";
  const filePath = writeFixture(fixturesDir, fileName, "Changed On Disk Doc", [["a", "b"]]);
  const marker = "MARKER-CHANGED-MINE-" + Date.now();
  const diskMarker = "MARKER-CHANGED-DISK-" + Date.now();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-file-changed-a", userDataDir, fixtures: [filePath] });
    await waitForRows(app.cdp, 20000);
    await addMarkerRow(app.cdp, marker);
    const write = await flushDraft(app.cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));
    await crashApp(app);
    app = null;

    // Someone else (a sync client, another editor) saved this file while
    // the app was down — content differs from the draft's own base.
    writeFixture(fixturesDir, fileName, "Changed On Disk Doc", [["a", "b"], [diskMarker, "x"]]);
    const diskTextBeforeRelaunch = fs.readFileSync(filePath, "utf8");

    app = await launchApp(target, { label: "draft-file-changed-b", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const gotMine = await waitForMarker(cdp, marker, 20000);
    record(tag + ": the recovered edit is merged in", !!gotMine);
    const gotDisk = await markerPresent(cdp, diskMarker);
    record(tag + ": the disk's own change (the merge ancestor's counterpart) survives too", !!gotDisk);

    const toast = await toastContaining(cdp, "had changed since the last session", 15000);
    record(tag + ": a toast says the file had changed and the recovered edits were merged in", !!toast, String(toast));

    const dirtyAfter = await isDirty(cdp);
    record(tag + ": nothing has been saved yet — the merged tab stays dirty", !!dirtyAfter);

    const fileUnchanged = fs.readFileSync(filePath, "utf8") === diskTextBeforeRelaunch;
    record(tag + ": the file on disk is untouched by the restore (invariant #41)", fileUnchanged);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseDraftFileDeleted. The open file is gone at relaunch: the recovered
   edit opens as an unsaved copy rather than being lost. */
async function caseDraftFileDeleted(target, fixturesDir) {
  const tag = target.name + " draft crash-recovery: file deleted while down (unsaved copy)";
  const filePath = writeFixture(fixturesDir, "case-n-deleted-" + Date.now() + ".splitpage", "Deleted File Doc", [["a", "b"]]);
  const marker = "MARKER-DELETED-" + Date.now();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-file-deleted-a", userDataDir, fixtures: [filePath] });
    await waitForRows(app.cdp, 20000);
    await addMarkerRow(app.cdp, marker);
    const write = await flushDraft(app.cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));
    await crashApp(app);
    app = null;

    fs.unlinkSync(filePath);

    app = await launchApp(target, { label: "draft-file-deleted-b", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const gotMine = await waitForMarker(cdp, marker, 20000);
    record(tag + ": the recovered work is opened as an unsaved copy", !!gotMine);
    const dirtyAfter = await isDirty(cdp);
    record(tag + ": the copy is dirty (unsaved)", !!dirtyAfter);
    const toast = await toastContaining(cdp, "isn't where it was", 15000);
    record(tag + ": the toast says the file is gone and it's open as an unsaved copy", !!toast, String(toast));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseQuitWithoutSavingDeletesDrafts. Two dirty file tabs, one 3-button
   quit dialog answered 'confirm' (discard): exit 0, no tab folders left,
   session.json says 'clean-exit', both tabIds recorded as discarded — and a
   relaunch reopens both files clean, with nothing to recover. */
async function caseQuitWithoutSavingDeletesDrafts(target, fixturesDir) {
  const tag = target.name + " draft: quit without saving discards every draft";
  const aPath = writeFixture(fixturesDir, "case-n-quit-a-" + Date.now() + ".splitpage", "Quit Discard A", [["a", "b"]]);
  const bPath = writeFixture(fixturesDir, "case-n-quit-b-" + Date.now() + ".splitpage", "Quit Discard B", [["c", "d"]]);
  const markerA = "MARKER-QUIT-A-" + Date.now();
  const markerB = "MARKER-QUIT-B-" + Date.now();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  let cdpB = null;
  try {
    app = await launchApp(target, { label: "quit-discard-drafts", userDataDir, fixtures: [aPath, bPath], dialogs: ["confirm"] });
    await waitForRows(app.cdp, 20000);
    const tabAId = await tabIdOfTarget(app.cdp);

    const listing0 = await shell(app.cdp, "listTargets", {});
    const tabBId = listing0.windows.flatMap((w) => w.tabs.map((t) => t.tabId)).find((id) => id !== tabAId);
    cdpB = await connectTab(app, tabBId);
    await waitForRows(cdpB, 20000);

    await addMarkerRow(app.cdp, markerA);
    const writeA = await flushDraft(app.cdp);
    record(tag + ": tab A's flushed write lands", !!writeA && writeA.ok === true, JSON.stringify(writeA));
    await addMarkerRow(cdpB, markerB);
    const writeB = await flushDraft(cdpB);
    record(tag + ": tab B's flushed write lands", !!writeB && writeB.ok === true, JSON.stringify(writeB));

    const dirsBefore = readDraftDirs(userDataDir);
    record(tag + ": both draft folders exist before quit", !!dirsBefore[tabAId] && !!dirsBefore[tabBId], JSON.stringify(Object.keys(dirsBefore)));

    // File > Exit with 2 unsaved tabs in one window -> ONE 3-button dialog;
    // dialogs[0] = "confirm" -> discard/leave -> quit proceeds, exit 0.
    await fireEval(app.cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": quit with 'confirm' exits the process", exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);

    const dirsAfter = readDraftDirs(userDataDir);
    record(tag + ": no tab folders remain after the discard", !dirsAfter[tabAId] && !dirsAfter[tabBId], JSON.stringify(Object.keys(dirsAfter)));

    const session = readSession(userDataDir);
    record(tag + ": session.json says 'clean-exit'", !!session && session.state === "clean-exit", JSON.stringify(session));
    const discarded = (session && session.discardedTabIds) || [];
    record(tag + ": both tabIds are recorded as discarded", discarded.indexOf(tabAId) !== -1 && discarded.indexOf(tabBId) !== -1, JSON.stringify(discarded));

    // Relaunch: the files themselves are untouched, so both tabs reopen
    // clean, with nothing to recover.
    app = await launchApp(target, { label: "quit-discard-drafts-relaunch", userDataDir });
    await waitForRows(app.cdp, 20000);
    const listing1 = await pollNode(async () => {
      const l = await shell(app.cdp, "listTargets", {});
      const allTabs = l.windows.flatMap((w) => w.tabs);
      return allTabs.length === 2 ? l : null;
    }, 20000).catch(() => null);
    record(tag + ": relaunch reopens both file tabs", !!listing1, JSON.stringify(listing1));
    const allTabs1 = listing1 ? listing1.windows.flatMap((w) => w.tabs) : [];
    record(tag + ": neither reopened tab is dirty (no recovery)", allTabs1.length === 2 && allTabs1.every((t) => !t.dirty), JSON.stringify(allTabs1));
  } finally {
    if (cdpB) { try { cdpB.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseLeaveWithoutSavingDeletesOnlyThatDraft. Tabs A and B, close-tab on A
   with 'confirm': only A's folder disappears. Crash, relaunch: only B is
   recovered. */
async function caseLeaveWithoutSavingDeletesOnlyThatDraft(target, fixturesDir) {
  const tag = target.name + " draft: closing one tab without saving discards only that draft";
  const aPath = writeFixture(fixturesDir, "case-n-leave-a-" + Date.now() + ".splitpage", "Leave Discard A", [["a", "b"]]);
  const bPath = writeFixture(fixturesDir, "case-n-leave-b-" + Date.now() + ".splitpage", "Leave Keep B", [["c", "d"]]);
  const markerA = "MARKER-LEAVE-A-" + Date.now();
  const markerB = "MARKER-LEAVE-B-" + Date.now();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  let cdpB = null;
  try {
    app = await launchApp(target, { label: "leave-discard-one", userDataDir, fixtures: [aPath, bPath], dialogs: ["confirm"] });
    await waitForRows(app.cdp, 20000);
    const tabAId = await tabIdOfTarget(app.cdp);
    const listing0 = await shell(app.cdp, "listTargets", {});
    const tabBId = listing0.windows.flatMap((w) => w.tabs.map((t) => t.tabId)).find((id) => id !== tabAId);
    cdpB = await connectTab(app, tabBId);
    await waitForRows(cdpB, 20000);

    await addMarkerRow(app.cdp, markerA);
    await flushDraft(app.cdp);
    await addMarkerRow(cdpB, markerB);
    await flushDraft(cdpB);

    const dirsBefore = readDraftDirs(userDataDir);
    record(tag + ": both draft folders exist before closing A", !!dirsBefore[tabAId] && !!dirsBefore[tabBId], JSON.stringify(Object.keys(dirsBefore)));

    // Ctrl+W on A alone: the 2-button ['Leave without saving','Stay']
    // dialog, scoped to that one tab (CLOSE-QUIT-LIFECYCLE).
    await fireEval(app.cdp, "window.splitpageDesktop.__testRequestCloseTab()", { awaitPromise: false });
    const closed = await pollShellState(cdpB, (l) => {
      const allTabs = l.windows.flatMap((w) => w.tabs.map((t) => t.tabId));
      return allTabs.indexOf(tabAId) === -1 ? l : null;
    }, 15000).catch(() => null);
    record(tag + ": tab A closes", !!closed, closed ? "" : "tab A was still listed");

    const dirsAfterClose = readDraftDirs(userDataDir);
    record(tag + ": only A's draft folder is gone; B's survives", !dirsAfterClose[tabAId] && !!dirsAfterClose[tabBId], JSON.stringify(Object.keys(dirsAfterClose)));

    await crashApp(app);
    app = null;

    app = await launchApp(target, { label: "leave-discard-one-relaunch", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;
    const gotB = await waitForMarker(cdp, markerB, 20000);
    record(tag + ": relaunch recovers only B's unsaved work", !!gotB);
    const gotA = await markerPresent(cdp, markerA);
    record(tag + ": A's discarded work never comes back", !gotA);
  } finally {
    if (cdpB) { try { cdpB.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseDraftCrashMidWrite. SPLITPAGE_TEST_DRAFT_KILL_BEFORE_RENAME='2': the
   whole main process is SIGKILLed with the SECOND write's temp file written
   but not yet renamed — a power cut mid-write. The first (fully-written)
   generation is restored; the never-renamed second write never lands; and
   init()'s own sweep leaves no leftover .tmp-*. */
async function caseDraftCrashMidWrite(target) {
  const tag = target.name + " draft: power-cut mid-write keeps the FIRST generation, no leftover .tmp-*";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const markerGen1 = "MARKER-MIDWRITE-GEN1-" + Date.now();
  const markerGen2 = "MARKER-MIDWRITE-GEN2-" + Date.now();
  let app = null;
  try {
    app = await launchApp(target, {
      label: "draft-mid-write-kill", userDataDir,
      env: { SPLITPAGE_TEST_DRAFT_KILL_BEFORE_RENAME: "2" }
    });
    await waitForRows(app.cdp, 20000);
    const tabId = await tabIdOfTarget(app.cdp);
    const cdp = app.cdp;

    // Write #1: completes fully — this is the "first generation".
    await addMarkerRow(cdp, markerGen1);
    await flushDraft(cdp);

    const tabDir = path.join(userDataDir, "drafts", tabId);
    const gen1 = fs.existsSync(tabDir) ? fs.readdirSync(tabDir) : [];
    record(tag + ": the first write lands normally", gen1.indexOf("current.draft") !== -1, JSON.stringify(gen1));

    // Write #2: reaches the rename step and the process is SIGKILLed right
    // there (draftTestHooksFromEnv's onKill). Fire-and-forget: no reply can
    // ever arrive.
    await evalPage(cdp,
      "(function(){ var cells = document.querySelectorAll('#rows .cell-editable[data-field=\"visualText\"]'); " +
      "var cell = cells[cells.length - 1]; cell.textContent = " + JSON.stringify(markerGen2) + "; " +
      "cell.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
      { awaitPromise: false });
    await fireEval(cdp, "window.__desktopTest.drafts.flushNow()", { awaitPromise: false });

    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": the SIGKILL actually ends the process", exited === true);

    app = await launchApp(target, { label: "draft-mid-write-relaunch", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp2 = app.cdp;

    const gotGen1 = await waitForMarker(cdp2, markerGen1, 20000);
    record(tag + ": the first (fully-written) generation is restored", !!gotGen1);
    const gotGen2 = await markerPresent(cdp2, markerGen2);
    record(tag + ": the second (mid-write, never renamed) write never lands", !gotGen2);

    const tabDirAfter = path.join(userDataDir, "drafts", tabId);
    const entries = fs.existsSync(tabDirAfter) ? fs.readdirSync(tabDirAfter) : [];
    const leftoverTmp = entries.filter((n) => n.indexOf(".tmp-") === 0);
    record(tag + ": no leftover .tmp-* file (init()'s own sweep)", leftoverTmp.length === 0, JSON.stringify(entries));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseDraftCorrupt. Two full generations, then BOTH garbled on disk: the
   tab seed-boots (a fresh document, not stuck), a toast explains the
   changes couldn't be read, and corrupt/<tabId>-<ts>/ holds both bad
   files — the hold stays (DRAFT-STORE's 'failed' contract). */
async function caseDraftCorrupt(target) {
  const tag = target.name + " draft: both generations corrupt -> quarantined, seed boot, a toast";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-corrupt-a", userDataDir });
    await waitForRows(app.cdp, 20000);
    const tabId = await tabIdOfTarget(app.cdp);
    const cdp = app.cdp;

    // Two full writes -> both current.draft and previous.draft exist.
    await addMarkerRow(cdp, "MARKER-CORRUPT-1");
    await flushDraft(cdp);
    await evalPage(cdp,
      "(function(){ var cells = document.querySelectorAll('#rows .cell-editable[data-field=\"visualText\"]'); " +
      "var cell = cells[cells.length - 1]; cell.textContent = 'MARKER-CORRUPT-2'; " +
      "cell.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
      { awaitPromise: false });
    await flushDraft(cdp);

    await crashApp(app);
    app = null;

    const tabDir = path.join(userDataDir, "drafts", tabId);
    for (const name of ["current.draft", "previous.draft"]) {
      const p = path.join(tabDir, name);
      if (fs.existsSync(p)) fs.writeFileSync(p, "not json at all { garbled", "utf8");
    }

    app = await launchApp(target, { label: "draft-corrupt-b", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp2 = app.cdp;

    const rowsCount = await evalPage(cdp2, "document.querySelectorAll('#rows > *').length");
    record(tag + ": the tab seed-boots a fresh document rather than staying blocked", typeof rowsCount === "number", "rows=" + rowsCount);

    const toast = await toastContaining(cdp2, "couldn't be read", 15000);
    record(tag + ": a toast says the recovered changes couldn't be read and were kept", !!toast, String(toast));

    const status = await draftStatusFor(cdp2);
    record(tag + ": the hold stays — a 'failed' restore keeps the tab counted as unsaved", !!status && status.held === true, JSON.stringify(status));

    const corruptDir = path.join(userDataDir, "drafts", "corrupt");
    const quarantined = fs.existsSync(corruptDir)
      ? fs.readdirSync(corruptDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.indexOf(tabId) === 0)
      : [];
    record(tag + ": corrupt/ holds a quarantined folder for this tab", quarantined.length === 1, JSON.stringify(quarantined.map((e) => e.name)));
    if (quarantined.length === 1) {
      const held = fs.readdirSync(path.join(corruptDir, quarantined[0].name));
      record(tag + ": the quarantined folder holds both bad generations",
        held.indexOf("current.draft") !== -1 && held.indexOf("previous.draft") !== -1, JSON.stringify(held));
    }
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseDraftDiskFull. SPLITPAGE_TEST_DRAFT_FAIL='ENOSPC:3': exactly one
   sticky "paused — disk is full" toast (never one per refusal), then
   "working again" once the injected failures run out. Backoff shrunk via
   the real DRAFT-RENDERER-API setTiming test hook so this stays fast. */
async function caseDraftDiskFull(target) {
  const tag = target.name + " draft: ENOSPC pauses writes, exactly one sticky toast, then resumes";
  let app = null;
  try {
    app = await launchApp(target, {
      label: "draft-disk-full", env: { SPLITPAGE_TEST_DRAFT_FAIL: "ENOSPC:3" }
    });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    await evalPage(cdp, "window.__desktopTest.drafts.setTiming({ backoffMin: 600, backoffMax: 1500 }); true", { awaitPromise: false });

    await addMarkerRow(cdp, "MARKER-DISKFULL");

    const pausedToast = await toastContaining(cdp, "Crash recovery is paused — this disk is full", 8000);
    record(tag + ": a sticky 'paused — disk is full' toast appears", !!pausedToast, String(pausedToast));

    const stickyCount = await evalPage(cdp, "document.querySelectorAll('.toast.warn.is-sticky').length");
    record(tag + ": exactly one sticky paused toast is on screen", stickyCount === 1, "count=" + stickyCount);

    const status1 = await draftStatusFor(cdp);
    record(tag + ": at least one ENOSPC refusal was counted as a real failure", !!status1 && status1.failures >= 1, JSON.stringify(status1));

    const workingToast = await toastContaining(cdp, "Crash recovery is working again", 15000);
    record(tag + ": recovery resumes once the injected failures run out", !!workingToast, String(workingToast));

    const stickyGone = await poll(cdp, "document.querySelectorAll('.toast.warn.is-sticky').length === 0", 8000).catch(() => false);
    record(tag + ": the sticky paused toast is withdrawn once recovery resumes", !!stickyGone);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* caseDraftForgedFileId. A draft written directly (bypassing the app's own
   writer entirely) with a fileId nothing registered: main can only build
   filePath:null for it, and the restore opens it as an unsaved copy rather
   than losing it, throwing or trusting the fileId as a path (invariant
   #34). crashApp, not a normal close, because a clean close of this
   never-dirtied-in-page tab would otherwise discardClean the very draft
   this case forged. */
async function caseDraftForgedFileId(target) {
  const tag = target.name + " draft: forged fileId with no registered path opens as an untitled copy";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const marker = "MARKER-FORGED-" + Date.now();
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-forged-fileid-a", userDataDir });
    await waitForRows(app.cdp, 20000);
    const tabId = await tabIdOfTarget(app.cdp);
    const cdp = app.cdp;

    const payload = {
      seq: 1, editSeq: 1, title: "Forged File", docId: null, docIdWrittenOut: false,
      schema: 2, originKind: "file", fileId: "deadbeef", fileKind: "splitpage",
      importName: null, baseLastModified: null, baseSize: null, server: null,
      stateJson: JSON.stringify({ title: "Forged File", rows: [{ id: "r1", visualText: marker, audioText: "", status: "todo" }] }),
      // A non-null base: DRAFT-STORE requires one on a tab's FIRST write in
      // this process (NEED_BASE otherwise) — real captureAndSendDraft() calls
      // always carry one on a first write for exactly this reason.
      baseJson: JSON.stringify({ title: "Forged File", rows: [] })
    };
    const write = await evalPage(cdp, "window.splitpageDesktop.writeDraft(" + JSON.stringify(payload) + ")");
    record(tag + ": the forged write is accepted at the store level", !!write && write.ok === true, JSON.stringify(write));

    const dirs = readDraftDirs(userDataDir);
    const header = dirs[tabId] && dirs[tabId].current && dirs[tabId].current.header;
    record(tag + ": main writes filePath:null for the unregistered fileId (invariant #34)",
      !!header && header.origin && header.origin.kind === "file" && header.origin.filePath === null, JSON.stringify(header && header.origin));

    await crashApp(app);
    app = null;

    app = await launchApp(target, { label: "draft-forged-fileid-b", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp2 = app.cdp;

    const gotMarker = await waitForMarker(cdp2, marker, 20000);
    record(tag + ": the forged draft opens as an unsaved copy rather than getting lost", !!gotMarker);
    const dirtyAfter = await isDirty(cdp2);
    record(tag + ": the copy is dirty", !!dirtyAfter);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* caseDraftNoSecrets. --host --pin 482915: no file under drafts/ contains
   the PIN, the real join token, or 'launch='; header server.base (when
   present) carries no userinfo ('@'). */
async function caseDraftNoSecrets(target) {
  const tag = target.name + " draft: no PIN, token or launch URL ever reaches disk";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  const pin = "482915";
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-no-secrets", flags: ["--host", "--pin", pin], dataDir, dialogs: ["confirm"] });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const info = await poll(cdp, "window.splitpageDesktop.getSessionInfo().then(function(i){ return (i && i.hosting) ? i : null; })", 20000);
    const port = info && info.port;
    record(tag + ": setup — hosting with a known port", !!port, JSON.stringify(info));

    let token = null;
    if (port) {
      const joined = await fetchJson(`http://127.0.0.1:${port}/api/join`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin })
      });
      token = joined.body && joined.body.token;
      record(tag + ": setup — a real join token was minted", !!token, JSON.stringify(joined.body));
    }

    await addMarkerRow(cdp, "MARKER-NOSECRETS");
    const write = await flushDraft(cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));

    const draftsRoot = path.join(app.userDataDir, "drafts");
    const pinHit = dirContainsText(draftsRoot, pin);
    record(tag + ": no file under drafts/ contains the PIN", !pinHit, String(pinHit));
    const tokenHit = token ? dirContainsText(draftsRoot, token) : null;
    record(tag + ": no file under drafts/ contains the server join token", !tokenHit, String(tokenHit));
    const launchHit = dirContainsText(draftsRoot, "launch=");
    record(tag + ": no file under drafts/ contains 'launch='", !launchHit, String(launchHit));

    const dirs = readDraftDirs(app.userDataDir);
    const anyTab = Object.keys(dirs)[0];
    const header = anyTab && dirs[anyTab].current && dirs[anyTab].current.header;
    const base = header && header.origin && header.origin.server && header.origin.server.base;
    record(tag + ": header server.base (when present) carries no userinfo ('@')",
      base === undefined || base === null || String(base).indexOf("@") === -1, JSON.stringify(base));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(dataDir);
  }
}

/* caseDraftServerDocMerges and caseDraftServerGone: --library mode makes
   this same app both the document server and a client of it, so a real
   server document can be created, edited, crashed on and recovered against
   the real server — no fake fetch needed. */
async function caseDraftServerDocMerges(target) {
  const tag = target.name + " draft: server document reachable at relaunch -> merged (no autosave)";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const myMarker = "MARKER-SERVER-MINE-" + Date.now();
  const theirMarker = "MARKER-SERVER-THEIRS-" + Date.now();
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-server-merge-a", flags: ["--library"], dataDir, userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const created = await evalPage(cdp,
      "fetch('/api/docs', { method:'POST', headers:{'content-type':'application/json'}, " +
      "body: JSON.stringify({ state: { title: 'Server Merge Doc', rows: [] } }) }).then(function(r){ return r.json(); })");
    record(tag + ": setup — a server document is created", !!created && !!created.id, JSON.stringify(created));
    if (!created || !created.id) return;

    const routed = await evalPage(cdp, "window.splitpageDesktop.routeOpen({ kind: 'server', serverDocId: " + JSON.stringify(created.id) + " })");
    record(tag + ": setup — the tab is routed to the server document", !!routed, JSON.stringify(routed));
    const opened = await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Server Merge Doc"), 15000).catch(() => false);
    record(tag + ": setup — the tab shows the server document", !!opened);

    await addMarkerRow(cdp, myMarker);
    const write = await flushDraft(cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));

    const info = await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");
    const port = info && info.port;
    // Simulate another client saving a different version while this copy
    // is down — a raw PUT, never through this tab's own document. POST
    // /api/docs starts a fresh document at rev 1 (server/server.js), so the
    // compare-and-set base is created.rev, not 0.
    const serverRevAfterExternalEdit = created.rev + 1;
    const putRes = port ? await fetchJson(`http://127.0.0.1:${port}/api/docs/${created.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: created.rev, state: { title: "Server Merge Doc", rows: [{ id: "x1", visualText: theirMarker, audioText: "", status: "todo" }] } })
    }) : null;
    record(tag + ": setup — another client saves a different version",
      !!putRes && putRes.status === 200 && putRes.body && putRes.body.rev === serverRevAfterExternalEdit, JSON.stringify(putRes && putRes.body));

    await crashApp(app);
    app = null;

    app = await launchApp(target, { label: "draft-server-merge-b", flags: ["--library"], dataDir, userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp2 = app.cdp;

    const gotMine = await waitForMarker(cdp2, myMarker, 25000);
    record(tag + ": the recovered edit survives the merge", !!gotMine);
    const gotTheirs = await markerPresent(cdp2, theirMarker);
    record(tag + ": the other client's edit survives the merge too", !!gotTheirs);
    const toast = await toastContaining(cdp2, "merged back in", 15000);
    record(tag + ": a toast says the recovered changes were merged back in", !!toast, String(toast));

    await sleep(800);
    const info2 = await evalPage(cdp2, "window.splitpageDesktop.getSessionInfo()");
    const readBack = info2 && info2.port ? await fetchJson(`http://127.0.0.1:${info2.port}/api/docs/${created.id}`) : null;
    record(tag + ": the merge does NOT autosave (invariant #41 / overrides §1) — the server rev is unchanged by the restore",
      !!readBack && readBack.status === 200 && readBack.body.rev === serverRevAfterExternalEdit, JSON.stringify(readBack && readBack.body));
    const dirtyAfter = await isDirty(cdp2);
    record(tag + ": the merged tab stays dirty (btn-save is-dirty)", !!dirtyAfter);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(dataDir);
    rmrf(userDataDir);
  }
}

async function caseDraftServerGone(target) {
  const tag = target.name + " draft: server document deleted while down -> unsaved copy";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const marker = "MARKER-SERVERGONE-" + Date.now();
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-server-gone-a", flags: ["--library"], dataDir, userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const created = await evalPage(cdp,
      "fetch('/api/docs', { method:'POST', headers:{'content-type':'application/json'}, " +
      "body: JSON.stringify({ state: { title: 'Server Gone Doc', rows: [] } }) }).then(function(r){ return r.json(); })");
    record(tag + ": setup — a server document is created", !!created && !!created.id, JSON.stringify(created));
    if (!created || !created.id) return;

    await evalPage(cdp, "window.splitpageDesktop.routeOpen({ kind: 'server', serverDocId: " + JSON.stringify(created.id) + " })");
    await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Server Gone Doc"), 15000).catch(() => false);

    await addMarkerRow(cdp, marker);
    const write = await flushDraft(cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));

    const info = await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");
    const port = info && info.port;
    const del = port ? await fetchJson(`http://127.0.0.1:${port}/api/docs/${created.id}`, { method: "DELETE" }) : null;
    record(tag + ": setup — the document is deleted from the server", !!del && del.status === 200, JSON.stringify(del));

    await crashApp(app);
    app = null;

    app = await launchApp(target, { label: "draft-server-gone-b", flags: ["--library"], dataDir, userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp2 = app.cdp;

    const gotMarker = await waitForMarker(cdp2, marker, 25000);
    record(tag + ": the recovered work is opened as an unsaved copy", !!gotMarker);
    const dirtyAfter = await isDirty(cdp2);
    record(tag + ": the copy is dirty", !!dirtyAfter);
    const toast = await toastContaining(cdp2, "no longer on the server", 15000);
    record(tag + ": a toast says the document is no longer on the server", !!toast, String(toast));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(dataDir);
    rmrf(userDataDir);
  }
}

/* caseRendererCrashRestores (J-1). A renderer crash of a CLEAN tab must
   never leave a hold — nothing sends draft-restore-done to release one that
   was never taken over a draft that never existed — and closing the
   reloaded tab must raise no unsaved-changes prompt. */
async function caseRendererCrashRestores(target) {
  const tag = target.name + " draft: renderer crash of a CLEAN tab reloads unheld, closes with no prompt";
  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "renderer-crash-clean" });
    await waitForRows(app.cdp, 20000);
    const tabId = await tabIdOfTarget(app.cdp);
    const cdp = app.cdp;

    await crashRenderer(cdp);
    await sleep(1000); // same target id after the reload — see the dirty-file-tab crash case above

    const reconnected = await findPageTarget(app.port, 30000, { tabId });
    cdp2 = new CDPConn(reconnected.webSocketDebuggerUrl);
    await cdp2.open();
    await waitForRows(cdp2, 20000);

    const status = await draftStatusFor(cdp2);
    record(tag + ": a clean tab's crash never leaves a hold (nothing to protect)", !!status && status.held === false, JSON.stringify(status));

    // Closing through the SAME test hook, with no dialog answers queued: a
    // dialog would sit there auto-cancelling, which would leave the window
    // open and the process alive — the loud way this assertion fails.
    await fireEval(cdp2, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": closing the reloaded, still-clean tab raises no unsaved dialog (exits clean)",
      exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* caseCleanTabsWriteNothing. 8s idle, nothing ever typed: no draft write,
   no tab folder — the writer never runs over a clean document. */
async function caseCleanTabsWriteNothing(target) {
  const tag = target.name + " draft: an untouched tab writes nothing, even after idle";
  let app = null;
  try {
    app = await launchApp(target, { label: "clean-tabs-write-nothing" });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    await sleep(8000); // well past draftTiming.idle/max — nothing should ever fire

    const status = await draftStatusFor(cdp);
    record(tag + ": no draft write was ever made", !!status && status.writes === 0, JSON.stringify(status));

    const dirs = readDraftDirs(app.userDataDir);
    record(tag + ": no tab folder exists under drafts/", Object.keys(dirs).length === 0, JSON.stringify(Object.keys(dirs)));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

/* caseTornOffDirtyTabCrashRestoresOnce. A dirty tab moved into its own
   window, then a whole-process crash: relaunch recovers it exactly once,
   under its original tabId — never twice, never under the wrong window. */
async function caseTornOffDirtyTabCrashRestoresOnce(target) {
  const tag = target.name + " draft: a torn-off dirty tab crashes and restores exactly once";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const marker = "MARKER-TORNOFF-" + Date.now();
  let app = null;
  let cdp2 = null;
  try {
    app = await launchApp(target, { label: "torn-off-dirty-crash", userDataDir });
    await waitForRows(app.cdp, 20000);

    const tab2Id = await shell(app.cdp, "createTab", {});
    cdp2 = await connectTab(app, tab2Id);
    await waitForRows(cdp2, 20000);

    await addMarkerRow(cdp2, marker);
    const write = await flushDraft(cdp2);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));

    const window2Id = await shell(app.cdp, "moveTabToWindow", { tabId: tab2Id, windowId: null });
    record(tag + ": setup — the dirty tab is torn off into a new window", !!window2Id);

    await crashApp(app);
    app = null;

    app = await launchApp(target, { label: "torn-off-dirty-crash-relaunch", userDataDir });
    await waitForRows(app.cdp, 20000);

    const listing = await pollNode(async () => {
      const l = await shell(app.cdp, "listTargets", {});
      const allTabs = l.windows.flatMap((w) => w.tabs);
      return allTabs.some((t) => t.dirty) ? l : null;
    }, 20000).catch(() => null);
    record(tag + ": relaunch recovers the torn-off tab's unsaved work", !!listing, JSON.stringify(listing));

    if (listing) {
      const allTabs = listing.windows.flatMap((w) => w.tabs);
      const dirtyTabs = allTabs.filter((t) => t.dirty);
      record(tag + ": exactly one tab is recovered, and it is the original tab id",
        dirtyTabs.length === 1 && dirtyTabs[0].tabId === tab2Id, JSON.stringify(dirtyTabs));
    }
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

/* ----------------------------------------------------------------------
 * Issue #86: the teleprompter's "Open in browser".
 *
 * No test can watch a real default browser start, so TEST_MODE stubs
 * shell.openExternal (main.js section 1) and records every URL it WOULD have
 * opened; __testShell('externalOpens') reads them back. What IS real here:
 * main choosing what to share from the tab's own record, the file read off
 * disk, the loopback listener (desktop/prompter-share.js) answering over
 * real HTTP, the save-first path, and the share going away with its tab.
 * The browser page's own half (reading #script=, opening the prompter) is
 * the browser suite 58-prompter-open-in-browser.txt.
 * -------------------------------------------------------------------- */

const PROMPTER_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/\?teleprompter=1#script=([0-9a-f]{64})$/;

/* fetch() will not send a Host header of the caller's choosing, which is the
   whole point of this probe — a DNS-rebinding page's request names the
   attacker's host — so it goes over node:http instead. */
function statusWithHost(port, pathname, hostHeader) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET",
      headers: { host: hostHeader, connection: "close" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function externalOpens(cdp) {
  return (await shell(cdp, "externalOpens", {})) || [];
}

async function waitForExternalOpens(cdp, count, timeoutMs) {
  return pollNode(async () => {
    const list = await externalOpens(cdp);
    return list.length >= count ? list : null;
  }, timeoutMs || 15000).catch(() => null);
}

async function caseTeleprompterOpenInBrowserFile(target, fixturesDir) {
  const tag = target.name + " teleprompter: open in browser (file)";
  const marker = "PROMPTER-MARKER-" + Date.now();
  const fixturePath = writeFixture(fixturesDir, "prompter-open.splitpage", "Prompter — 🎬 Browser",
    [["Wide shot", "The first line the reader says out loud."], ["Close up", "A second line — with an em dash."]]);
  let app = null;
  try {
    /* No dialog answers at all: any native dialog this flow raised would be
       answered Cancel, and counted by testDialogsSeen. */
    app = await launchApp(target, { label: "prompter-open", fixtures: [fixturePath] });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Prompter — 🎬 Browser"), 20000);
    const dialogsBefore = await dialogsSeen(cdp);

    // --- the bridge takes no argument, and hands back no URL ------------
    const bridgeArity = await evalPage(cdp, "typeof window.splitpageDesktop.openPrompterInBrowser === 'function' && window.splitpageDesktop.openPrompterInBrowser.length");
    record(tag + ": the bridge has openPrompterInBrowser() and it takes no argument", bridgeArity === 0, "length=" + bridgeArity);

    // --- A: a clean file tab, from the View menu ------------------------
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('prompter-open-in-browser')", { awaitPromise: false });
    const opens1 = await waitForExternalOpens(cdp, 1);
    record(tag + ": View ▸ Present in Browser asks the OS to open exactly one URL", !!opens1 && opens1.length === 1, JSON.stringify(opens1));
    const m1 = opens1 && PROMPTER_URL_RE.exec(opens1[0]);
    record(tag + ": the URL is main's own loopback listener, ?teleprompter=1, token in the fragment", !!m1, opens1 ? opens1[0] : "");
    const toastOk = await toastContaining(cdp, "Opened in your browser", 10000);
    record(tag + ": the page says it opened, and that this window stays open", !!toastOk && toastOk.indexOf("stays open") !== -1, String(toastOk));

    let port1 = null, token1 = null;
    if (m1) {
      port1 = Number(m1[1]); token1 = m1[2];
      const base = `http://127.0.0.1:${port1}`;
      const page = await fetch(base + "/?teleprompter=1").then(async (r) => ({ status: r.status, text: await r.text() })).catch(() => null);
      record(tag + ": the listener serves the app page the desktop runs", !!page && page.status === 200 && page.text.indexOf('id="prompter"') !== -1,
        page ? "status=" + page.status : "no answer");
      const sw = await fetch(base + "/sw.js").then((r) => r.status).catch(() => null);
      record(tag + ": no service worker is offered on that origin", sw === 404, "status=" + sw);
      const script = await fetchJson(base + "/prompter-script/" + token1).catch(() => null);
      const onDisk = fs.readFileSync(fixturePath, "utf8");
      record(tag + ": the shared script is the saved file, byte for byte, under its own name",
        !!script && script.status === 200 && script.body && script.body.text === onDisk && script.body.name === "prompter-open.splitpage",
        script ? "status=" + script.status + " name=" + (script.body && script.body.name) : "no answer");
      record(tag + ": the shared script is served no-store", !!script && script.headers.get("cache-control") === "no-store",
        script ? String(script.headers.get("cache-control")) : "");
      const forged = await statusWithHost(port1, "/prompter-script/" + token1, "rebind.example:" + port1);
      record(tag + ": a request naming another Host is refused", forged === 403, "status=" + forged);
    }

    // --- B: dirty, from the teleprompter's own button -------------------
    await addMarkerRow(cdp, marker);
    const dirtyNow = await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent.indexOf('\\u2022') !== -1); })()", 10000).catch(() => false);
    record(tag + ": setup — the tab is dirty", !!dirtyNow);
    await evalPage(cdp, "document.getElementById('btn-present').click(); true", { awaitPromise: false });
    await poll(cdp, "!document.getElementById('prompter').hidden", 10000);
    const btn = await evalPage(cdp, "(function(){ var b = document.getElementById('pp-voice'); return { text: b.textContent, disabled: b.disabled }; })()");
    record(tag + ": on desktop the voice button reads 'Open in browser to use Follow My Voice' and is enabled",
      !!btn && btn.text === "Open in browser to use Follow My Voice" && btn.disabled === false, JSON.stringify(btn));
    await evalPage(cdp, "document.getElementById('pp-voice').click(); true", { awaitPromise: false });
    const opens2 = await waitForExternalOpens(cdp, 2);
    record(tag + ": the button saves first, then opens the browser", !!opens2 && opens2.length === 2, JSON.stringify(opens2));
    const onDisk2 = fs.readFileSync(fixturePath, "utf8");
    record(tag + ": the save landed on disk before the browser was asked", onDisk2.indexOf(marker) !== -1);
    record(tag + ": no native dialog was raised by any of it", (await dialogsSeen(cdp)) === dialogsBefore);
    const m2 = opens2 && opens2[1] && PROMPTER_URL_RE.exec(opens2[1]);
    if (m2) {
      const base2 = `http://127.0.0.1:${m2[1]}`;
      const script2 = await fetchJson(base2 + "/prompter-script/" + m2[2]).catch(() => null);
      record(tag + ": the browser gets the text just saved", !!script2 && script2.status === 200 && script2.body.text === onDisk2 && script2.body.text.indexOf(marker) !== -1,
        script2 ? "status=" + script2.status : "no answer");
      record(tag + ": same stable origin both times", Number(m2[1]) === port1, "ports " + port1 + " / " + m2[1]);
      const stale = await fetch(base2 + "/prompter-script/" + token1).then((r) => r.status).catch(() => null);
      record(tag + ": the tab's previous share is gone — one copy per tab, not one per click", stale === 404, "status=" + stale);
    } else {
      record(tag + ": the second URL has the listener's shape", false, opens2 ? String(opens2[1]) : "none");
    }
    const voiceStatus = await poll(cdp, "(function(){ var t = document.getElementById('pp-voice-status').textContent; return t.indexOf('Opened in your browser') !== -1 ? t : null; })()", 10000).catch(() => null);
    record(tag + ": the prompter's status line says so too", !!voiceStatus, String(voiceStatus));

    // --- C: the share goes with its tab ---------------------------------
    const tab1Id = await tabIdOfTarget(cdp);
    const status1 = await shell(cdp, "prompterShareStatus", {});
    record(tag + ": main holds exactly one share, for this tab", !!status1 && status1.listening === true &&
      status1.shares.length === 1 && status1.shares[0] === tab1Id, JSON.stringify(status1));
    const witnessId = await shell(cdp, "createTab", {});
    const witness = await connectTab(app, witnessId);
    await waitForRows(witness, 20000);
    await fireShell(cdp, "closeTab", { tabId: tab1Id });
    const closed = port1 ? await pollNode(() => portClosed(port1, "127.0.0.1"), 15000).catch(() => false) : false;
    record(tag + ": closing the tab drops its share and the listener closes", closed === true, "port=" + port1);
    const status2 = await shell(witness, "prompterShareStatus", {});
    record(tag + ": main holds no share afterwards", !!status2 && status2.listening === false && status2.shares.length === 0, JSON.stringify(status2));

    // --- D: a document with nowhere to live is not saved behind the back -
    const pristineBefore = await dialogsSeen(witness);
    await evalPage(witness, "window.__desktopTest.runMenuCommand('prompter-open-in-browser')", { awaitPromise: false });
    const saveFirst = await toastContaining(witness, "Save this script first", 10000);
    record(tag + ": an unsaved new document is told to save first", !!saveFirst, String(saveFirst));
    await sleep(500);
    record(tag + ": ... and no Save dialog appears for it", (await dialogsSeen(witness)) === pristineBefore);
    const opens3 = await externalOpens(witness);
    record(tag + ": ... and nothing is opened in the browser", opens3.length === 2, JSON.stringify(opens3.length));
    /* The first tab's connection died with it; teardown drives the witness. */
    try { cdp.close(); } catch { /* already gone */ }
    app.cdp = witness;
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

async function caseTeleprompterOpenInBrowserServer(target) {
  const tag = target.name + " teleprompter: open in browser (--library server document)";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  const marker = "PROMPTER-SERVER-" + Date.now();
  let app = null;
  try {
    app = await launchApp(target, { label: "prompter-server", flags: ["--library"], dataDir });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await poll(cdp, "fetch('/api/health').then(function(r){return r.status;})", 15000);
    const created = await evalPage(cdp,
      "fetch('/api/docs', { method:'POST', headers:{'content-type':'application/json'}, " +
      "body: JSON.stringify({ state: { title: 'Prompter Server Doc', rows: [] } }) }).then(function(r){ return r.json(); })");
    record(tag + ": setup — a server document is created", !!created && !!created.id, JSON.stringify(created));
    if (!created || !created.id) return;
    await evalPage(cdp, "window.splitpageDesktop.routeOpen({ kind: 'server', serverDocId: " + JSON.stringify(created.id) + " })");
    const opened = await poll(cdp, "(window.__splitpageFormats.state()||{}).title === 'Prompter Server Doc'", 15000).catch(() => false);
    record(tag + ": setup — the tab shows the server document", !!opened);

    await addMarkerRow(cdp, marker);
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('prompter-open-in-browser')", { awaitPromise: false });
    const opens = await waitForExternalOpens(cdp, 1);
    const info = await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");
    const expected = `http://127.0.0.1:${info && info.port}/?doc=${created.id}&teleprompter=1`;
    record(tag + ": the URL is this app's own document server, ?doc=<id>&teleprompter=1", !!opens && opens[0] === expected,
      JSON.stringify(opens) + " expected " + expected);
    const doc = info && info.port ? await fetchJson(`http://127.0.0.1:${info.port}/api/docs/${created.id}`) : null;
    const rows = doc && doc.body && doc.body.state && doc.body.state.rows || [];
    record(tag + ": the unsaved edit was saved to the server before the browser was asked",
      rows.some((r) => String(r.visualText || "").indexOf(marker) !== -1), "rows=" + rows.length);
    const status = await shell(cdp, "prompterShareStatus", {});
    record(tag + ": a server document needs no loopback share at all", !!status && status.listening === false && status.shares.length === 0, JSON.stringify(status));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(dataDir);
  }
}

/* ----------------------------------------------------------------------
 * 5c. Per-tab server connections (#11).
 *
 *     Every case here runs against REAL document servers — server/server.js
 *     forked by this harness on free loopback ports, each with its own PIN
 *     and its own data folder, and ALLOW_ORIGINS=splitpage://app so the
 *     desktop page may call them cross-origin exactly as it calls a
 *     colleague's shared session. The app itself is launched with no
 *     --library: none of these documents is on its own server.
 *
 *     Tabs are connected the way a person connects them — the Servers
 *     dialog's own form, the File menu's own "Open from the server…" picker
 *     — so the path under test is the real one, routeOpen and all.
 * -------------------------------------------------------------------- */

const SERVER_JS = path.join(DESKTOP_DIR, "..", "server", "server.js");

/* opts.port/opts.dataDir restart a server where an earlier one was — the
   same address and documents, a new session (and so a new token). */
async function startDocServer(pin, opts) {
  const o = opts || {};
  const port = o.port || await freePort();
  const dataDir = o.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-srv-"));
  const env = {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir,
    ALLOW_ORIGINS: "splitpage://app"
  };
  if (pin) env.JOIN_PIN = pin;
  delete env.READ_ONLY; delete env.NO_API; delete env.REVIEW_PIN; delete env.LAUNCH_TOKEN;
  const proc = spawn(process.execPath, [SERVER_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  const url = `http://127.0.0.1:${port}/`;
  const up = await pollNode(async () => {
    const r = await fetchJson(url + "api/health", {}, 2000);
    return r.ok;
  }, 15000).catch(() => false);
  if (!up) { killPid(proc.pid); throw new Error("document server never came up on " + port + ": " + err); }
  return {
    url, port, pin, dataDir, proc,
    async stop() {
      killPid(proc.pid);
      await waitForExit(proc, 5000);
    },
    cleanup() { rmrf(dataDir); }
  };
}

async function joinDocServer(srv) {
  const r = await fetchJson(srv.url + "api/join", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: srv.pin })
  });
  return r.body && r.body.token;
}

async function createServerDoc(srv, token, title) {
  const r = await fetchJson(srv.url + "api/docs", {
    method: "POST", headers: { "content-type": "application/json", "x-splitpage-token": token },
    body: JSON.stringify({ state: { title, rows: [] } })
  });
  return r.body && r.body.id ? r.body : null;
}

async function readServerDoc(srv, token, id) {
  const r = await fetchJson(srv.url + "api/docs/" + encodeURIComponent(id), { headers: { "x-splitpage-token": token } });
  return r.status === 200 ? r.body : null;
}

function serverDocHas(doc, marker) {
  const rows = (doc && doc.state && doc.state.rows) || [];
  return rows.some((r) => String(r.visualText || "").indexOf(marker) !== -1);
}

/* Who else the server says is in `docId`, asked as an observer of our own —
   a presence beat with a made-up tab id, which the server answers with
   everyone BUT that id. */
async function presenceOthers(srv, token, docId) {
  const r = await fetchJson(srv.url + "api/presence", {
    method: "POST", headers: { "content-type": "application/json", "x-splitpage-token": token },
    body: JSON.stringify({ docId, id: "smoke-observer", name: "Observer", rowId: "", field: "", gone: false })
  });
  return r.body && Array.isArray(r.body.here) ? r.body.here : null;
}

const connOf = (cdp) => evalPage(cdp, "window.__hostedTest.conn()");

/* The Servers dialog's own "add a server" form, PIN and all — which joins,
   saves the bookmark and points THIS tab there (20e-connect.js). ssh is
   {userHost, remotePort, localPort} to fill in the SSH fields too. */
async function connectTabViaDialog(cdp, srv, opts) {
  const o = opts || {};
  const js = "(function(){" +
    "document.querySelector('#file-menu [data-file-action=\"servers\"]').click();" +
    "document.getElementById('connect-name').value=" + JSON.stringify(o.name || ("Srv " + srv.port)) + ";" +
    "document.getElementById('connect-url').value=" + JSON.stringify(srv.url) + ";" +
    "document.getElementById('connect-pin').value=" + JSON.stringify(srv.pin || "") + ";" +
    "document.getElementById('connect-remember').checked=" + (o.remember ? "true" : "false") + ";" +
    (o.ssh
      ? "var t=document.getElementById('connect-ssh-toggle');t.checked=true;t.dispatchEvent(new Event('change'));" +
        "document.getElementById('connect-ssh-userhost').value=" + JSON.stringify(o.ssh.userHost) + ";" +
        "document.getElementById('connect-ssh-remote').value=" + JSON.stringify(String(o.ssh.remotePort)) + ";" +
        "document.getElementById('connect-ssh-local').value=" + JSON.stringify(String(o.ssh.localPort)) + ";"
      : "") +
    "document.querySelector('#connect-modal [data-connect-action=\"add\"]').click(); return true; })()";
  await evalPage(cdp, js, { awaitPromise: false });
  const ok = await poll(cdp, "(function(){ var c = window.__hostedTest.conn(); return c.serverUrl === " +
    JSON.stringify(srv.url) + " && c.hasToken && !document.getElementById('menu-server-open').hidden; })()", 20000)
    .catch(() => false);
  await evalPage(cdp, "(function(){ var b = document.querySelector('#connect-modal [data-connect-action=\"close\"]'); if (b) b.click(); return true; })()", { awaitPromise: false });
  return !!ok;
}

/* File ▸ Open from the server…, then that document's own row in the picker
   — which routes through main (21-events.js) with this tab's connection. */
async function openViaPicker(cdp, docId) {
  await evalPage(cdp, "(function(){ document.getElementById('menu-server-open').click(); return true; })()", { awaitPromise: false });
  const sel = "#server-modal [data-action=\"server-open\"][data-id=" + JSON.stringify(docId) + "]";
  const listed = await poll(cdp, "!!document.querySelector(" + JSON.stringify(sel) + ")", 15000).catch(() => false);
  if (!listed) return false;
  await evalPage(cdp, "(function(){ document.querySelector(" + JSON.stringify(sel) + ").click(); return true; })()", { awaitPromise: false });
  return true;
}

async function saveTabNow(cdp) {
  await evalPage(cdp, "(function(){ document.getElementById('btn-save').click(); return true; })()", { awaitPromise: false });
  return poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!b && b.textContent.indexOf('\\u2022') === -1 && !b.disabled; })()", 15000)
    .catch(() => false);
}

const titleExpr = (t) => "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify(t);

function tabRow(listing, tabId) {
  for (const w of listing.windows) for (const t of w.tabs) if (t.tabId === tabId) return t;
  return null;
}

/* Two tabs, two servers, one window: each tab keeps its own connection, the
   same document id on both servers is two documents (not "already open"),
   each server hears only its own tab, a save goes where its document is,
   a crashed tab comes back on ITS server although the other tab picked a
   server since, and closing one tab leaves the other connected. */
async function caseTwoServersSideBySide(target) {
  const tag = target.name + " per-tab connections: two servers side by side";
  let srvX = null, srvY = null, app = null, cdp2 = null;
  try {
    srvX = await startDocServer("111111");
    srvY = await startDocServer("222222");
    const tokX = await joinDocServer(srvX);
    const tokY = await joinDocServer(srvY);
    const twin = await createServerDoc(srvX, tokX, "Twin On X");
    record(tag + ": setup — a document on server X", !!twin, JSON.stringify(twin));
    if (!twin) return;
    /* The same id on server Y, holding a different script: the file is
       copied across with only its title changed, so the two servers really
       do hold one id each. */
    const text = fs.readFileSync(path.join(srvX.dataDir, twin.id + ".json"), "utf8").split("Twin On X").join("Twin On Y");
    fs.writeFileSync(path.join(srvY.dataDir, twin.id + ".json"), text, "utf8");
    const onY = await readServerDoc(srvY, tokY, twin.id);
    record(tag + ": setup — server Y holds the SAME id with its own script",
      !!onY && onY.state && onY.state.title === "Twin On Y", JSON.stringify(onY && onY.state && onY.state.title));

    app = await launchApp(target, { label: "two-servers" });
    const cdp1 = app.cdp;
    await waitForRows(cdp1, 20000);
    const tab1Id = await tabIdOfTarget(cdp1);

    record(tag + ": tab 1 joins server X through the Servers dialog", await connectTabViaDialog(cdp1, srvX));
    record(tag + ": tab 1 opens X's document from the picker", await openViaPicker(cdp1, twin.id));
    record(tag + ": tab 1 shows X's script", !!(await poll(cdp1, titleExpr("Twin On X"), 15000).catch(() => false)));

    const tab2Id = await shell(cdp1, "createTab", {});
    cdp2 = await connectTab(app, tab2Id);
    await waitForRows(cdp2, 20000);
    const fresh2 = await connOf(cdp2);
    record(tag + ": a new tab does not inherit tab 1's token", !!fresh2 && fresh2.hasToken === false, JSON.stringify(fresh2));

    record(tag + ": tab 2 joins server Y through the Servers dialog", await connectTabViaDialog(cdp2, srvY));
    record(tag + ": tab 2 opens Y's document — the same id — from the picker", await openViaPicker(cdp2, twin.id));
    record(tag + ": tab 2 shows Y's script, not a switch to tab 1",
      !!(await poll(cdp2, titleExpr("Twin On Y"), 15000).catch(() => false)));

    const listing = await shell(cdp1, "listTargets", {});
    const all = listing.windows.reduce((n, w) => n + w.tabs.length, 0);
    const r1 = tabRow(listing, tab1Id), r2 = tabRow(listing, tab2Id);
    record(tag + ": still exactly two tabs — the same id on another server is another document", all === 2, "tabs=" + all);
    record(tag + ": main's source for tab 1 names server X and the document",
      !!r1 && r1.isServerDoc && r1.serverUrl === srvX.url && r1.serverDocId === twin.id, JSON.stringify(r1));
    record(tag + ": main's source for tab 2 names server Y and the same id",
      !!r2 && r2.isServerDoc && r2.serverUrl === srvY.url && r2.serverDocId === twin.id, JSON.stringify(r2));
    record(tag + ": tab 1 is still on X after tab 2 picked Y", (await connOf(cdp1)).serverUrl === srvX.url);
    record(tag + ": main keeps no token for a tab that routed its own document", !!r1 && !!r2 && !r1.hasToken && !r2.hasToken, JSON.stringify([r1 && r1.hasToken, r2 && r2.hasToken]));
    record(tag + ": each tab's review-role chip follows its own server (both editors here)",
      r1 && r1.role === "edit" && r2 && r2.role === "edit", JSON.stringify([r1 && r1.role, r2 && r2.role]));

    /* The heartbeat follows the document's connection: each server hears
       from its own tab and no other.

       Under SPLITPAGE_TEST=1 no window is ever shown (invariant #33), so
       every tab page reports document.hidden === true, and a hidden page
       deliberately sends no heartbeat (13a-presence.js; that rule has its
       own browser suite, 44-presence). What this case is about is WHICH
       server a beat goes to, so each page is told it is visible — a
       page-local override of one getter, nothing in the app — and beats
       once straight away. */
    const beatNow = "(function(){ Object.defineProperty(document, 'hidden', { configurable: true, get: function(){ return false; } }); " +
      "window.__presenceTest.beat(); return true; })()";
    await evalPage(cdp1, beatNow);
    await evalPage(cdp2, beatNow);
    const hereX = await pollNode(async () => { const h = await presenceOthers(srvX, tokX, twin.id); return h && h.length ? h : null; }, 15000).catch(() => null);
    const hereY = await pollNode(async () => { const h = await presenceOthers(srvY, tokY, twin.id); return h && h.length ? h : null; }, 15000).catch(() => null);
    await sleep(2500);
    const settledX = await presenceOthers(srvX, tokX, twin.id);
    const settledY = await presenceOthers(srvY, tokY, twin.id);
    const beatX = await evalPage(cdp1, "JSON.stringify({wanted: window.__presenceTest.wanted(), sends: window.__presenceTest.sends(), hidden: document.hidden})");
    const beatY = await evalPage(cdp2, "JSON.stringify({wanted: window.__presenceTest.wanted(), sends: window.__presenceTest.sends(), hidden: document.hidden})");
    record(tag + ": server X hears exactly one tab (tab 1)", !!hereX && settledX && settledX.length === 1, JSON.stringify(settledX) + " tab1=" + beatX);
    record(tag + ": server Y hears exactly one tab (tab 2)", !!hereY && settledY && settledY.length === 1, JSON.stringify(settledY) + " tab2=" + beatY);

    /* A save goes where its document lives. */
    const m1 = "ON-X-" + Date.now(), m2 = "ON-Y-" + Date.now();
    await addMarkerRow(cdp1, m1);
    record(tag + ": tab 1 saves", !!(await saveTabNow(cdp1)));
    await addMarkerRow(cdp2, m2);
    record(tag + ": tab 2 saves", !!(await saveTabNow(cdp2)));
    const docX = await readServerDoc(srvX, tokX, twin.id), docY = await readServerDoc(srvY, tokY, twin.id);
    record(tag + ": tab 1's edit is on server X and not on Y", serverDocHas(docX, m1) && !serverDocHas(docY, m1));
    record(tag + ": tab 2's edit is on server Y and not on X", serverDocHas(docY, m2) && !serverDocHas(docX, m2));

    /* Tab 2 picked Y last, so Y is where a FRESH page starts. Tab 1's page
       dies and comes back: it must come back on X, with its document. */
    const tokenFree = !JSON.stringify(await shell(cdp2, "listTargets", {})).includes(tokX);
    record(tag + ": the test shell's listing never carries a token", tokenFree);
    await crashRenderer(cdp1);
    try { cdp1.close(); } catch {}
    const back = await pollNode(async () => {
      const c = await connectTab(app, tab1Id);
      try {
        const ok = await evalPage(c, titleExpr("Twin On X"));
        const cn = ok ? await connOf(c) : null;
        return ok ? { cn } : null;
      } finally { c.close(); }
    }, 30000).catch(() => null);
    record(tag + ": a crashed tab reloads onto ITS server (X), not the last one picked (Y), with its document",
      !!back && back.cn.serverUrl === srvX.url, JSON.stringify(back));

    /* Closing tab 1 leaves tab 2 connected. */
    await shell(cdp2, "closeTab", { tabId: tab1Id });
    await pollShellState(cdp2, (l) => !tabRow(l, tab1Id), 15000).catch(() => null);
    const goneX = await pollNode(async () => { const h = await presenceOthers(srvX, tokX, twin.id); return h && h.length === 0 ? true : null; }, 25000).catch(() => false);
    record(tag + ": closing tab 1 takes it off server X's presence", !!goneX);
    const c2 = await connOf(cdp2);
    record(tag + ": tab 2 is still on server Y with its token after tab 1 closed",
      c2.serverUrl === srvY.url && c2.hasToken === true, JSON.stringify(c2));
    const m3 = "STILL-Y-" + Date.now();
    await addMarkerRow(cdp2, m3);
    record(tag + ": tab 2 still saves", !!(await saveTabNow(cdp2)));
    const docY2 = await readServerDoc(srvY, tokY, twin.id);
    record(tag + ": tab 2's save after tab 1 closed reached server Y", serverDocHas(docY2, m3), "rev=" + (docY2 && docY2.rev));
    const stillY = await presenceOthers(srvY, tokY, twin.id);
    record(tag + ": server Y still hears tab 2", !!stillY && stillY.length === 1, JSON.stringify(stillY));
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    for (const s of [srvX, srvY]) if (s) { await s.stop(); s.cleanup(); }
  }
}

/* A server tab beside a local-file tab, and a document opened from a tab
   that is NOT pristine: it goes to a new tab that boots on the right server
   with the token handed over (no PIN asked twice), while the file tab keeps
   its file. What reaches desktop-state.json is the server and the id,
   never the token or the PIN. */
async function caseServerTabBesideFileTab(target, fixturesDir) {
  const tag = target.name + " per-tab connections: a server tab beside a file tab";
  const fixture = writeFixture(fixturesDir, "case-conn-file.splitpage", "Local File Doc", [["local a", "local b"]]);
  let srv = null, app = null, cdp2 = null;
  try {
    srv = await startDocServer("333333");
    const tok = await joinDocServer(srv);
    const doc = await createServerDoc(srv, tok, "Hosted Beside");
    record(tag + ": setup — a document on the server", !!doc);
    if (!doc) return;

    app = await launchApp(target, { label: "file-beside-server", fixtures: [fixture] });
    const cdp1 = app.cdp;
    await waitForRows(cdp1, 20000);
    record(tag + ": tab 1 opens the local file", !!(await poll(cdp1, titleExpr("Local File Doc"), 20000).catch(() => false)));
    const tab1Id = await tabIdOfTarget(cdp1);
    const c1 = await connOf(cdp1);
    record(tag + ": a file tab starts on no remote server", c1.serverUrl === "" && !c1.hasToken, JSON.stringify(c1));

    /* The file tab joins the server itself — its FILE stays its home — and
       opens a document from it. Not pristine, so main opens a new tab. */
    record(tag + ": the file tab joins the server", await connectTabViaDialog(cdp1, srv));
    record(tag + ": joining leaves the file tab on its file", !!(await evalPage(cdp1, titleExpr("Local File Doc"))));
    await openViaPicker(cdp1, doc.id);
    const newId = await pollNode(async () => {
      const l = await shell(cdp1, "listTargets", {});
      for (const w of l.windows) for (const t of w.tabs) if (t.tabId !== tab1Id && t.isServerDoc) return t.tabId;
      return null;
    }, 20000).catch(() => null);
    record(tag + ": the server document opens in a NEW tab", !!newId);
    if (!newId) return;
    cdp2 = await connectTab(app, newId);
    const shown = await poll(cdp2, titleExpr("Hosted Beside"), 20000).catch(() => false);
    record(tag + ": the new tab shows the server document", !!shown);
    const pinUp = await evalPage(cdp2, "!document.getElementById('pin-modal').hidden");
    record(tag + ": the new tab was handed the token — no PIN asked a second time", pinUp === false);
    const c2 = await connOf(cdp2);
    record(tag + ": the new tab booted on the file tab's server", c2.serverUrl === srv.url && c2.hasToken, JSON.stringify(c2));

    const listing = await shell(cdp1, "listTargets", {});
    const r1 = tabRow(listing, tab1Id), r2 = tabRow(listing, newId);
    record(tag + ": main's source for tab 1 is still the file", !!r1 && !r1.isServerDoc && r1.path === fixture, JSON.stringify(r1));
    record(tag + ": main's source for the new tab names the server",
      !!r2 && r2.isServerDoc && r2.serverUrl === srv.url && r2.serverDocId === doc.id, JSON.stringify(r2));
    record(tag + ": main dropped the token once it had handed it to the new page", !!r2 && r2.hasToken === false, JSON.stringify(r2));

    const mFile = "FILE-" + Date.now(), mSrv = "SRV-" + Date.now();
    await addMarkerRow(cdp1, mFile);
    record(tag + ": the file tab saves", !!(await saveTabNow(cdp1)));
    await addMarkerRow(cdp2, mSrv);
    record(tag + ": the server tab saves", !!(await saveTabNow(cdp2)));
    const onDisk = fs.readFileSync(fixture, "utf8");
    const onSrv = await readServerDoc(srv, tok, doc.id);
    record(tag + ": the file tab's edit is in the file and not on the server", onDisk.includes(mFile) && !serverDocHas(onSrv, mFile));
    record(tag + ": the server tab's edit is on the server and not in the file", serverDocHas(onSrv, mSrv) && !onDisk.includes(mSrv));

    const state = await pollNode(async () => {
      const st = readDesktopStateFile(app.userDataDir);
      const tabsOnDisk = st ? st.windows.reduce((a, w) => a.concat(w.tabs), []) : [];
      return tabsOnDisk.find((t) => t.tabId === newId && t.source.kind === "server") ? { st, tabsOnDisk } : null;
    }, 15000).catch(() => null);
    const persisted = state && state.tabsOnDisk.find((t) => t.tabId === newId);
    record(tag + ": desktop-state.json records the server tab's server and id",
      !!persisted && persisted.source.serverUrl === srv.url && persisted.source.serverDocId === doc.id,
      JSON.stringify(persisted));
    record(tag + ": desktop-state.json's server source is exactly {kind, serverDocId, serverUrl, tunnel}",
      !!persisted && Object.keys(persisted.source).sort().join(",") === "kind,serverDocId,serverUrl,tunnel",
      JSON.stringify(persisted && persisted.source));
    const raw = fs.readFileSync(path.join(app.userDataDir, "desktop-state.json"), "utf8");
    record(tag + ": neither the token nor the PIN is anywhere in desktop-state.json (invariant #29)",
      !raw.includes(tok) && !raw.includes(srv.pin));
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    if (srv) { await srv.stop(); srv.cleanup(); }
  }
}

/* Session restore of server tabs on two servers. Nothing on disk holds a
   token, so each restored tab comes back on its own server and: reconnects
   silently where the reader chose "Remember on this device" for THAT
   server, asks for the PIN where they did not. A token or a role planted in
   desktop-state.json is not believed, an address that is not http(s) is
   not restored at all, and a tunnel's host and ports come back with the tab
   — so a tunnelled server that is down names the ssh command to start. */
async function caseRestoreServerTabs(target) {
  const tag = target.name + " per-tab connections: session restore of server tabs";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let srvX = null, srvY = null, app = null, cdpY = null, cdpX = null;
  try {
    srvX = await startDocServer("444444");
    srvY = await startDocServer("555555");
    const tokX = await joinDocServer(srvX), tokY = await joinDocServer(srvY);
    const dX = await createServerDoc(srvX, tokX, "Restore On X");
    const dY = await createServerDoc(srvY, tokY, "Restore On Y");
    record(tag + ": setup — one document on each server", !!dX && !!dY);
    if (!dX || !dY) return;
    const ssh = { userHost: "me@studio.example.com", remotePort: 8791, localPort: srvY.port };

    app = await launchApp(target, { label: "restore-servers-a", userDataDir });
    const cdp1 = app.cdp;
    await waitForRows(cdp1, 20000);
    const tabXId = await tabIdOfTarget(cdp1);
    record(tag + ": tab X joins X and asks to be remembered", await connectTabViaDialog(cdp1, srvX, { remember: true }));
    await openViaPicker(cdp1, dX.id);
    record(tag + ": tab X opens X's document", !!(await poll(cdp1, titleExpr("Restore On X"), 15000).catch(() => false)));
    const tabYId = await shell(cdp1, "createTab", {});
    const cdp2 = await connectTab(app, tabYId);
    await waitForRows(cdp2, 20000);
    record(tag + ": tab Y joins Y through an SSH bookmark, not remembered",
      await connectTabViaDialog(cdp2, srvY, { remember: false, ssh }));
    const cy = await connOf(cdp2);
    record(tag + ": tab Y's connection carries the tunnel's host and ports", !!cy.tunnel && cy.tunnel.userHost === ssh.userHost && cy.tunnel.localPort === ssh.localPort, JSON.stringify(cy));
    await openViaPicker(cdp2, dY.id);
    record(tag + ": tab Y opens Y's document", !!(await poll(cdp2, titleExpr("Restore On Y"), 15000).catch(() => false)));
    try { cdp2.close(); } catch {}

    const st = await pollNode(async () => {
      const s = readDesktopStateFile(userDataDir);
      const all = s ? s.windows.reduce((a, w) => a.concat(w.tabs), []) : [];
      const x = all.find((t) => t.tabId === tabXId), y = all.find((t) => t.tabId === tabYId);
      return x && y && x.source.kind === "server" && y.source.kind === "server" ? { s, x, y } : null;
    }, 15000).catch(() => null);
    record(tag + ": both server tabs are in desktop-state.json with their servers",
      !!st && st.x.source.serverUrl === srvX.url && st.y.source.serverUrl === srvY.url, JSON.stringify(st && [st.x.source, st.y.source]));
    record(tag + ": the tunnel's host and ports are persisted with tab Y (never a credential)",
      !!st && !!st.y.source.tunnel && st.y.source.tunnel.userHost === ssh.userHost &&
      Object.keys(st.y.source.tunnel).sort().join(",") === "localPort,remotePort,userHost", JSON.stringify(st && st.y.source.tunnel));
    await teardown(app, tag + " (first launch)");
    app = null;

    const raw1 = fs.readFileSync(path.join(userDataDir, "desktop-state.json"), "utf8");
    record(tag + ": no token and no PIN in desktop-state.json after the quit (invariant #29)",
      ![tokX, tokY, srvX.pin, srvY.pin].some((s) => raw1.includes(s)));
    const draftsHit = dirContainsText(path.join(userDataDir, "drafts"), tokY) || dirContainsText(path.join(userDataDir, "drafts"), tokX);
    record(tag + ": no token anywhere under drafts/", !draftsHit, String(draftsHit));

    /* Plant what must not be believed: a token and a role on both server
       sources, and a third tab whose address is not http(s). */
    const planted = JSON.parse(raw1);
    const PLANT = "f".repeat(64);
    for (const w of planted.windows) for (const t of w.tabs) {
      if (t.source.kind === "server") { t.source.token = PLANT; t.source.role = "edit"; }
    }
    const badTabId = newHexId();
    planted.windows[0].tabs.push({ tabId: badTabId, source: { kind: "server", serverDocId: dX.id, serverUrl: "javascript:alert(1)//" }, lastKnownTitle: "Bad" });
    writeDesktopStateFile(userDataDir, planted);

    app = await launchApp(target, { label: "restore-servers-b", userDataDir });
    cdpX = await connectTab(app, tabXId);
    const xBack = await poll(cdpX, titleExpr("Restore On X"), 25000).catch(() => false);
    const xPin = await evalPage(cdpX, "!document.getElementById('pin-modal').hidden");
    record(tag + ": the remembered server's tab reconnects silently and reopens its document", !!xBack && xPin === false,
      "pinUp=" + xPin);
    const cx = await connOf(cdpX);
    record(tag + ": the restored X tab is on X", cx.serverUrl === srvX.url, JSON.stringify(cx));

    cdpY = await connectTab(app, tabYId);
    const pinAsked = await poll(cdpY, "!document.getElementById('pin-modal').hidden && document.getElementById('pin-reason').textContent", 25000).catch(() => null);
    record(tag + ": the not-remembered server's tab asks for ITS PIN, naming its server",
      !!pinAsked && String(pinAsked).indexOf("127.0.0.1:" + srvY.port) !== -1, String(pinAsked));
    const cY = await connOf(cdpY);
    record(tag + ": the restored Y tab is on Y, with the tunnel it rode", cY.serverUrl === srvY.url && !!cY.tunnel && cY.tunnel.userHost === ssh.userHost, JSON.stringify(cY));
    const listing = await shell(cdpX, "listTargets", {});
    const rX = tabRow(listing, tabXId), rY = tabRow(listing, tabYId);
    record(tag + ": a token planted in desktop-state.json is not believed", !!rX && !!rY && rX.hasToken === false && rY.hasToken === false,
      JSON.stringify([rX, rY]));
    record(tag + ": a server tab whose address is not http(s) is not restored", !tabRow(listing, badTabId));

    await evalPage(cdpY, "(function(){ document.getElementById('pin-input').value=" + JSON.stringify(srvY.pin) +
      "; document.querySelector('#pin-modal [data-connect-action=\"pin-submit\"]').click(); return true; })()", { awaitPromise: false });
    record(tag + ": after the PIN, the Y tab reopens Y's document", !!(await poll(cdpY, titleExpr("Restore On Y"), 20000).catch(() => false)));
    const after = readDesktopStateFile(userDataDir);
    record(tag + ": the rewritten desktop-state.json holds no planted token", !!after && !JSON.stringify(after).includes(PLANT));

    /* The tunnel rides along: with Y down, the restored tab's reload says
       which ssh command it is waiting on. */
    await srvY.stop();
    await crashRenderer(cdpY);
    try { cdpY.close(); } catch {}
    cdpY = null;
    const hint = await pollNode(async () => {
      const c = await connectTab(app, tabYId);
      try {
        return await evalPage(c, "(function(){ var t=document.querySelectorAll('.toast'); for (var i=0;i<t.length;i++){ if (t[i].textContent.indexOf('SSH tunnel')!==-1) return t[i].textContent; } return null; })()");
      } finally { c.close(); }
    }, 30000).catch(() => null);
    record(tag + ": a tunnelled server that is down names the ssh command to start",
      !!hint && hint.indexOf("ssh -N -L " + ssh.localPort + ":localhost:" + ssh.remotePort + " " + ssh.userHost) !== -1, String(hint));

    /* The host restarts their session: same address, same documents, a new
       token. The X tab's token (remembered, and in its own session) is now
       stale; its reload finds that out on the document request, asks for
       the PIN, and opens the document once it is typed. */
    await srvX.stop();
    srvX = await startDocServer(srvX.pin, { port: srvX.port, dataDir: srvX.dataDir });
    await crashRenderer(cdpX);
    try { cdpX.close(); } catch {}
    cdpX = null;
    const stale = await pollNode(async () => {
      const c = await connectTab(app, tabXId);
      const up = await evalPage(c, "!document.getElementById('pin-modal').hidden").catch(() => false);
      if (!up) { c.close(); return null; }
      return c;
    }, 30000).catch(() => null);
    record(tag + ": a remembered token the restarted server no longer takes brings the PIN back", !!stale);
    if (stale) {
      cdpX = stale;
      await evalPage(cdpX, "(function(){ document.getElementById('pin-input').value=" + JSON.stringify(srvX.pin) +
        "; document.querySelector('#pin-modal [data-connect-action=\"pin-submit\"]').click(); return true; })()", { awaitPromise: false });
      record(tag + ": after the new PIN the X tab reopens its document",
        !!(await poll(cdpX, titleExpr("Restore On X"), 20000).catch(() => false)));
    }
  } finally {
    for (const c of [cdpX, cdpY]) if (c) { try { c.close(); } catch {} }
    if (app) { await teardown(app, tag); }
    for (const s of [srvX, srvY]) if (s) { await s.stop(); s.cleanup(); }
    rmrf(userDataDir);
  }
}

async function caseWindowCloseCanary() {
  const tag = "src/js window.close() canary";
  const srcDir = path.join(DESKTOP_DIR, "..", "src", "js");
  let files;
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

async function runTargetSuite(target, groupFilter) {
  console.log(`\n==== target: ${target.name} (${target.exe}) ====`);
  const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-fixtures-"));
  // Each group gets its own top-level guard: one group crashing outright
  // (not just failing an assertion — an uncaught exception past its own
  // internal try/finally) must not skip every group after it for this
  // target. Groups already tear down their own launches in their own
  // finally blocks; this only protects the group sequencing.
  const groups = [
    ["open/boot/security", () => caseBootAndSecurity(target)],
    ["open/save/conflict/save-as/export", () => caseOpenSaveConflictExport(target, fixturesDir)],
    ["second instance", () => caseSecondInstance(target, fixturesDir)],
    ["second instance (relative path)", () => caseSecondInstanceRelativePath(target, fixturesDir)],
    ["session restore", () => caseSessionRestore(target, fixturesDir)],
    ["--library", () => caseLibraryMode(target)],
    ["--host --pin", () => caseHostMode(target)],
    ["--host --pin (auto-generated)", () => caseHostModeAutoPin(target)],
    ["--host with no --pin (warning)", () => caseHostModeNoPinWarning(target)],
    ["update status", () => caseUpdateStatus(target)],
    ["update download", () => caseUpdateDownload(target)],
    ["update without a checksum", () => caseUpdateNoChecksum(target)],
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
    ["recents: recorded/listed/removed/cleared, capped and path-free", () => caseRecentDocuments(target, fixturesDir)],
    // --- step M: document id + desktop history ---
    ["save-in-place birthtime vs the duplicate rule", () => caseAtomicSaveKeepsBirthtime(target, fixturesDir)],
    ["duplicate document id across tabs (DOC-CLAIMS)", () => caseDuplicateDocIdAcrossTabs(target, fixturesDir)],
    ["history: round trip (put/list/get/copy/touch/import-older/usage) + relaunch", () => caseHistoryRoundTripAndRelaunch(target)],
    ["history: id validation", () => caseHistoryIdValidation(target)],
    ["history: exit-after-body fault, relaunch adopts the orphan", () => caseHistoryCrashAfterBody(target)],
    ["history: corrupt index.json rebuilt from bodies (fsck)", () => caseHistoryCorruptIndex(target)],
    ["history: cap-driven eviction + 50-per-document trim", () => caseHistoryCapEviction(target)],
    ["history: concurrent puts + a copy, one queue, two tabs", () => caseHistoryConcurrentPuts(target)],
    ["history: legacy localStorage migration into Older", () => caseHistoryLegacyMigration(target)],
    ["history: FORMAT ahead of ours goes read-only", () => caseHistoryNewerFormatReadOnly(target)],
    // --- step N: crash-safe drafts (single and multi tab) ---
    ["draft: crash-recovery of an untitled document", () => caseDraftCrashUntitled(target)],
    ["draft: renderer crash of a dirty file tab (F1F2-01)", () => caseDraftCrashDirtyFile(target, fixturesDir)],
    ["draft: file changed on disk while down (merge)", () => caseDraftFileChangedOnDisk(target, fixturesDir)],
    ["draft: file deleted while down (unsaved copy)", () => caseDraftFileDeleted(target, fixturesDir)],
    ["draft: quit without saving discards every draft", () => caseQuitWithoutSavingDeletesDrafts(target, fixturesDir)],
    ["draft: closing one tab without saving discards only that draft", () => caseLeaveWithoutSavingDeletesOnlyThatDraft(target, fixturesDir)],
    ["draft: power-cut mid-write keeps the first generation", () => caseDraftCrashMidWrite(target)],
    ["draft: both generations corrupt -> quarantined, seed boot", () => caseDraftCorrupt(target)],
    ["draft: ENOSPC pauses writes, one sticky toast, then resumes", () => caseDraftDiskFull(target)],
    ["draft: forged fileId opens as an untitled copy", () => caseDraftForgedFileId(target)],
    ["draft: no PIN, token or launch URL ever reaches disk", () => caseDraftNoSecrets(target)],
    ["draft: server document reachable at relaunch -> merged", () => caseDraftServerDocMerges(target)],
    ["draft: server document deleted while down -> unsaved copy", () => caseDraftServerGone(target)],
    ["draft: renderer crash of a clean tab (J-1)", () => caseRendererCrashRestores(target)],
    ["draft: clean tabs write nothing, even after idle", () => caseCleanTabsWriteNothing(target)],
    ["draft: a torn-off dirty tab crashes and restores exactly once", () => caseTornOffDirtyTabCrashRestoresOnce(target)],
    // --- issue #86: the teleprompter in the browser ---
    ["teleprompter: open in browser (file, save-first, share lifetime)", () => caseTeleprompterOpenInBrowserFile(target, fixturesDir)],
    ["teleprompter: open in browser (--library server document)", () => caseTeleprompterOpenInBrowserServer(target)],
    // --- issue #11: per-tab server and tunnel connections ---
    ["per-tab connections: two servers side by side, close one", () => caseTwoServersSideBySide(target)],
    ["per-tab connections: a server tab beside a file tab", () => caseServerTabBesideFileTab(target, fixturesDir)],
    ["per-tab connections: session restore of server tabs", () => caseRestoreServerTabs(target)],
    ["window.close() canary (src/js grep)", () => caseWindowCloseCanary()]
  ];
  try {
    for (const [name, fn, opts] of groups) {
      /* A group marked windowsOnly is named in the summary as a skip rather
         than run and failed, or — worse — quietly dropped. Nothing in the
         list carries the mark today: after #89 the only thing on this file
         that Windows alone can answer is one assertion inside the
         unsaved-changes case, which skips itself. The hook stays so the next
         genuinely Windows-bound case is skipped loudly instead of tempting
         somebody to weaken its assertion until it passes here. */
      // The debugging filter first: a group this run never asked for is not
      // "skipped because the platform cannot run it", and must not land in
      // the summary's skip list claiming that it was.
      if (groupFilter && !name.toLowerCase().includes(groupFilter)) continue;
      if (opts && opts.windowsOnly && !IS_WINDOWS) {
        skip(target.name + ": " + name + " (group)", WINDOWS_ONLY + " — " + opts.windowsOnly);
        continue;
      }
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
  const { exe, onlyTarget, onlyGroup } = parseCliArgs(process.argv.slice(2));
  const groupFilter = onlyGroup ? onlyGroup.toLowerCase() : null;
  let targets = resolveTargets(exe);
  if (onlyTarget) targets = targets.filter((t) => t.name === onlyTarget);
  if (!targets.length) {
    console.error(
      "No target found. Nothing to test.\n" +
      "  dev:      " + devElectronExe() + " (run `npm install` in desktop/)\n" +
      (IS_WINDOWS
        ? "  packaged: desktop/dist/win-unpacked/Splitpage.exe, desktop/dist/win-arm64-unpacked/Splitpage.exe\n"
        : "  packaged: Windows only — not looked for on " + process.platform + "\n"));
    process.exit(1);
  }
  console.log("Targets: " + targets.map((t) => t.name).join(", "));
  console.log("Platform: " + process.platform + "/" + process.arch +
    (process.platform === "linux" ? " (needs a display — run under `xvfb-run -a`)" : ""));
  if (groupFilter) {
    console.log("");
    console.log("!!! GROUP FILTER --only-group " + JSON.stringify(onlyGroup) + " — a DEBUGGING run.");
    console.log("!!! Most groups will not run at all. Whatever this prints is not coverage.");
  }

  for (const target of targets) {
    try {
      await runTargetSuite(target, groupFilter);
    } catch (e) {
      record(target.name + ": target suite", false, "uncaught exception: " + (e && e.stack || e));
    }
  }

  console.log("");
  /* The skip list prints BEFORE the pass/fail line and on every run, passing
     or not: the whole point of #89 is that a thinner run must not read as a
     full one. "ALL PASS" below always carries the skip count with it. */
  if (skippedLines.length) {
    console.log(`SKIPPED (${skippedLines.length}) — not run here, so not covered:`);
    skippedLines.forEach((l) => console.log("  - " + l));
    console.log("");
  } else {
    console.log("SKIPPED (0) — every check in this file ran.");
    console.log("");
  }
  const skipNote = (skippedLines.length ? `, ${skippedLines.length} skipped` : "") +
    (groupFilter ? ` — PARTIAL RUN, --only-group ${JSON.stringify(onlyGroup)}` : "");
  if (passedChecks === totalChecks) {
    console.log(`ALL PASS - ${passedChecks}/${totalChecks} desktop checks${skipNote}`);
    process.exit(0);
  } else {
    console.log(`FAILURES (${totalChecks - passedChecks}):`);
    failureLines.forEach((l) => console.log("  - " + l));
    console.log(`${passedChecks}/${totalChecks} desktop checks passed${skipNote}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("smoke.mjs crashed:", e && e.stack || e);
  process.exit(1);
});
