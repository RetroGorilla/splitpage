"use strict";

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDialogHelpers, modalShownExpr } from "./smoke-dialogs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseCliArgs(argv) {
  const out = { exe: null, onlyTarget: null, onlyGroup: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exe") out.exe = argv[++i];
    if (argv[i] === "--only-target") out.onlyTarget = argv[++i];
    if (argv[i] === "--only-group") out.onlyGroup = argv[++i];
  }
  return out;
}

const IS_WINDOWS = process.platform === "win32";

function devElectronExe() {
  const pkgDir = path.join(DESKTOP_DIR, "node_modules", "electron");
  const distDir = path.join(pkgDir, "dist");
  try {
    const recorded = fs.readFileSync(path.join(pkgDir, "path.txt"), "utf8").trim();
    if (recorded) return path.join(distDir, recorded);
  } catch { }
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
  if (IS_WINDOWS) {
    const x64Exe = path.join(DESKTOP_DIR, "dist", "win-unpacked", "Splitpage.exe");
    if (fs.existsSync(x64Exe)) targets.push({ name: "packaged-x64", kind: "packaged", exe: x64Exe });
    const arm64Exe = path.join(DESKTOP_DIR, "dist", "win-arm64-unpacked", "Splitpage.exe");
    if (fs.existsSync(arm64Exe)) {
      if (process.arch === "arm64") targets.push({ name: "packaged-arm64", kind: "packaged", exe: arm64Exe });
      else targets.push({ name: "packaged-arm64", kind: "packaged", exe: arm64Exe,
        cannotRun: "an arm64 build cannot start on this " + process.arch + " host — run it on the ARM machine" });
    }
  }
  return targets;
}

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

async function evalPage(cdp, expression, opts) {
  opts = opts || {};
  const params = {
    expression,
    awaitPromise: opts.awaitPromise !== false,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true
  };
  if (opts.userGesture) params.userGesture = true;
  const res = await cdp.send("Runtime.evaluate", params);
  if (res.exceptionDetails) {
    const ex = res.exceptionDetails.exception;
    const msg = (ex && (ex.description || ex.value)) || JSON.stringify(res.exceptionDetails);
    throw new Error("page eval failed: " + msg + " -- expr: " + expression.slice(0, 200));
  }
  return res.result ? res.result.value : undefined;
}

async function poll(cdp, expression, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evalPage(cdp, expression);
      if (last) return last;
    } catch { }
    await sleep(intervalMs || 250);
  }
  throw new Error("timed out waiting for: " + expression + " (last value: " + JSON.stringify(last) + ")");
}

async function waitForRows(cdp, timeoutMs) {
  return poll(cdp, "document.querySelectorAll('#rows > *').length", timeoutMs || 20000);
}

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

function parseTabIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = /[?&]tab=([^&]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

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

async function findPageTarget(port, timeoutMs, opts) {
  opts = opts || {};
  const wantTabId = opts.tabId || null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { tabTargets } = await findTargetsByKind(port);
      const candidates = wantTabId ? tabTargets.filter((t) => t.tabId === wantTabId) : tabTargets;
      if (candidates.length) return candidates[0];
    } catch { }
    await sleep(300);
  }
  throw new Error("no page target appeared on port " + port + (wantTabId ? " for tabId=" + wantTabId : ""));
}

async function tabIdOfTarget(cdp) {
  return evalPage(cdp, "(window.__desktopTest && window.__desktopTest.tabId) || null");
}

async function connectTab(app, tabId) {
  const t = await findPageTarget(app.port, 30000, { tabId });
  const cdp = new CDPConn(t.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

async function shell(cdp, op, args) {
  return evalPage(cdp, "window.splitpageDesktop.__testShell(" + JSON.stringify(op) + ", " + JSON.stringify(args === undefined ? null : args) + ")");
}

function parseDraftFile(p) {
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf8");
  const nl = text.indexOf("\n");
  const line1 = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? "" : text.slice(nl + 1);
  let header = null, state = null;
  try { header = JSON.parse(line1); } catch { }
  try { state = JSON.parse(rest); } catch { }
  return { header, state, bytes: Buffer.byteLength(text, "utf8") };
}

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

function readSession(userDataDir) {
  const p = path.join(userDataDir, "drafts", "session.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function addMarkerRow(cdp, marker) {
  const countExpr = "document.querySelectorAll('#rows .cell-editable[data-field=\"visualText\"]').length";
  let before = await evalPage(cdp, countExpr);
  for (let settle = Date.now() + 10000; Date.now() < settle;) {
    await new Promise((r) => setTimeout(r, 600));
    const now = await evalPage(cdp, countExpr);
    if (now === before) break;
    before = now;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await evalPage(cdp, "(function(){ var b = document.querySelector('.add-row-btn'); if (b) b.click(); return true; })()", { awaitPromise: false });
    const added = await poll(cdp, countExpr + " > " + before, 4000).then(() => true, () => false);
    if (added) break;
    const now = await evalPage(cdp, countExpr);
    if (now > before) break;
    if (now < before) before = now;
  }
  await poll(cdp, countExpr + " > " + before, 2000);
  const expr = "(function(){ var cells = document.querySelectorAll('#rows .cell-editable[data-field=\"visualText\"]'); " +
    "var cell = cells[cells.length - 1]; if (!cell) return false; cell.textContent = " + JSON.stringify(marker) + "; " +
    "cell.dispatchEvent(new Event('input', { bubbles: true })); return true; })()";
  const ok = await evalPage(cdp, expr, { awaitPromise: false });
  await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
  return ok;
}

async function flushDraft(cdp) {
  return evalPage(cdp, "window.__desktopTest.drafts.flushNow()");
}

async function draftStatusFor(cdp, tabId) {
  return evalPage(cdp, "window.splitpageDesktop.__testDraftStatus(" + (tabId ? JSON.stringify(tabId) : "") + ")");
}

function markerExpr(marker) {
  return "(function(){ var s = window.__splitpageFormats.state(); if (!s || !s.rows) return false; " +
    "return s.rows.some(function(r){ return (r.visualText || '').indexOf(" + JSON.stringify(marker) + ") !== -1; }); })()";
}
async function markerPresent(cdp, marker) {
  return evalPage(cdp, markerExpr(marker));
}
async function waitForMarker(cdp, marker, timeoutMs) {
  return poll(cdp, markerExpr(marker), timeoutMs || 20000).catch(() => false);
}

async function dialogsSeen(cdp) {
  const info = await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");
  return (info && typeof info.testDialogsSeen === "number") ? info.testDialogsSeen : 0;
}
async function waitForDialogAnswered(cdp, before, timeoutMs) {
  return poll(cdp, "window.splitpageDesktop.getSessionInfo().then(function(i){ return i && i.testDialogsSeen > " + before + "; })", timeoutMs || 10000)
    .catch(() => false);
}

async function isDirty(cdp) {
  return evalPage(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent.indexOf('\\u2022') !== -1); })()");
}

async function toastContaining(cdp, substr, timeoutMs) {
  return poll(cdp, "(function(){ var t = document.querySelectorAll('.toast'); for (var i = 0; i < t.length; i++) { " +
    "if (t[i].textContent.indexOf(" + JSON.stringify(substr) + ") !== -1) return t[i].textContent; } return null; })()",
    timeoutMs || 20000).catch(() => null);
}

function crashRenderer(cdp) {
  return fireEval(cdp, "window.splitpageDesktop.__testCrashRenderer()", { awaitPromise: false });
}

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

function newHexId() { return crypto.randomBytes(16).toString("hex"); }

function writeDesktopStateFile(userDataDir, state) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "desktop-state.json"), JSON.stringify(state), "utf8");
}

function readDesktopStateFile(userDataDir) {
  const p = path.join(userDataDir, "desktop-state.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function dirtyTabForTest(cdp) {
  await evalPage(cdp, "window.__desktopTest.markDirtyForTest(); true", { awaitPromise: false });
  await poll(cdp, "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()", 10000);
}

async function fireShell(cdp, op, args) {
  const expr = "window.splitpageDesktop.__testShell(" + JSON.stringify(op) + "," + JSON.stringify(args === undefined ? null : args) + ")";
  await fireEval(cdp, expr, { awaitPromise: false });
}

async function pollNode(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { }
    await sleep(intervalMs || 250);
  }
  throw new Error("pollNode: timed out (last value: " + JSON.stringify(last) + ")");
}

async function connectTarget(t) {
  const cdp = new CDPConn(t.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

async function pollShellState(cdp, predicate, timeoutMs) {
  return pollNode(async () => {
    const listing = await shell(cdp, "listTargets", {});
    return predicate(listing) ? listing : null;
  }, timeoutMs || 15000);
}

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

function randDocId() { return "d" + crypto.randomBytes(16).toString("hex"); }

function fileHomeKey(p) {
  const resolved = path.resolve(p);
  return "file:" + (IS_WINDOWS ? resolved.toLowerCase() : resolved);
}

function randSnapId(prefix) {
  return (prefix || "s") + crypto.randomBytes(6).toString("hex");
}

function historyMeta(overrides) {
  var now = Date.now();
  return Object.assign({
    id: randSnapId(), label: "snap", at: new Date(now).toISOString(), atMs: now,
    by: "smoke", rows: 1, title: "Doc", sizeBytes: 0, kind: "snapshot"
  }, overrides || null);
}

async function historyCall(cdp, method, args) {
  var argsJson = (args || []).map(function (a) { return JSON.stringify(a === undefined ? null : a); }).join(",");
  return evalPage(cdp, "window.splitpageDesktop." + method + "(" + argsJson + ")");
}

async function historyCallRejects(cdp, method, args) {
  try { await historyCall(cdp, method, args); return false; } catch { return true; }
}

function historyDirOnDisk(userDataDir) { return path.join(userDataDir, "history"); }
function historyShaHex(text) { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
function historyBodyPathOnDisk(userDataDir, sha) {
  return path.join(historyDirOnDisk(userDataDir), "bodies", "sha256", sha.slice(0, 2), sha);
}
function readHistoryIndexOnDisk(userDataDir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(historyDirOnDisk(userDataDir), name || "index.json"), "utf8")); }
  catch { return null; }
}
function historyBucketOnDisk(userDataDir, bucket) {
  const idx = readHistoryIndexOnDisk(userDataDir);
  return idx && idx.buckets ? idx.buckets[bucket] || null : null;
}
function writeHistoryFormatOnDisk(userDataDir, version) {
  var dir = historyDirOnDisk(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "FORMAT"), String(version) + "\n", "utf8");
}
function seedHistoryV2OnDisk(userDataDir, buckets, opts) {
  const o = opts || {};
  const dir = historyDirOnDisk(userDataDir);
  fs.mkdirSync(path.join(dir, "bodies", "sha256"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bodies", "FORMAT"), "1\n", "utf8");
  const doc = { formatVersion: 2, buckets: {}, trash: [] };
  for (const bucket of Object.keys(buckets)) {
    const snapshots = buckets[bucket].map(({ meta, body }) => {
      const sha = historyShaHex(body);
      const file = historyBodyPathOnDisk(userDataDir, sha);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, "utf8");
      return Object.assign({}, meta, { sizeBytes: Buffer.byteLength(body, "utf8"), sha });
    });
    doc.buckets[bucket] = { title: snapshots[snapshots.length - 1].title || "", lastOpenedAt: Date.now(), snapshots };
  }
  fs.writeFileSync(path.join(dir, o.file || "index.json"), JSON.stringify(doc), "utf8");
  writeHistoryFormatOnDisk(userDataDir, o.format || "2");
  return doc;
}

function historyV1SnapText(meta, stateJson) {
  return "splitpage-snapshot 1\n" + JSON.stringify(meta) + "\n" + stateJson;
}
function writeHistoryV1Snap(folder, meta, stateJson) {
  const m = Object.assign({}, meta, { sizeBytes: Buffer.byteLength(stateJson, "utf8") });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "s-" + m.id + ".snap"), historyV1SnapText(m, stateJson), "utf8");
  return m;
}
function seedHistoryV1Folders(root) {
  const docA = randDocId(), docB = randDocId();
  const body = (tag) => JSON.stringify({ rows: [{ id: "r1", text: "ünïcödé " + tag }], title: tag });
  const snap = (folder, id, atMs, extra) =>
    writeHistoryV1Snap(folder, historyMeta(Object.assign({ id, atMs, label: "L " + id, title: "" }, extra)), body(id));
  const a = path.join(root, "docs", "d-" + docA);
  const aList = [snap(a, "a01", 1000, { title: "Alpha 1" }), snap(a, "a02", 2000, { title: "Alpha" })];
  fs.writeFileSync(path.join(a, "index.json"), JSON.stringify({ formatVersion: 1, docId: docA, title: "Alpha", lastOpenedAt: 5000, snapshots: aList }), "utf8");
  fs.writeFileSync(path.join(a, ".tmp-0123456789ab-index.json"), "{\"formatVersion\":1,\"do", "utf8");
  const b = path.join(root, "docs", "d-" + docB);
  snap(b, "b01", 1500, { title: "Beta" });
  fs.writeFileSync(path.join(b, "index.json"), "{\"formatVersion\":1,\"docId\":\"" + docB + "\",\"tit", "utf8");
  const older = path.join(root, "older");
  const oList = [snap(older, "o01", 10, { kind: "legacy", legacyId: "k1" })];
  fs.writeFileSync(path.join(older, "index.json"), JSON.stringify({ formatVersion: 1, migratedAt: 0, expiresAt: 0, snapshots: oList }), "utf8");
  return { docA, docB };
}
function historyTreeDigest(dir) {
  const out = {};
  (function walk(d) {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join("/")] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  })(dir);
  return out;
}
function historyV1Digest(root) {
  return JSON.stringify({ docs: historyTreeDigest(path.join(root, "docs")), older: historyTreeDigest(path.join(root, "older")) });
}

async function sendSecondInstanceTo(target, userDataDir, filePath) {
  const port = await freePort();
  const flags = [...platformFlagsFor(target), `--remote-debugging-port=${port}`];
  const args = target.kind === "dev" ? [target.appPath, ...flags, filePath] : [...flags, filePath];
  const env = { ...process.env, SPLITPAGE_USER_DATA: userDataDir, SPLITPAGE_TEST: "1", SPLITPAGE_NO_UPDATE_CHECK: "1" };
  const proc = spawn(target.exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForExit(proc, 15000);
}

async function spawnAttempt(target, opts, userDataDir, port) {
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

  await sleep(150);
  if (spawnErr) throw new Error("failed to spawn " + target.exe + ": " + spawnErr.message);

  return { proc, dialogsPath, getStdout: () => stdout, getStderr: () => stderr };
}

async function launchApp(target, opts) {
  opts = opts || {};
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  if (!opts.userDataDir) fs.mkdirSync(userDataDir, { recursive: true });

  const maxAttempts = opts.skipCdp ? 1 : 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      killPid(proc.pid);
      await waitForExit(proc, 10000);
      if (attempt >= maxAttempts) {
        throw new Error("launchApp: CDP never came up after " + attempt + " attempt(s) on " + target.name + ": " + (lastErr && lastErr.message || lastErr), { cause: e });
      }
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
  const needles = substrings.map((s) => s.replace(/'/g, "''"));
  const conditions = needles.map((n) => `$_.CommandLine -like '*${n}*'`).join(" -or ");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and (${conditions}) } | Select-Object -ExpandProperty ProcessId`;
  const buf = Buffer.from(script, "utf16le");
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", buf.toString("base64")], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  } catch {
    return [];
  }
}

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
        const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        ppid = Number(after[1]) || 0;
      } catch { }
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

async function fireEval(cdp, expression, opts) {
  try {
    await Promise.race([evalPage(cdp, expression, opts), sleep(5000)]);
  } catch { }
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

async function waitForNoProcesses(userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let left = psProcessesMatching([userDataDir]);
  while (left.length && Date.now() < deadline) {
    await sleep(200);
    left = psProcessesMatching([userDataDir]);
  }
  return left;
}

const ENDS_DIRTY = "the case ends with a dirty tab, and test mode answers the unsaved-changes prompt Cancel";

async function teardown(app, tag, opts) {
  opts = opts || {};
  const notes = [];
  try { app.cdp && app.cdp.close(); } catch {}
  const expected = !!opts.expectForceKill;
  if (app.cdp && !expected) await closeBrowserGracefully(app);
  let exited = await waitForExit(app.proc, expected ? 500 : 12000);
  if (!exited) {
    if (expected) notes.push("force-killed by design: " + opts.expectForceKill);
    else {
      notes.push("did not exit after Browser.close; force-killed via killPid");
      unexpectedForceKills.push(tag || "(untagged teardown)");
    }
    killPid(app.proc.pid);
    exited = await waitForExit(app.proc, 30000);
    if (!exited) notes.push("process still reported alive after the force-kill");
  }
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
    if (opts.expectSignal !== undefined) {
      record(tag + ": killed by " + opts.expectSignal,
        app.proc.signalCode === opts.expectSignal,
        "exitCode=" + app.proc.exitCode + " signal=" + app.proc.signalCode);
    }
  }
  return notes;
}

async function crashApp(app) {
  killPid(app.proc.pid);
  const exited = await waitForExit(app.proc, 30000);
  try { app.cdp && app.cdp.close(); } catch {}
  return exited;
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

let totalChecks = 0, passedChecks = 0;
let groupsRun = 0;
const groupNames = new Set();
const failureLines = [];
const skippedLines = [];
const unexpectedForceKills = [];

function record(name, ok, detail) {
  totalChecks++;
  if (ok) passedChecks++;
  const line = (ok ? "PASS" : "FAIL") + " - " + name + (detail ? " :: " + detail : "");
  console.log(line);
  if (!ok) failureLines.push(name + (detail ? " :: " + detail : ""));
}

function skip(name, reason) {
  skippedLines.push(name + " :: " + reason);
  console.log("SKIP - " + name + " :: " + reason);
}

const WINDOWS_ONLY = "Windows-only probe (PowerShell/Win32), this run is on " + process.platform;

async function guarded(name, fn) {
  try {
    await fn();
  } catch (e) {
    record(name, false, "exception: " + (e && e.message ? e.message : String(e)));
  }
}

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

async function caseBootAndSecurity(target) {
  const tag = target.name + " boot+security";
  let app = null;
  try {
    app = await launchApp(target, { label: "boot" });
    const cdp = app.cdp;

    const url = await poll(cdp, "location.href !== 'about:blank' && location.href", 15000).catch(() => "about:blank");
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
      const outcome = await evalPage(cdp,
        "navigator.serviceWorker.getRegistrations().then(function(r){return {ok:true,length:r.length};})" +
        ".catch(function(e){return {ok:false,length:0,error:String(e && e.message || e)};})");
      const noSw = !!outcome && outcome.length === 0;
      record(tag + ": no service worker registered", noSw, JSON.stringify(outcome));
    });

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

    const stateTitle = await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify(openTitle), 20000);
    record(tag + ": argv-opened file's title reaches state", !!stateTitle, "");
    const rowCount = await evalPage(cdp, "window.__splitpageFormats.state().rows.length");
    record(tag + ": argv-opened file's row count matches", rowCount === 2, "rows=" + rowCount);

    await evalPage(cdp, "window.__splitpageFormats.state().title = " + JSON.stringify(savedTitle) + "; true");
    await evalPage(cdp, "window.__splitpageFormats.save()");
    let onDisk = null;
    for (let i = 0; i < 20 && onDisk === null; i++) {
      try { onDisk = JSON.parse(fs.readFileSync(fixturePath, "utf8")); } catch { await sleep(250); }
    }
    record(tag + ": save() writes the new title to disk, byte-exact non-ASCII", !!onDisk && onDisk.title === savedTitle, onDisk ? onDisk.title : "no parse");

    const beforeConflictBytes = fs.readFileSync(fixturePath);
    const st = fs.statSync(fixturePath);
    const bumped = new Date(st.mtime.getTime() + 5000);
    fs.utimesSync(fixturePath, bumped, bumped);
    await evalPage(cdp, "window.__splitpageFormats.save()");
    const conflictShown = await poll(cdp, "document.getElementById('file-conflict-modal') && document.getElementById('file-conflict-modal').hidden === false", 10000);
    record(tag + ": on-disk conflict shows #file-conflict-modal", !!conflictShown);
    const afterConflictBytes = fs.readFileSync(fixturePath);
    record(tag + ": conflicted file is left unchanged on disk", beforeConflictBytes.equals(afterConflictBytes));

    const dialogsBeforeRefusal = await dialogsSeen(cdp);
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    const refusalToast = await toastContaining(cdp, "Close the open dialog first.", 5000);
    await sleep(500);
    record(tag + ": Save As is refused behind the open conflict dialog, with a toast saying why",
      !!refusalToast && (await dialogsSeen(cdp)) === dialogsBeforeRefusal && !fs.existsSync(newSplitpagePath),
      "toast=" + JSON.stringify(refusalToast));

    const conflictCancelClicked = await evalPage(cdp, "(function(){ if (!" + modalShownExpr("file-conflict-modal") + ") return false; document.getElementById('file-conflict-cancel').click(); return true; })()");
    record(tag + ": the conflict dialog is still shown behind the refused Save As, and Cancel is clicked", conflictCancelClicked === true);
    const conflictClosed = await poll(cdp, "document.getElementById('file-conflict-modal').hidden === true", 5000).catch(() => false);
    record(tag + ": cancelling the conflict dialog closes it", !!conflictClosed);
    await poll(cdp, "document.querySelectorAll('.toast.error, .toast.warn').length === 0", 8000).catch(() => null);

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

    const problemToasts = "document.querySelectorAll('.toast.error, .toast.warn').length";
    const toastsBefore = await evalPage(cdp, problemToasts);
    const seenBeforeSaveAs = await dialogsSeen(cdp);
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    await waitForDialogAnswered(cdp, seenBeforeSaveAs);
    const toastsAfter = await evalPage(cdp, problemToasts);
    record(tag + ": cancelled Save As shows no error toast", toastsAfter === toastsBefore, `before=${toastsBefore} after=${toastsAfter}`);

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
      if (second.proc.exitCode === null) killPid(second.proc.pid);
      try { second.cdp.close(); } catch {}
    }
    if (first) {
      await teardown(first, tag);
    }
    rmrf(userDataDir);
  }
}

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

    const barWithoutReload = await poll(app.cdp,
      "(function(){ var b = document.getElementById('update-bar'); return b && b.hidden === false; })()", 15000);
    record(tag + ": the notice appears without a reload, from main's push", !!barWithoutReload);

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

    const updatesDir = path.join(app.userDataDir, "updates");
    const onDisk = fs.existsSync(path.join(updatesDir, mini.assetName));
    record(tag + ": the installer is in userData/updates", onDisk, updatesDir);
    record(tag + ": the page is never told the path",
      !JSON.stringify(after).includes(app.userDataDir), JSON.stringify(after.download));

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

async function caseCleanClose(target) {
  const tag = target.name + " clean close (regression)";
  let app = null;
  try {
    app = await launchApp(target, { label: "clean-close" });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);

    const t0 = Date.now();
    await fireEval(cdp, "window.close()", { awaitPromise: false, userGesture: true });
    const exited = await waitForExit(app.proc, 45000);
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

async function caseUnsavedChangesClose(target) {
  const tag = target.name + " unsaved-changes close";

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

    const stillDirty = await evalPage(cdp,
      "(function(){ var b = document.getElementById('btn-save'); return !!(b && b.textContent && b.textContent.indexOf('\\u2022') !== -1); })()"
    ).catch(() => null);
    record(tag + ": the same dirty document is still showing after 'cancel'", stillDirty === true, String(stillDirty));

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
    await waitForDialogAnswered(cdp2, seenBeforeClose2);
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
      await teardown(app2, tag + " (no pre-answered dialog)", { expectForceKill: ENDS_DIRTY });
      rmrf(app2.userDataDir);
    }
  }
}

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

    await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");

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
    await evalPage(cdp, "window.splitpageDesktop.getSessionInfo()");

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

    const seenBeforeQuit = await dialogsSeen(cdp);
    await fireEval(cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await waitForDialogAnswered(cdp, seenBeforeQuit);
    record(tag + ": quitting still prompts with no user gesture, and 'cancel' keeps the app alive",
      app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);

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

async function caseHostModeAutoPin(target) {
  const tag = target.name + " --host --pin (no value, auto-generated)";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  try {
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

async function caseHostModeNoPinWarning(target) {
  const tag = target.name + " --host with no --pin at all shows an explicit warning";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-data-"));
  let app = null;
  try {
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

    await sendSecondInstance(fixtureA);
    const reused = await poll(app.cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Route A Doc"), 15000).catch(() => null);
    record(tag + ": routing into a pristine tab reuses it (count stays 1)", !!reused);
    let listing = await shell(app.cdp, "listTargets", {});
    let totalTabs = listing.windows.reduce((n, w) => n + w.tabs.length, 0);
    record(tag + ": tab count is still 1 after the pristine reuse", totalTabs === 1, "total=" + totalTabs);

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
    const tabBId = newTabTarget.tabId;
    const gotB = await poll(cdpB, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Route B Doc — 🧭"), 15000).catch(() => null);
    record(tag + ": the new tab shows the second file's document", !!gotB);

    await sendSecondInstance(fixtureB);
    listing = await shell(app.cdp, "listTargets", {});
    totalTabs = listing.windows.reduce((n, w) => n + w.tabs.length, 0);
    record(tag + ": opening the same path again does not duplicate the tab (still 2)", totalTabs === 2, "total=" + totalTabs);
    let ownerWindow = listing.windows.find((w) => w.tabs.some((t) => t.tabId === tabBId));
    record(tag + ": the existing tab for that path is activated, not duplicated", !!ownerWindow && ownerWindow.activeTabId === tabBId, JSON.stringify(ownerWindow));

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function caseCloseTabCleanAndDirty(target) {
  const tag = target.name + " close-tab (same path as middle-click): clean vs dirty, only that tab";
  let app = null;
  let cdpWitness = null, cdpDirty = null;
  try {
    app = await launchApp(target, { label: "close-tab-clean-dirty", dialogs: ["cancel", "confirm"] });
    await waitForRows(app.cdp, 20000);
    const tab1Id = await tabIdOfTarget(app.cdp);

    const witnessId = await shell(app.cdp, "createTab", {});
    cdpWitness = await connectTab(app, witnessId);
    await waitForRows(cdpWitness, 20000);

    const cleanId = await shell(app.cdp, "createTab", {});
    await shell(app.cdp, "closeTab", { tabId: cleanId });
    let listing = await shell(app.cdp, "listTargets", {});
    let allTabIds = listing.windows.flatMap((w) => w.tabs.map((t) => t.tabId));
    record(tag + ": closing a clean tab removes it immediately, no dialog needed", allTabIds.indexOf(cleanId) === -1, JSON.stringify(allTabIds));
    record(tag + ": the app is still running", app.proc.exitCode === null);

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

    await fireShell(app.cdp, "closeTab", { tabId: tab1Id });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": the last tab closing takes the window, and the last window quit exits 0",
      exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

async function caseWindowCloseTwoDirtyTabs(target) {
  const tag = target.name + " window close: 2 dirty tabs + another window open (one dialog)";
  let ctx = null;
  try {
    ctx = await setupTwoDirtyWindows(target, { label: "window-close-2-dirty", dialogs: ["review", "confirm"] });
    const { app, tab1Id, window1Id, cdp1, cdp2, cdp3 } = ctx;

    await dirtyTabForTest(cdp1);
    await dirtyTabForTest(cdp2);

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

async function caseQuitTwoWindowsDirty(target) {
  const tag = target.name + " quit: dirty tabs in two windows (one answer per attempt)";
  let ctx = null;
  try {
    ctx = await setupTwoDirtyWindows(target, { label: "quit-2-windows-dirty", dialogs: ["review", "confirm"] });
    const { app, cdp1, cdp3 } = ctx;

    await dirtyTabForTest(cdp1);
    await dirtyTabForTest(cdp3);

    const seenBeforeReview = await dialogsSeen(cdp1);
    await fireEval(cdp1, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    await waitForDialogAnswered(cdp1, seenBeforeReview);
    record(tag + ": 'review' does not quit", app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);

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

    await fireEval(cdp2, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    const afterClose = await pollShellState(app.cdp, (l) => (l.windows.length === 1 ? l : null), 15000).catch(() => null);
    record(tag + ": closing a non-last window with nothing unsaved asks nothing and just closes",
      !!afterClose, afterClose ? "" : "window2 did not close cleanly");
    record(tag + ": the app is still running after the non-last close", app.proc.exitCode === null, "exitCode=" + app.proc.exitCode);

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
  }
}

async function caseRestoreAtLaunch(target, fixturesDir) {
  const tag = target.name + " restore at launch: two windows, order, active tab, missing file skipped";
  const fixtureKeep1 = writeFixture(fixturesDir, "case-restore-keep1.splitpage", "Restore Keep One", [["a", "b"]]);
  const fixtureKeep2 = writeFixture(fixturesDir, "case-restore-keep2.splitpage", "Restore Keep Two", [["g", "h"]]);
  const missingName = "case-restore-missing.splitpage";
  const fixtureMissing = path.join(fixturesDir, missingName);
  writeFixture(fixturesDir, missingName, "Restore Missing Doc", [["c", "d"]]);
  fs.unlinkSync(fixtureMissing);

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

    const onDisk = await pollNode(async () => {
      const st = readDesktopStateFile(userDataDir);
      return st && Array.isArray(st.recents) && st.recents.length === 2 ? st : null;
    }, 20000).catch(() => null);
    record(tag + ": the list is persisted in desktop-state.json", !!onDisk,
      JSON.stringify(onDisk && onDisk.recents));

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

    const forged = await pollNode(async () =>
      evalPage(cdp, "window.splitpageDesktop.removeRecent(" + JSON.stringify("f".repeat(32)) + ")"), 20000)
      .catch(() => null);
    record(tag + ": an unknown fileId removes nothing and does not throw",
      Array.isArray(forged) && forged.length === 1, JSON.stringify(forged));

    const goneId = afterRemove[0].fileId;
    fs.unlinkSync(fixtureB);
    const rejected = await poll(cdp,
      "window.splitpageDesktop && window.splitpageDesktop.routeOpen({kind:'file', fileId:" + JSON.stringify(goneId) + "})" +
      ".then(function(){ return 'resolved'; }, function(){ return 'rejected'; })", 20000);
    record(tag + ": reopening a deleted file rejects rather than opening nothing",
      rejected === "rejected", String(rejected));

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

  const tagB = target.name + " recents: capped at 20, de-duplicated, relative paths dropped";
  const userDataDirB = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const winIdB = newHexId(), tabIdB = newHexId();
  const many = [];
  for (let i = 0; i < 25; i++) {
    many.push({ absPath: path.join(fixturesDir, "many-" + i + ".splitpage"), title: "Many " + i, at: 1000 + i });
  }
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

async function caseAtomicSaveKeepsBirthtime(target, fixturesDir) {
  const tag = target.name + " save-in-place birthtime agrees with the duplicate rule";
  const aPath = path.join(fixturesDir, "case-m-birthtime-a.md");
  let app = null;
  try {
    app = await launchApp(target, { label: "atomic-save-birthtime", dialogs: [aPath] });
    await waitForRows(app.cdp, 20000);

    await evalPage(app.cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    let saveAsOk = false;
    for (let i = 0; i < 30 && !saveAsOk; i++) {
      if (fs.existsSync(aPath)) saveAsOk = true; else await sleep(250);
    }
    record(tag + ": setup — Save As creates A.md", saveAsOk);
    if (!saveAsOk) return;
    await sleep(300);

    const stBefore = fs.statSync(aPath);
    const birthtimeBefore = stBefore.birthtimeMs;

    await sleep(2500);

    await evalPage(app.cdp, "window.__splitpageFormats.save()");
    let onDiskAfter = null;
    for (let i = 0; i < 20 && onDiskAfter === null; i++) {
      try { onDiskAfter = fs.readFileSync(aPath, "utf8"); } catch { await sleep(250); }
    }
    record(tag + ": save-in-place writes A.md again", !!onDiskAfter);

    const stAfter = fs.statSync(aPath);
    const birthtimeAfter = stAfter.birthtimeMs;
    const preserved = birthtimeBefore === birthtimeAfter;

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

    record(tag + ": the verdict is symmetric — the same claim loses whichever way round it is asked",
      verdict !== null && mirrored !== null && verdict !== mirrored,
      "a,b=" + verdict + " b,a=" + mirrored);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

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

    await evalPage(app.cdp, "window.__desktopTest.runMenuCommand('save-as')", { awaitPromise: false });
    let saveAsOk = false;
    for (let i = 0; i < 30 && !saveAsOk; i++) {
      if (fs.existsSync(aPath)) saveAsOk = true; else await sleep(250);
    }
    record(tag + ": setup — Save As creates A.md", saveAsOk);
    if (!saveAsOk) { await teardown(app, tag); rmrf(app.userDataDir); rmrf(userDataDir); return; }
    await sleep(300);
    const idA = await poll(app.cdp, "window.__splitpageFormats.docId()", 10000);

    await sleep(2500);
    fs.copyFileSync(aPath, bPath);
    const aBytesOriginal = fs.readFileSync(aPath);
    const bBytesAfterCopy = fs.readFileSync(bPath);

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

    const homeKeyB = fileHomeKey(bPath);
    const toId = "d" + crypto.createHash("sha256")
      .update("splitpage-dup\n" + idA + "\n" + homeKeyB, "utf8").digest("hex").slice(0, 32);

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

    record(tag + ": B.md's bytes are unchanged on disk immediately after the reassignment (no autosave)",
      fs.readFileSync(bPath).equals(bBytesAfterCopy));
    record(tag + ": A.md's bytes are unchanged on disk", fs.readFileSync(aPath).equals(aBytesOriginal));

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

    const preQuitListing = await shell(app.cdp, "listTargets", {}).catch((e) => ({ error: String(e && e.message || e) }));
    await teardown(app, tag + " (pre-quit)");
    app = null;
    let persistedAtQuit = null;
    try { persistedAtQuit = JSON.parse(fs.readFileSync(path.join(userDataDir, "desktop-state.json"), "utf8")); }
    catch (e) { persistedAtQuit = { error: String(e && e.message || e) }; }

    const appRestored = await launchApp(target, { label: "dup-doc-id-restore", userDataDir });
    try {
      const pathLost = [];
      const sampleUntil = Date.now() + 4000;
      while (Date.now() < sampleUntil) {
        const l = await shell(appRestored.cdp, "listTargets", {}).catch(() => null);
        const tabs = (l && l.windows && l.windows[0] && l.windows[0].tabs) || [];
        for (const t of tabs) {
          if (!t.path && !pathLost.some((x) => x.tabId === t.tabId)) pathLost.push({ tabId: t.tabId, pristine: t.pristine, title: t.title });
        }
        await sleep(50);
      }
      record(tag + ": main never loses a restored tab's path while its page boots (invariant #42)",
        pathLost.length === 0, JSON.stringify(pathLost));
      await waitForRows(appRestored.cdp, 20000);
      const listing = await shell(appRestored.cdp, "listTargets", {});
      const w = listing.windows[0];
      const restoredA = w && w.tabs.find((t) => t.path && path.resolve(t.path).toLowerCase() === path.resolve(aPath).toLowerCase());
      const restoredB = w && w.tabs.find((t) => t.path && path.resolve(t.path).toLowerCase() === path.resolve(bPath).toLowerCase());
      let pageViews = null;
      if (!(restoredA && restoredB) && w && Array.isArray(w.tabs)) {
        pageViews = [];
        for (const t of w.tabs) {
          let c = null;
          try {
            c = await connectTab(appRestored, t.tabId);
            pageViews.push({ tabId: t.tabId, page: await evalPage(c,
              "JSON.stringify({home: window.__hostedTest && window.__hostedTest.home && window.__hostedTest.home(), " +
              "intent: window.splitpageDesktop && window.splitpageDesktop.launchIntent || null, " +
              "docId: window.__splitpageFormats && window.__splitpageFormats.docId()})") });
          } catch (e) { pageViews.push({ tabId: t.tabId, error: String(e && e.message || e) }); }
          finally { try { if (c) c.close(); } catch {} }
        }
      }
      record(tag + ": quit + relaunch restores both A.md and B.md tabs", !!restoredA && !!restoredB,
        JSON.stringify(w) + (restoredA && restoredB ? "" :
          " || before quit, main held: " + JSON.stringify(preQuitListing) +
          " || desktop-state.json after quit: " + JSON.stringify(persistedAtQuit) +
          " || each restored page: " + JSON.stringify(pageViews)));
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

async function caseHistoryRoundTripAndRelaunch(target) {
  const tag = target.name + " history: put/list/get/copy/touch/Older put/usage + relaunch";
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
    record(tag + ": first put succeeds, not a duplicate, sizeBytes is the body's UTF-8 length",
      putA && putA.ok === true && putA.duplicate === false && putA.sizeBytes === Buffer.byteLength(bodyA, "utf8") &&
      putA.evicted === 0 && putA.overCap === false, JSON.stringify(putA));

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
    record(tag + ": listed metas carry no document id and no sha (HISTORY-IPC's shape)",
      list1.entries.every((e) => !("docId" in e) && !("sha" in e)), JSON.stringify(list1.entries[0]));

    const got = await historyCall(cdp, "historyGet", [{ docId }, metaA.id]);
    record(tag + ": get returns the body verbatim",
      !!got && got.stateJson === bodyA && got.meta.id === metaA.id && !("docId" in got.meta), JSON.stringify(got && got.meta));
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
    const recAfterTouch = historyBucketOnDisk(userDataDir, docId);
    record(tag + ": touch updates the bucket's title in index.json",
      !!recAfterTouch && recAfterTouch.title === "Touched Title", JSON.stringify(recAfterTouch && recAfterTouch.title));
    const untouchedDocId = randDocId();
    await historyCall(cdp, "historyTouch", [untouchedDocId, "Should not exist"]);
    record(tag + ": touch never creates a record for a document with no history",
      historyBucketOnDisk(userDataDir, untouchedDocId) === null, "");

    const olderEntries = [
      { meta: historyMeta({ id: randSnapId("l"), label: "legacy1" }), stateJson: JSON.stringify({ rows: [] }) },
      { meta: historyMeta({ id: randSnapId("l"), label: "legacy2" }), stateJson: JSON.stringify({ rows: [] }) }
    ];
    const imp = [];
    for (const e of olderEntries) imp.push(await historyCall(cdp, "historyPut", [null, e.meta, e.stateJson, { older: true }]));
    record(tag + ": a put with {older:true} adds each entry into Older",
      imp.every((r) => r && r.ok === true && r.duplicate === false), JSON.stringify(imp));
    const impAgain = await historyCall(cdp, "historyPut", [null, olderEntries[0].meta, olderEntries[0].stateJson, { older: true }]);
    record(tag + ": …put-if-absent: the same Older entry again is a duplicate",
      impAgain && impAgain.ok === true && impAgain.duplicate === true, JSON.stringify(impAgain));
    const listOlder = await historyCall(cdp, "historyList", [null]);
    record(tag + ": list(null) reports the Older bucket",
      Array.isArray(listOlder.older) && listOlder.older.length === 2 && typeof listOlder.olderExpiresAt === "number",
      JSON.stringify(listOlder));

    const usage = listOlder.usage;
    record(tag + ": list's usage reports non-zero totalBytes, docCount>=2, not read-only",
      usage && usage.totalBytes > 0 && usage.docCount >= 2 && usage.readOnly === false &&
      usage.capBytes === 500 * 1024 * 1024 && usage.overCap === false, JSON.stringify(usage));
    const docs = await historyCall(cdp, "historyListDocs", []);
    const docRow = Array.isArray(docs) ? docs.find((d) => d.docId === docId) : null;
    record(tag + ": list-docs names both documents with title and lastOpenedAt, not Older",
      !!docRow && docRow.title === "Touched Title" && typeof docRow.lastOpenedAt === "number" &&
      docs.some((d) => d.docId === docId2) && !docs.some((d) => d.docId === "_older"), JSON.stringify(docs));

    const formatText = fs.readFileSync(path.join(historyDirOnDisk(userDataDir), "FORMAT"), "utf8").trim();
    record(tag + ": FORMAT is \"2\" on disk", formatText === "2", formatText);
    const idxOnDisk = readHistoryIndexOnDisk(userDataDir);
    const recA = idxOnDisk && idxOnDisk.buckets && idxOnDisk.buckets[docId];
    const shaA = historyShaHex(bodyA), shaB = historyShaHex(bodyB);
    record(tag + ": index.json has the documented shape, snapshots oldest first, each naming its body's sha",
      !!recA && idxOnDisk.formatVersion === 2 && Array.isArray(idxOnDisk.trash) &&
      recA.snapshots.length === 2 && recA.snapshots[0].id === metaA.id && recA.snapshots[1].id === metaB.id &&
      recA.snapshots[0].sha === shaA && recA.snapshots[1].sha === shaB && !("docId" in recA.snapshots[0]),
      JSON.stringify(idxOnDisk));
    let bodyOnDisk = null;
    try { bodyOnDisk = fs.readFileSync(historyBodyPathOnDisk(userDataDir, shaA), "utf8"); } catch { }
    record(tag + ": the body is stored verbatim under bodies/sha256/<aa>/<sha>", bodyOnDisk === bodyA, String(bodyOnDisk).slice(0, 80));
    const recCopy = idxOnDisk && idxOnDisk.buckets && idxOnDisk.buckets[docId2];
    record(tag + ": a copy is index-only — its entries name the same bodies",
      !!recCopy && JSON.stringify(recCopy.snapshots.map((s) => s.sha).sort()) === JSON.stringify([shaA, shaB].sort()),
      JSON.stringify(recCopy));
    record(tag + ": the index is kept in two generations (index.prev.json beside index.json)",
      !!readHistoryIndexOnDisk(userDataDir, "index.prev.json"), "");

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
      const olderAfterRelaunch = await historyCall(app2.cdp, "historyList", [null]);
      record(tag + ": after a relaunch, the Older bucket and its expiry are unchanged",
        olderAfterRelaunch.older.length === 2 && olderAfterRelaunch.olderExpiresAt === listOlder.olderExpiresAt,
        JSON.stringify(olderAfterRelaunch));
    } finally {
      await teardown(app2, tag + " (post-relaunch)");
      rmrf(app2.userDataDir);
    }
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function waitForQuietFile(file, quietMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null, since = Date.now();
  while (Date.now() < deadline) {
    let cur = null;
    try { cur = fs.readFileSync(file); } catch { }
    if (cur && last && cur.equals(last)) {
      if (Date.now() - since >= quietMs) return cur;
    } else {
      last = cur;
      since = Date.now();
    }
    await sleep(100);
  }
  return last;
}

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
    const olderMeta = historyMeta({ label: "older control" });
    const putOlderGood = await historyCall(cdp, "historyPut", [null, olderMeta, "{}", { older: true }]);
    record(tag + ": positive control — a put into Older with (null, …, {older:true}) succeeds",
      putOlderGood && putOlderGood.ok === true, JSON.stringify(putOlderGood));

    const stateFile = path.join(userDataDir, "desktop-state.json");
    const stateBefore = await waitForQuietFile(stateFile, 1000, 10000);
    const topLevelBefore = fs.readdirSync(userDataDir).sort();

    const badDocIds = ["../x", "..", "a/b", "a\\b", "CON", goodDocId.toUpperCase(),
      "d" + "a".repeat(31), "d" + "a".repeat(33), 42, null, "_older", ""];
    for (const bad of badDocIds) {
      const rejected = await historyCallRejects(cdp, "historyPut", [bad, historyMeta(), "{}"]);
      record(tag + ": historyPut(" + JSON.stringify(bad) + ", …) rejects", rejected, "");
    }
    for (const bad of badDocIds) {
      if (bad === null) continue;
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

    for (const [label, args] of [
      ["'_older' with {older:true}", ["_older", historyMeta(), "{}", { older: true }]],
      ["a real docId with {older:true}", [goodDocId, historyMeta(), "{}", { older: true }]],
      ["null with {older:'true'}", [null, historyMeta(), "{}", { older: "true" }]],
      ["null with {older:1}", [null, historyMeta(), "{}", { older: 1 }]]
    ]) {
      const rejected = await historyCallRejects(cdp, "historyPut", args);
      record(tag + ": historyPut(" + label + ", …) rejects", rejected, "");
    }
    const olderAfterRejects = await historyCall(cdp, "historyList", [null]);
    record(tag + ": …and Older still holds only the positive control",
      olderAfterRejects.older.length === 1 && olderAfterRejects.older[0].id === olderMeta.id, JSON.stringify(olderAfterRejects.older));

    const stateAfter = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
    const topLevelAfter = fs.readdirSync(userDataDir).sort();
    record(tag + ": desktop-state.json is byte-identical after every rejected call",
      (stateBefore === null && stateAfter === null) || (!!stateBefore && !!stateAfter && stateBefore.equals(stateAfter)),
      "before=" + (stateBefore ? stateBefore.length : "null") + " after=" + (stateAfter ? stateAfter.length : "null"));
    record(tag + ": nothing new appears at the top of userData (no traversal escape out of history/)",
      JSON.stringify(topLevelBefore) === JSON.stringify(topLevelAfter),
      JSON.stringify(topLevelBefore) + " vs " + JSON.stringify(topLevelAfter));

    const historyEntries = [];
    const historyRoot = historyDirOnDisk(userDataDir);
    if (fs.existsSync(historyRoot)) {
      (function walk(dir) {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          historyEntries.push(path.relative(historyRoot, p));
          if (fs.statSync(p).isDirectory()) walk(p);
        }
      })(historyRoot);
    }
    const suspicious = historyEntries.filter((e) => (/\.\.|CON|[A-Z]/.test(e)) && path.basename(e) !== "FORMAT");
    record(tag + ": history/ contains nothing named after a rejected id", suspicious.length === 0, JSON.stringify(historyEntries));
    const idx = readHistoryIndexOnDisk(userDataDir);
    record(tag + ": index.json names the control document and no bucket that is not a document id (or Older)",
      !!idx && !!idx.buckets[goodDocId] && Object.keys(idx.buckets).every((b) => /^d[0-9a-f]{32}$/.test(b) || b === "_older"),
      JSON.stringify(idx && Object.keys(idx.buckets)));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function caseHistoryKillAfterBody(target) {
  const tag = target.name + " history: exit-after-body fault — relaunch shows the prior generation, no error";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const docId = randDocId();
  const metaA = historyMeta({ label: "prior", atMs: 1000 });
  const bodyA = JSON.stringify({ rows: [{ id: "r1" }], title: "Prior" });
  seedHistoryV2OnDisk(userDataDir, { [docId]: [{ meta: metaA, body: bodyA }] });
  const meta = historyMeta({ label: "lost" });
  const body = JSON.stringify({ rows: [{ id: "r1" }, { id: "r2" }], title: "Lost" });
  let app = null;
  try {
    app = await launchApp(target, {
      label: "history-kill-after-body", userDataDir,
      env: { SPLITPAGE_TEST_HISTORY_FAULT: "exit-after-body" }
    });
    await waitForRows(app.cdp, 20000);

    await fireEval(app.cdp,
      "window.splitpageDesktop.historyPut(" + JSON.stringify(docId) + "," + JSON.stringify(meta) + "," + JSON.stringify(body) + ")",
      { awaitPromise: false });

    const exited = await waitForExit(app.proc, 20000);
    record(tag + ": the process actually exits (the fault fired)", exited);
    await teardown(app, tag + " (post-crash)", IS_WINDOWS ? { expectExitCode: 1 } : { expectSignal: "SIGKILL" });
    app = null;

    const sha = historyShaHex(body);
    record(tag + ": the snapshot body reached disk before the kill", fs.existsSync(historyBodyPathOnDisk(userDataDir, sha)), sha);
    const recBefore = historyBucketOnDisk(userDataDir, docId);
    record(tag + ": …but index.json is still the prior generation (A only, the new one unnamed)",
      !!recBefore && recBefore.snapshots.length === 1 && recBefore.snapshots[0].id === metaA.id, JSON.stringify(recBefore));

    const app2 = await launchApp(target, { label: "history-kill-after-body-relaunch", userDataDir });
    try {
      await waitForRows(app2.cdp, 20000);
      let list = null, listErr = "";
      try { list = await historyCall(app2.cdp, "historyList", [docId]); } catch (e) { listErr = String(e && e.message || e); }
      record(tag + ": the relaunch lists the prior generation — no error, no half-written entry",
        !!list && Array.isArray(list.entries) && list.entries.length === 1 && list.entries[0].id === metaA.id,
        listErr || JSON.stringify(list));
      const gotA = await historyCall(app2.cdp, "historyGet", [{ docId }, metaA.id]);
      record(tag + ": the prior snapshot's body reads back verbatim", !!gotA && gotA.stateJson === bodyA, "");
      const corrupt = fs.readdirSync(historyDirOnDisk(userDataDir)).filter((n) => n.includes(".corrupt-"));
      record(tag + ": no index generation was set aside as corrupt", corrupt.length === 0, JSON.stringify(corrupt));
      const again = await historyCall(app2.cdp, "historyPut", [docId, meta, body]);
      record(tag + ": the lost snapshot can be stored again", again && again.ok === true && again.duplicate === false, JSON.stringify(again));
      const list2 = await historyCall(app2.cdp, "historyList", [docId]);
      record(tag + ": …and is then listed newest first",
        list2.entries.length === 2 && list2.entries[0].id === meta.id, JSON.stringify(list2.entries.map((e) => e.id)));
    } finally {
      await teardown(app2, tag + " (post-relaunch)");
      rmrf(app2.userDataDir);
    }
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function caseHistoryTornIndex(target) {
  const tag = target.name + " history: torn index.json falls back to index.prev.json";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const docId = randDocId();
  const metaA = historyMeta({ label: "v1", atMs: 1000 });
  const metaB = historyMeta({ label: "v2", atMs: 2000 });
  const bodyA = JSON.stringify({ rows: [], title: "v1" });
  const bodyB = JSON.stringify({ rows: [{ id: "r1" }], title: "v2" });
  seedHistoryV2OnDisk(userDataDir, { [docId]: [{ meta: metaA, body: bodyA }] }, { file: "index.prev.json" });
  const newer = seedHistoryV2OnDisk(userDataDir, { [docId]: [{ meta: metaA, body: bodyA }, { meta: metaB, body: bodyB }] });
  const text = JSON.stringify(newer);
  fs.writeFileSync(path.join(historyDirOnDisk(userDataDir), "index.json"), text.slice(0, Math.floor(text.length / 2)), "utf8");

  let app = null;
  try {
    app = await launchApp(target, { label: "history-torn-index", userDataDir });
    await waitForRows(app.cdp, 20000);

    const list = await historyCall(app.cdp, "historyList", [docId]);
    const ids = (list.entries || []).map((e) => e.id);
    record(tag + ": the previous generation is loaded (A only)",
      ids.length === 1 && ids[0] === metaA.id, JSON.stringify(list));
    const gotA = await historyCall(app.cdp, "historyGet", [{ docId }, metaA.id]);
    record(tag + ": its body reads back verbatim", !!gotA && gotA.stateJson === bodyA, "");
    const names = fs.readdirSync(historyDirOnDisk(userDataDir));
    record(tag + ": the torn index.json is kept as index.json.corrupt-<ts>",
      names.some((n) => /^index\.json\.corrupt-\d+/.test(n)), JSON.stringify(names));

    const metaC = historyMeta({ label: "v3" });
    const putC = await historyCall(app.cdp, "historyPut", [docId, metaC, JSON.stringify({ rows: [], title: "v3" })]);
    record(tag + ": the next put succeeds", putC && putC.ok === true, JSON.stringify(putC));
    const rec = historyBucketOnDisk(userDataDir, docId);
    record(tag + ": …and writes a valid index.json naming A and the new snapshot",
      !!rec && JSON.stringify(rec.snapshots.map((s) => s.id)) === JSON.stringify([metaA.id, metaC.id]), JSON.stringify(rec));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

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

    const bigBody = (n) => JSON.stringify({ blob: "x".repeat(900000), n });
    const docOld = randDocId(), docNew = randDocId();
    const oldSnap1 = historyMeta({ id: randSnapId("o"), atMs: 10000 });
    const oldSnap2 = historyMeta({ id: randSnapId("o"), atMs: 10001 });
    await historyCall(cdp, "historyPut", [docOld, oldSnap1, bigBody(1)]);
    await historyCall(cdp, "historyPut", [docOld, oldSnap2, bigBody(2)]);
    const newSnap1 = historyMeta({ id: randSnapId("n"), atMs: 20000 });
    await historyCall(cdp, "historyPut", [docNew, newSnap1, bigBody(3)]);
    const newSnap2 = historyMeta({ id: randSnapId("n"), atMs: 20001 });
    const lastCapPut = await historyCall(cdp, "historyPut", [docNew, newSnap2, bigBody(4)]);

    const listOld = await historyCall(cdp, "historyList", [docOld]);
    const listNew = await historyCall(cdp, "historyList", [docNew]);
    const usage = listOld.usage || {};
    record(tag + ": list's usage stays at or under the TEST_MODE cap after eviction",
      usage.totalBytes <= CAP && usage.capBytes === CAP, "totalBytes=" + usage.totalBytes + " cap=" + usage.capBytes);
    record(tag + ": the put that crossed the cap reports it evicted something, and is no longer overCap",
      lastCapPut.evicted > 0 && lastCapPut.overCap === false, JSON.stringify(lastCapPut));

    record(tag + ": the document touched EARLIER (docOld) loses its oldest snapshot first, keeps its newest",
      listOld.entries.length === 1 && listOld.entries[0].id === oldSnap2.id, JSON.stringify(listOld));
    record(tag + ": the document touched LATER (docNew) keeps both of its snapshots",
      listNew.entries.length === 2, JSON.stringify(listNew));

    const evictedSha = historyShaHex(bigBody(1));
    const evictedPath = historyBodyPathOnDisk(userDataDir, evictedSha);
    const idx = readHistoryIndexOnDisk(userDataDir);
    record(tag + ": the evicted body waits in index.json's trash while index.prev.json still names it",
      !!idx && idx.trash.includes(evictedSha) && fs.existsSync(evictedPath), JSON.stringify(idx && idx.trash));
    const nextPut = await historyCall(cdp, "historyPut", [randDocId(), historyMeta(), "{}"]);
    record(tag + ": the next write succeeds", nextPut && nextPut.ok === true, JSON.stringify(nextPut));
    record(tag + ": …and the evicted body is gone from disk after it", !fs.existsSync(evictedPath), evictedPath);
    record(tag + ": the surviving snapshots' bodies are all still there",
      [2, 3, 4].every((n) => fs.existsSync(historyBodyPathOnDisk(userDataDir, historyShaHex(bigBody(n))))), "");
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

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
    record(tag + ": the Older bucket has both legacy entries after migration", !!list1, JSON.stringify(list1));
    const olderIds = list1 ? (list1.older || []).map((e) => e.id).sort() : [];
    record(tag + ": the migrated entries carry kind:'legacy' and the original ids",
      !!list1 && list1.older.every((e) => e.kind === "legacy") && JSON.stringify(olderIds) === JSON.stringify(["legacy-a", "legacy-b"]),
      JSON.stringify(list1 && list1.older));
    const expiresAt1 = list1 && list1.olderExpiresAt;
    record(tag + ": Older has an expiresAt set, in the future (90-day TTL from the migration)",
      typeof expiresAt1 === "number" && expiresAt1 > Date.now(), String(expiresAt1));

    const list2 = await seedLegacyKeyAndReload();
    record(tag + ": a repeat migration stays at 2 (put-if-absent, no duplicates)", !!list2, JSON.stringify(list2));
    record(tag + ": expiresAt is unchanged by the repeat (the bucket was not re-created)",
      !!list2 && list2.olderExpiresAt === expiresAt1, "before=" + expiresAt1 + " after=" + (list2 && list2.olderExpiresAt));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function caseHistoryNewerFormatReadOnly(target) {
  const tag = target.name + " history: FORMAT ahead of ours goes read-only";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const docId = randDocId();
  const seedMeta = historyMeta({ label: "pre-existing" });
  const seedBody = JSON.stringify({ rows: [], title: "Pre-existing" });
  seedHistoryV2OnDisk(userDataDir, { [docId]: [{ meta: seedMeta, body: seedBody }] }, { format: "3" });

  const dir = historyDirOnDisk(userDataDir);
  const bodyPath = historyBodyPathOnDisk(userDataDir, historyShaHex(seedBody));
  const mtimeBefore = fs.statSync(bodyPath).mtimeMs;
  const formatPath = path.join(dir, "FORMAT");
  const formatBytesBefore = fs.readFileSync(formatPath);
  const indexBytesBefore = fs.readFileSync(path.join(dir, "index.json"));

  let app = null;
  try {
    app = await launchApp(target, { label: "history-newer-format", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const list = await historyCall(cdp, "historyList", [docId]);
    record(tag + ": list still works read-only — the pre-existing snapshot is there",
      Array.isArray(list.entries) && list.entries.length === 1 && list.entries[0].id === seedMeta.id, JSON.stringify(list));
    const got = await historyCall(cdp, "historyGet", [{ docId }, seedMeta.id]);
    record(tag + ": get still works read-only", !!got && got.stateJson === seedBody, "");

    const put = await historyCall(cdp, "historyPut", [docId, historyMeta({ label: "should not land" }), "{}"]);
    record(tag + ": put on a newer-FORMAT folder refuses with code 'read-only'",
      put && put.ok === false && put.code === "read-only", JSON.stringify(put));

    record(tag + ": list's usage reports readOnly:true", !!list.usage && list.usage.readOnly === true, JSON.stringify(list.usage));
    const olderPut = await historyCall(cdp, "historyPut", [null, historyMeta({ label: "should not land either" }), "{}", { older: true }]);
    record(tag + ": a put into Older refuses with code 'read-only' too",
      olderPut && olderPut.ok === false && olderPut.code === "read-only", JSON.stringify(olderPut));
    record(tag + ": the pre-existing body's mtime is untouched", fs.statSync(bodyPath).mtimeMs === mtimeBefore, "");
    record(tag + ": index.json is byte-identical and no new generation was written",
      fs.readFileSync(path.join(dir, "index.json")).equals(indexBytesBefore) && !fs.existsSync(path.join(dir, "index.prev.json")), "");
    record(tag + ": FORMAT itself is never rewritten back down to our own version",
      fs.readFileSync(formatPath).equals(formatBytesBefore), "");
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function caseHistoryV1BackupRemoved(target) {
  const tag = target.name + " history: 3.0.0's v1-backup/ is deleted at launch";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const root = historyDirOnDisk(userDataDir);
  const docId = randDocId();
  const seedMeta = historyMeta({ label: "migrated by 3.0.0" });
  const seedBody = JSON.stringify({ rows: [{ id: "r1", text: "kept" }], title: "Kept" });
  seedHistoryV2OnDisk(userDataDir, { [docId]: [{ meta: seedMeta, body: seedBody }] });
  const idxSeed = readHistoryIndexOnDisk(userDataDir);
  idxSeed.migratedFrom = 1;
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify(idxSeed), "utf8");
  const backup = path.join(root, "v1-backup");
  seedHistoryV1Folders(backup);
  fs.mkdirSync(path.join(backup, "docs-1", "d-" + randDocId(), "deeper"), { recursive: true });
  const readOnlyFile = path.join(backup, "older", "s-readonly.snap");
  fs.writeFileSync(readOnlyFile, "splitpage-snapshot 1\n{}\n{}", "utf8");
  fs.chmodSync(readOnlyFile, 0o444);
  const backupFiles = Object.keys(historyTreeDigest(backup)).length;
  const bodiesBefore = JSON.stringify(historyTreeDigest(path.join(root, "bodies")));
  const bucketBefore = JSON.stringify(idxSeed.buckets[docId].snapshots);
  let app = null;
  try {
    app = await launchApp(target, { label: "history-v1-backup-removed", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;
    const gone = await pollNode(async () => !fs.existsSync(backup), 20000).catch(() => false);
    record(tag + ": v1-backup/ (" + backupFiles + " files, nested, one read-only) is gone soon after launch",
      gone === true && backupFiles >= 7, JSON.stringify(fs.existsSync(root) ? fs.readdirSync(root) : null));
    record(tag + ": nothing else under history/ went with it — no docs/ or older/ appeared, bodies/ byte-for-byte",
      !fs.existsSync(path.join(root, "docs")) && !fs.existsSync(path.join(root, "older")) &&
      JSON.stringify(historyTreeDigest(path.join(root, "bodies"))) === bodiesBefore, JSON.stringify(fs.readdirSync(root)));
    const list = await historyCall(cdp, "historyList", [docId]);
    record(tag + ": the v2 history is intact — the snapshot is listed, and the list carries no 'migrating'",
      Array.isArray(list.entries) && list.entries.length === 1 && list.entries[0].id === seedMeta.id && !("migrating" in list),
      JSON.stringify(list));
    const got = await historyCall(cdp, "historyGet", [{ docId }, seedMeta.id]);
    record(tag + ": …and its body reads back verbatim", !!got && got.stateJson === seedBody, "");
    const put = await historyCall(cdp, "historyPut", [docId, historyMeta({ label: "after", atMs: seedMeta.atMs + 1 }), "{\"rows\":[]}"]);
    record(tag + ": a put succeeds", put && put.ok === true, JSON.stringify(put));
    const idx = readHistoryIndexOnDisk(userDataDir);
    record(tag + ": the new generation keeps the old snapshot as it was, and migratedFrom:1",
      !!idx && idx.migratedFrom === 1 && JSON.stringify(idx.buckets[docId].snapshots.slice(0, 1)) === bucketBefore &&
      idx.buckets[docId].snapshots.length === 2, JSON.stringify(idx && idx.buckets[docId]));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function caseHistoryV1RawTreeDormant(target) {
  const tag = target.name + " history: a raw v1 tree is left dormant, history starts fresh";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const root = historyDirOnDisk(userDataDir);
  writeHistoryFormatOnDisk(userDataDir, 1);
  const seed = seedHistoryV1Folders(root);
  const v1Before = historyV1Digest(root);
  const v1Files = Object.keys(JSON.parse(v1Before).docs).length + Object.keys(JSON.parse(v1Before).older).length;
  const body = JSON.stringify({ rows: [{ id: "r1", text: "new" }], title: "Alpha again" });
  const meta = historyMeta({ label: "first v2 snapshot" });
  let app = null;
  try {
    app = await launchApp(target, { label: "history-v1-dormant", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;
    const empty = await historyCall(cdp, "historyList", [seed.docA]);
    record(tag + ": a v1 document lists nothing (not migrated) and the list answers normally",
      Array.isArray(empty.entries) && empty.entries.length === 0 && !("migrating" in empty) && !!empty.usage, JSON.stringify(empty));
    const put = await historyCall(cdp, "historyPut", [seed.docA, meta, body]);
    record(tag + ": a put succeeds", put && put.ok === true && put.duplicate === false, JSON.stringify(put));
    const list = await historyCall(cdp, "historyList", [seed.docA]);
    record(tag + ": …and is listed", list.entries.length === 1 && list.entries[0].id === meta.id, JSON.stringify(list.entries));
    const got = await historyCall(cdp, "historyGet", [{ docId: seed.docA }, meta.id]);
    record(tag + ": …and reads back verbatim", !!got && got.stateJson === body, "");
    const older = await historyCall(cdp, "historyList", [null]);
    record(tag + ": the Older bucket answers too (empty: v1's older/ is not read)",
      Array.isArray(older.older) && older.older.length === 0, JSON.stringify(older));
    await sleep(5000);
    record(tag + ": docs/ and older/ are byte-for-byte what they were (" + v1Files + " files, the torn index and the .tmp- file included)",
      historyV1Digest(root) === v1Before && v1Files >= 7, "");
    const idx = readHistoryIndexOnDisk(userDataDir);
    record(tag + ": a fresh index.json beside them — FORMAT \"2\", no migratedFrom",
      !!idx && idx.migratedFrom === undefined && Object.keys(idx.buckets).length === 1 &&
      fs.readFileSync(path.join(root, "FORMAT"), "utf8").trim() === "2", JSON.stringify(idx));

    await teardown(app, tag + " (pre-relaunch)");
    app = null;
    app = await launchApp(target, { label: "history-v1-dormant-relaunch", userDataDir });
    await waitForRows(app.cdp, 20000);
    const again = await historyCall(app.cdp, "historyList", [seed.docA]);
    record(tag + ": after a relaunch the v2 snapshot is still listed",
      again.entries.length === 1 && again.entries[0].id === meta.id, JSON.stringify(again.entries));
    await sleep(5000);
    record(tag + ": after a relaunch docs/ and older/ are still untouched", historyV1Digest(root) === v1Before, "");
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

function blobPngBytes(n) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n || 256)]);
}
function blobSha(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function blobBytesExpr(buf) { return "new Uint8Array(" + JSON.stringify([...buf]) + ")"; }

async function blobCall(cdp, method, argExprs) {
  return evalPage(cdp, "window.splitpageDesktop." + method + "(" + argExprs.join(",") + ")" +
    ".then(function (r) { return r && r.bytes ? { mime: r.mime, isU8: r.bytes instanceof Uint8Array, bytes: Array.from(r.bytes) } : r; })");
}
async function blobCallRejects(cdp, method, argExprs) {
  try { await blobCall(cdp, method, argExprs); return false; } catch { return true; }
}
function blobFilesOnDisk(userDataDir) {
  const root = path.join(userDataDir, "blobs");
  const out = [];
  (function walk(d) {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  })(root);
  return out.sort();
}

async function caseBlobRoundTripAndRelaunch(target) {
  const tag = target.name + " blobs: put/get/missing over the bridge + relaunch (#82)";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const bytes = blobPngBytes(512);
  const sha = blobSha(bytes);
  const absent = blobSha(blobPngBytes(16));
  let app = null;
  try {
    app = await launchApp(target, { label: "blobs-roundtrip", userDataDir });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    const bridgeHas = await evalPage(cdp, "['blobPut','blobGet','blobMissing'].every(function (k) { return typeof window.splitpageDesktop[k] === 'function'; })");
    record(tag + ": the bridge exposes blobPut, blobGet and blobMissing", bridgeHas === true, String(bridgeHas));

    const put1 = await blobCall(cdp, "blobPut", [JSON.stringify(sha), blobBytesExpr(bytes)]);
    record(tag + ": first put stores it", put1 && put1.ok === true && put1.stored === true, JSON.stringify(put1));
    const put2 = await blobCall(cdp, "blobPut", [JSON.stringify(sha), blobBytesExpr(bytes)]);
    record(tag + ": a second put of the same blob is a no-op (stored:false)", put2 && put2.ok === true && put2.stored === false, JSON.stringify(put2));

    const got = await blobCall(cdp, "blobGet", [JSON.stringify(sha)]);
    record(tag + ": get returns the bytes exactly, as a Uint8Array, with the sniffed mime",
      !!got && got.isU8 === true && got.mime === "image/png" && Buffer.from(got.bytes).equals(bytes),
      got ? JSON.stringify({ mime: got.mime, isU8: got.isU8, len: got.bytes.length }) : "null");
    const gotAbsent = await blobCall(cdp, "blobGet", [JSON.stringify(absent)]);
    record(tag + ": get of a sha never stored is null", gotAbsent === null, JSON.stringify(gotAbsent));

    const miss = await blobCall(cdp, "blobMissing", [JSON.stringify([sha, absent, absent])]);
    record(tag + ": missing() names only the absent sha, once", JSON.stringify(miss) === JSON.stringify([absent]), JSON.stringify(miss));

    const onDisk = blobFilesOnDisk(userDataDir);
    record(tag + ": on disk: FORMAT and sha256/<aa>/<sha>, nothing else",
      JSON.stringify(onDisk) === JSON.stringify(["FORMAT", "sha256/" + sha.slice(0, 2) + "/" + sha]), JSON.stringify(onDisk));
    record(tag + ": FORMAT is \"1\"", fs.readFileSync(path.join(userDataDir, "blobs", "FORMAT"), "utf8").trim() === "1", "");
    record(tag + ": the file is exactly the bytes",
      fs.readFileSync(path.join(userDataDir, "blobs", "sha256", sha.slice(0, 2), sha)).equals(bytes), "");
    const answers = JSON.stringify([put1, put2, miss]);
    record(tag + ": no answer names a path (invariant #28)",
      !answers.includes(userDataDir) && !answers.includes("blobs") && !answers.includes(path.sep + sha), answers);

    for (const bad of [sha.toUpperCase(), sha.slice(1), "../" + sha.slice(3), "..", path.join(userDataDir, "x"), ""]) {
      const r1 = await blobCallRejects(cdp, "blobGet", [JSON.stringify(bad)]);
      const r2 = await blobCallRejects(cdp, "blobPut", [JSON.stringify(bad), blobBytesExpr(bytes)]);
      record(tag + ": a bad sha " + JSON.stringify(bad.length > 40 ? bad.slice(0, 40) + "…" : bad) + " is refused by get and put", r1 && r2, "get=" + r1 + " put=" + r2);
    }
    const mismatch = await blobCall(cdp, "blobPut", [JSON.stringify(absent), blobBytesExpr(bytes)]);
    record(tag + ": a body that does not hash to its sha answers HASH_MISMATCH",
      mismatch && mismatch.ok === false && mismatch.code === "HASH_MISMATCH", JSON.stringify(mismatch));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const svgPut = await blobCall(cdp, "blobPut", [JSON.stringify(blobSha(svg)), blobBytesExpr(svg)]);
    record(tag + ": an SVG, even hashed right, answers NOT_AN_IMAGE",
      svgPut && svgPut.ok === false && svgPut.code === "NOT_AN_IMAGE", JSON.stringify(svgPut));
    const gifText = "GIF89a-but-a-string";
    const strPut = await blobCall(cdp, "blobPut", [JSON.stringify(blobSha(Buffer.from(gifText))), JSON.stringify(gifText)]);
    record(tag + ": a string body answers BAD_BYTES", strPut && strPut.ok === false && strPut.code === "BAD_BYTES", JSON.stringify(strPut));
    const tooMany = await blobCallRejects(cdp, "blobMissing", ["Array.from({length: 2001}, function () { return " + JSON.stringify(absent) + "; })"]);
    record(tag + ": missing() with more than 2000 shas rejects", tooMany, "");
    const notShas = await blobCallRejects(cdp, "blobMissing", [JSON.stringify([absent, "../escape"])]);
    record(tag + ": missing() with a non-sha entry rejects", notShas, "");
    const onDiskAfter = blobFilesOnDisk(userDataDir);
    record(tag + ": every refusal wrote nothing", JSON.stringify(onDiskAfter) === JSON.stringify(onDisk), JSON.stringify(onDiskAfter));

    await teardown(app, tag + " (pre-relaunch)");
    app = null;
    const strayTmp = path.join(userDataDir, "blobs", "sha256", absent.slice(0, 2), ".tmp-0123456789ab");
    fs.mkdirSync(path.dirname(strayTmp), { recursive: true });
    fs.writeFileSync(strayTmp, blobPngBytes(16));
    const app2 = await launchApp(target, { label: "blobs-roundtrip-relaunch", userDataDir });
    try {
      await waitForRows(app2.cdp, 20000);
      const again = await blobCall(app2.cdp, "blobGet", [JSON.stringify(sha)]);
      record(tag + ": after a relaunch, get returns the same bytes",
        !!again && again.mime === "image/png" && Buffer.from(again.bytes).equals(bytes), again ? String(again.bytes.length) : "null");
      const missAgain = await blobCall(app2.cdp, "blobMissing", [JSON.stringify([sha])]);
      record(tag + ": after a relaunch, missing() says it is held", JSON.stringify(missAgain) === "[]", JSON.stringify(missAgain));
      record(tag + ": the launch swept the stray .tmp- file", !fs.existsSync(strayTmp), strayTmp);
    } finally {
      await teardown(app2, tag + " (post-relaunch)");
    }
  } finally {
    if (app) await teardown(app, tag);
    rmrf(userDataDir);
  }
}

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

async function caseDraftCrashWithImage(target) {
  const tag = target.name + " draft crash-recovery: a picture comes back from the blob folder";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  const marker = "MARKER-IMAGE-" + Date.now();
  let appA = null, appB = null;
  try {
    appA = await launchApp(target, { label: "draft-image-crash-a", userDataDir });
    await waitForRows(appA.cdp, 20000);
    const tabId = await tabIdOfTarget(appA.cdp);

    await addMarkerRow(appA.cdp, marker);
    const dropExpr = "(function(){ var c = document.createElement('canvas'); c.width = 90; c.height = 60; var g = c.getContext('2d'); " +
      "g.fillStyle = '#c33'; g.fillRect(0, 0, 90, 60); g.fillStyle = '#39f'; g.fillRect(10, 10, 40, 25); " +
      "var u = c.toDataURL('image/png'); var bin = atob(u.slice(u.indexOf(',') + 1)); var b = new Uint8Array(bin.length); " +
      "for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); var dt = new DataTransfer(); " +
      "dt.items.add(new File([b], 'frame.png', { type: 'image/png' })); var media = document.querySelectorAll('#rows .visual-media'); " +
      "media[media.length - 1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()";
    await evalPage(appA.cdp, dropExpr, { awaitPromise: false });
    const refExpr = "(function(){ var s = window.__splitpageFormats.state(); var r = s.rows[s.rows.length - 1]; " +
      "return r.imageRef && r.imageRef.sha256 ? r.imageRef.sha256 : null; })()";
    const sha = await poll(appA.cdp, refExpr, 10000).catch(() => null);
    record(tag + ": the dropped picture is an imageRef on the row", typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha), String(sha));

    const write = await flushDraft(appA.cdp);
    record(tag + ": the flushed write lands", !!write && write.ok === true, JSON.stringify(write));
    const blobPath = sha ? "sha256/" + sha.slice(0, 2) + "/" + sha : null;
    record(tag + ": the picture's bytes are in the blob folder", !!blobPath && blobFilesOnDisk(userDataDir).indexOf(blobPath) !== -1,
      JSON.stringify(blobFilesOnDisk(userDataDir)));
    const dirs = readDraftDirs(userDataDir);
    const draftText = dirs[tabId] && dirs[tabId].current ? fs.readFileSync(path.join(dirs[tabId].dir, "current.draft"), "utf8") : "";
    record(tag + ": the draft names the picture and carries no base64",
      !!sha && draftText.indexOf(sha) !== -1 && draftText.indexOf("data:image") === -1, "draft " + draftText.length + " bytes");

    const crashed = await crashApp(appA);
    record(tag + ": crashApp actually kills the process", crashed === true);
    appA = null;

    appB = await launchApp(target, { label: "draft-image-crash-b", userDataDir });
    await waitForRows(appB.cdp, 20000);
    const cdp = appB.cdp;
    const gotMarker = await waitForMarker(cdp, marker, 20000);
    record(tag + ": the marker row is restored", !!gotMarker);
    const restoredRef = await evalPage(cdp, "(function(){ var s = window.__splitpageFormats.state(); " +
      "return s.rows.some(function(r){ return r.imageRef && r.imageRef.sha256 === " + JSON.stringify(sha) + "; }); })()");
    record(tag + ": the restored document still names the picture", restoredRef === true);
    const shown = await poll(cdp, "(function(){ var i = document.querySelector('#rows .visual-media img[data-blob=\"' + " + JSON.stringify(sha) + " + '\"]'); " +
      "return !!(i && (i.getAttribute('src') || '').indexOf('blob:') === 0 && i.complete && i.naturalWidth === 90); })()", 15000).catch(() => false);
    record(tag + ": the restored picture renders, read from the blob folder", shown === true);
  } finally {
    if (appA) await teardown(appA, tag + " (first launch)");
    if (appB) await teardown(appB, tag + " (second launch)", { expectForceKill: ENDS_DIRTY });
    rmrf(userDataDir);
  }
}

async function caseGalleryVideoFile(target) {
  const tag = target.name + " gallery: a dropped video file opens through main only (#135)";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-video-"));
  const clip = path.join(dir, "take one.mp4");
  const notes = path.join(dir, "notes.txt");
  fs.writeFileSync(clip, Buffer.alloc(4096, 1));
  fs.writeFileSync(notes, "not a video");
  let app = null;
  try {
    app = await launchApp(target, { label: "gallery-video-file" });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;
    const bridgeHas = await evalPage(cdp, "typeof window.splitpageDesktop.grantVideoFile === 'function' && typeof window.splitpageDesktop.openVideoFile === 'function'");
    record(tag + ": the bridge exposes grantVideoFile and openVideoFile", bridgeHas === true, String(bridgeHas));

    async function fileInput(id, filePath) {
      const made = await cdp.send("Runtime.evaluate", {
        expression: "(function(){ var i = document.createElement('input'); i.type = 'file'; i.id = " + JSON.stringify(id) + "; i.hidden = true; document.body.appendChild(i); return i; })()",
        returnByValue: false
      });
      await cdp.send("DOM.setFileInputFiles", { files: [filePath], objectId: made.result.objectId });
    }
    await fileInput("__vf", clip);
    await fileInput("__tf", notes);

    const token = await evalPage(cdp, "window.splitpageDesktop.grantVideoFile(document.getElementById('__vf').files[0])");
    record(tag + ": a video file with a path is granted an opaque token", typeof token === "string" && /^[0-9a-f]{32}$/.test(token), String(token));
    const again = await evalPage(cdp, "window.splitpageDesktop.grantVideoFile(document.getElementById('__vf').files[0])");
    record(tag + ": the same file is the same token", again === token, String(again));
    const made = await evalPage(cdp, "window.splitpageDesktop.grantVideoFile(new File([new Uint8Array(8)], 'forged.mp4', { type: 'video/mp4' }))");
    record(tag + ": a File the page made itself (no path) is refused", made === null, JSON.stringify(made));
    const text = await evalPage(cdp, "window.splitpageDesktop.grantVideoFile(document.getElementById('__tf').files[0])");
    record(tag + ": a file that is not a video is refused", text === null, JSON.stringify(text));

    const bogus = await evalPage(cdp, "window.splitpageDesktop.openVideoFile('" + "0".repeat(32) + "')");
    record(tag + ": a token main never gave opens nothing", !!bogus && bogus.ok === false && bogus.code === "UNKNOWN", JSON.stringify(bogus));
    const opened = await evalPage(cdp, "window.splitpageDesktop.openVideoFile(" + JSON.stringify(token) + ")");
    record(tag + ": its token opens it", !!opened && opened.ok === true, JSON.stringify(opened));
    let opens = await shell(cdp, "videoFileOpens", {});
    record(tag + ": main opened exactly that path", JSON.stringify(opens) === JSON.stringify([clip]), JSON.stringify(opens));

    await evalPage(cdp, "(function(){ var dt = new DataTransfer(); dt.items.add(document.getElementById('__vf').files[0]); " +
      "var media = document.querySelectorAll('#rows .visual-media'); media[media.length - 1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()", { awaitPromise: false });
    const link = await poll(cdp, "(function(){ var l = document.querySelectorAll('#rows .scene-gallery-caption .scene-gallery-link.is-file'); return l.length ? l[l.length - 1].textContent : null; })()", 10000).catch(() => null);
    record(tag + ": the drop names the file in the scene's caption", link === "take one.mp4", String(link));
    const statePath = await evalPage(cdp, "JSON.stringify(window.__splitpageFormats.state()).indexOf(" + JSON.stringify(dir.replace(/\\/g, "\\\\")) + ") !== -1 || JSON.stringify(window.__splitpageFormats.state()).indexOf(" + JSON.stringify(dir) + ") !== -1");
    record(tag + ": the document names the file, never where it is", statePath === false, String(statePath));
    await evalPage(cdp, "(function(){ var l = document.querySelectorAll('#rows .scene-gallery-caption .scene-gallery-link.is-file'); l[l.length - 1].click(); return true; })()");
    opens = await pollNode(async () => {
      const list = await shell(cdp, "videoFileOpens", {});
      return list && list.length >= 2 ? list : null;
    }, 10000).catch(() => null);
    record(tag + ": its caption link opens it through main", !!opens && opens[1] === clip, JSON.stringify(opens));

    fs.rmSync(clip);
    const gone = await evalPage(cdp, "window.splitpageDesktop.openVideoFile(" + JSON.stringify(token) + ")");
    record(tag + ": a file since deleted answers GONE", !!gone && gone.ok === false && gone.code === "GONE", JSON.stringify(gone));
  } finally {
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(dir);
  }
}

async function caseGalleryVideoThumbnail(target) {
  const tag = target.name + " gallery: a pasted video link's thumbnail comes through main, by host and id (#141)";
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, 1, 14, 1, 224, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 7, 0xFF, 0xD9]);
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 128, 0, 0, 1, 104]).copy(png);
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie || "", referer: req.headers.referer || "" });
    const base = "http://127.0.0.1:" + server.address().port;
    if (req.url === "/youtubeThumbs/vi/dQw4w9WgXcQ/hqdefault.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(jpeg); return; }
    if (req.url === "/youtubeThumbs/vi/zzzzzzzzzzz/hqdefault.jpg") { res.writeHead(302, { location: "/youtubeThumbs/vi/dQw4w9WgXcQ/hqdefault.jpg" }); res.end(); return; }
    if (req.url === "/youtubeThumbs/vi/bigbigbigbi/hqdefault.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.concat([jpeg, Buffer.alloc(2 * 1024 * 1024)])); return; }
    if (req.url.startsWith("/vimeoOembed/api/oembed.json?url=")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "video", thumbnail_url: base + "/vimeoThumbs/video/1-abc-d_640" }));
      return;
    }
    if (req.url === "/vimeoThumbs/video/1-abc-d_640") { res.writeHead(200, { "content-type": "image/png" }); res.end(png); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (host, ref) => "window.splitpageDesktop.videoThumbnail(" + JSON.stringify(host) + ", " + JSON.stringify(ref) + ").then(function (r) { " +
    "return r && r.ok ? { ok: true, mime: r.mime, isView: ArrayBuffer.isView(r.bytes), length: r.bytes.length, first: r.bytes[0] } : r; })";
  let app = null;
  try {
    app = await launchApp(target, { label: "gallery-video-thumbnail", env: { SPLITPAGE_TEST_VIDEO_BASE: base } });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;
    const has = await evalPage(cdp, "typeof window.splitpageDesktop.videoThumbnail === 'function'");
    record(tag + ": the bridge exposes videoThumbnail", has === true, String(has));

    const yt = await evalPage(cdp, call("youtube", "dQw4w9WgXcQ"));
    record(tag + ": a YouTube id's thumbnail comes back as bytes", !!yt && yt.ok === true && yt.mime === "image/jpeg" && yt.isView === true && yt.length === jpeg.length && yt.first === 0xFF, JSON.stringify(yt));
    const vm = await evalPage(cdp, call("vimeo", "76979871"));
    record(tag + ": a Vimeo id's thumbnail comes through its oEmbed answer", !!vm && vm.ok === true && vm.mime === "image/png", JSON.stringify(vm));
    const oembed = seen.filter((s) => s.url.startsWith("/vimeoOembed/"))[0];
    record(tag + ": the oEmbed question names the video's page on vimeo.com and nothing else",
      !!oembed && oembed.url === "/vimeoOembed/api/oembed.json?url=" + encodeURIComponent("https://vimeo.com/76979871") + "&width=640", JSON.stringify(oembed));
    record(tag + ": no cookie and no referrer is sent", seen.every((s) => !s.cookie && !s.referer), JSON.stringify(seen));

    let before = seen.length;
    const redirected = await evalPage(cdp, call("youtube", "zzzzzzzzzzz"));
    record(tag + ": a redirect is not followed", !!redirected && redirected.ok === false && seen.length === before + 1, JSON.stringify(redirected) + " " + (seen.length - before));
    const big = await evalPage(cdp, call("youtube", "bigbigbigbi"));
    record(tag + ": more than 1 MiB is refused", !!big && big.ok === false && big.code === "TOO_LARGE", JSON.stringify(big));
    const gone = await evalPage(cdp, call("youtube", "nnnnnnnnnnn"));
    record(tag + ": a video with no thumbnail answers NOT_FOUND", !!gone && gone.ok === false && gone.code === "NOT_FOUND", JSON.stringify(gone));

    before = seen.length;
    const refused = [];
    for (const [host, ref] of [["youtube", "https://evil.example/x.jpg"], ["loom", "dQw4w9WgXcQ"], ["https://i.ytimg.com", "dQw4w9WgXcQ"], ["vimeo", "dQw4w9WgXcQ"]]) {
      refused.push(await evalPage(cdp, call(host, ref)));
    }
    record(tag + ": a URL, another host, or an id of the wrong kind is refused and fetches nothing",
      refused.every((r) => r && r.ok === false) && seen.length === before, JSON.stringify(refused) + " " + (seen.length - before));

    await evalPage(cdp, "(function(){ var el = document.querySelector('#rows .row .audio-cell .cell-editable'); el.focus(); var d = new DataTransfer(); " +
      "d.setData('text/plain', 'https://youtu.be/dQw4w9WgXcQ'); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); return true; })()");
    const landed = await poll(cdp, "(function(){ var r = window.__splitpageFormats.state().rows[0]; var all = [r].concat(r.moreImages || []); " +
      "var hit = all.filter(function (it) { var l = (it.imageLinks || it.links || []).filter(function (x) { return x.poster && x.href === 'https://youtu.be/dQw4w9WgXcQ'; })[0]; return l && it.imageRef; })[0]; " +
      "return hit ? hit.imageRef.width + 'x' + hit.imageRef.height : null; })()", 10000).catch(() => null);
    record(tag + ": a pasted link's thumbnail lands in the scene's gallery", landed === "480x270", String(landed));
  } finally {
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    await new Promise((resolve) => server.close(resolve));
  }
}

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
    await sleep(1000);

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
  }
}

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

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

    await fireEval(app.cdp, "window.splitpageDesktop.__testRequestQuit()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": quit with 'confirm' exits the process", exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);

    const dirsAfter = readDraftDirs(userDataDir);
    record(tag + ": no tab folders remain after the discard", !dirsAfter[tabAId] && !dirsAfter[tabBId], JSON.stringify(Object.keys(dirsAfter)));

    const session = readSession(userDataDir);
    record(tag + ": session.json says 'clean-exit'", !!session && session.state === "clean-exit", JSON.stringify(session));
    const discarded = (session && session.discardedTabIds) || [];
    record(tag + ": both tabIds are recorded as discarded", discarded.indexOf(tabAId) !== -1 && discarded.indexOf(tabBId) !== -1, JSON.stringify(discarded));

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

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

    await addMarkerRow(cdp, markerGen1);
    await flushDraft(cdp);

    const tabDir = path.join(userDataDir, "drafts", tabId);
    const gen1 = fs.existsSync(tabDir) ? fs.readdirSync(tabDir) : [];
    record(tag + ": the first write lands normally", gen1.indexOf("current.draft") !== -1, JSON.stringify(gen1));

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

async function caseDraftCorrupt(target) {
  const tag = target.name + " draft: both generations corrupt -> quarantined, seed boot, a toast";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-"));
  let app = null;
  try {
    app = await launchApp(target, { label: "draft-corrupt-a", userDataDir });
    await waitForRows(app.cdp, 20000);
    const tabId = await tabIdOfTarget(app.cdp);
    const cdp = app.cdp;

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
  }
}

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(dataDir);
  }
}

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(dataDir);
    rmrf(userDataDir);
  }
}

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
    await sleep(1000);

    const reconnected = await findPageTarget(app.port, 30000, { tabId });
    cdp2 = new CDPConn(reconnected.webSocketDebuggerUrl);
    await cdp2.open();
    await waitForRows(cdp2, 20000);

    const status = await draftStatusFor(cdp2);
    record(tag + ": a clean tab's crash never leaves a hold (nothing to protect)", !!status && status.held === false, JSON.stringify(status));

    await fireEval(cdp2, "window.splitpageDesktop.__testRequestClose()", { awaitPromise: false });
    const exited = await waitForExit(app.proc, 30000);
    record(tag + ": closing the reloaded, still-clean tab raises no unsaved dialog (exits clean)",
      exited === true && app.proc.exitCode === 0, "exited=" + exited + " exitCode=" + app.proc.exitCode);
  } finally {
    if (cdp2) { try { cdp2.close(); } catch {} }
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

async function caseCleanTabsWriteNothing(target) {
  const tag = target.name + " draft: an untouched tab writes nothing, even after idle";
  let app = null;
  try {
    app = await launchApp(target, { label: "clean-tabs-write-nothing" });
    await waitForRows(app.cdp, 20000);
    const cdp = app.cdp;

    await sleep(8000);

    const status = await draftStatusFor(cdp);
    record(tag + ": no draft write was ever made", !!status && status.writes === 0, JSON.stringify(status));

    const dirs = readDraftDirs(app.userDataDir);
    record(tag + ": no tab folder exists under drafts/", Object.keys(dirs).length === 0, JSON.stringify(Object.keys(dirs)));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

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
    if (app) { await teardown(app, tag, { expectForceKill: ENDS_DIRTY }); rmrf(app.userDataDir); }
    rmrf(userDataDir);
  }
}

const PROMPTER_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/\?teleprompter=1#script=([0-9a-f]{64})$/;

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
    app = await launchApp(target, { label: "prompter-open", fixtures: [fixturePath] });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Prompter — 🎬 Browser"), 20000);
    const dialogsBefore = await dialogsSeen(cdp);

    const bridgeArity = await evalPage(cdp, "typeof window.splitpageDesktop.openPrompterInBrowser === 'function' && window.splitpageDesktop.openPrompterInBrowser.length");
    record(tag + ": the bridge has openPrompterInBrowser() and it takes no argument", bridgeArity === 0, "length=" + bridgeArity);

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

    const pristineBefore = await dialogsSeen(witness);
    const inPage = await evalPage(witness, "(function(){ document.getElementById('btn-file').click(); var b = document.getElementById('menu-present-browser'); var shown = !!b && !b.hidden && !document.getElementById('file-menu').hidden; if (shown) b.click(); return shown; })()");
    record(tag + ": File ▸ This document ▸ Present in browser is offered in the desktop app", inPage === true, String(inPage));
    const saveFirst = await toastContaining(witness, "Save this script first", 10000);
    record(tag + ": an unsaved new document is told to save first", !!saveFirst, String(saveFirst));
    await sleep(500);
    record(tag + ": ... and no Save dialog appears for it", (await dialogsSeen(witness)) === pristineBefore);
    const opens3 = await externalOpens(witness);
    record(tag + ": ... and nothing is opened in the browser", opens3.length === 2, JSON.stringify(opens3.length));
    try { cdp.close(); } catch { }
    app.cdp = witness;
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

async function caseTeleprompterVoiceDesktop(target, fixturesDir) {
  const tag = target.name + " teleprompter: Follow My Voice on desktop";
  const fixturePath = writeFixture(fixturesDir, "prompter-voice.splitpage", "Prompter — voice",
    [["Wide shot", "The first line the reader says out loud."], ["Close up", "A second line comes after it."]]);
  let app = null;
  try {
    app = await launchApp(target, {
      label: "prompter-voice",
      fixtures: [fixturePath],
      env: {
        SPLITPAGE_TEST_VOICE_HELPER: path.join(__dirname, "fake-voice-helper.mjs"),
        FAKE_VOICE_TEXT: "the first line the reader says",
        FAKE_VOICE_DEVICE: "Microphone (Smoke Test)"
      }
    });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Prompter — voice"), 20000);
    const dialogsBefore = await dialogsSeen(cdp);

    const arity = await evalPage(cdp, "(function(){ var d = window.splitpageDesktop; return [d.voiceStatus.length, d.voiceStart.length, d.voiceStop.length].join(','); })()");
    record(tag + ": voiceStatus/voiceStart/voiceStop take no argument", arity === "0,0,0", String(arity));

    await evalPage(cdp, "document.getElementById('btn-present').click(); true", { awaitPromise: false });
    await poll(cdp, "!document.getElementById('prompter').hidden", 10000);
    const btn = await poll(cdp, "(function(){ var b = document.getElementById('pp-voice'); return b && !b.disabled ? { text: b.textContent } : null; })()", 10000).catch(() => null);
    record(tag + ": the voice button offers to listen here, not to open the browser",
      !!btn && btn.text === "Follow My Voice", JSON.stringify(btn));

    await evalPage(cdp, "document.getElementById('pp-voice').click(); true", { awaitPromise: false });
    const listening = await poll(cdp, "(function(){ var b = document.getElementById('pp-voice'); return b.classList.contains('is-active') && b.textContent === 'Stop Following'; })()", 15000).catch(() => false);
    record(tag + ": clicking it starts following", listening === true);
    const tab1Id = await tabIdOfTarget(cdp);
    const st1 = await shell(cdp, "voiceStatus", {});
    record(tag + ": main runs one listener, for this tab", !!st1 && st1.running === true && st1.tabId === tab1Id && st1.started === 1, JSON.stringify(st1));
    const spoken = await poll(cdp, "document.querySelectorAll('#prompter .w.spoken').length >= 5", 15000).catch(() => false);
    record(tag + ": what the listener heard moves the prompter along the script", spoken === true);
    const micStatus = await evalPage(cdp, "document.getElementById('pp-voice-status').textContent");
    record(tag + ": the status names the microphone the listener said it uses (#118)",
      micStatus === "Listening — Microphone (Smoke Test)", String(micStatus));
    const opens = await externalOpens(cdp);
    record(tag + ": nothing is opened in the browser", opens.length === 0, JSON.stringify(opens));

    await evalPage(cdp, "document.getElementById('pp-voice').click(); true", { awaitPromise: false });
    const stopped = await pollNode(async () => { const st = await shell(cdp, "voiceStatus", {}); return st && st.running === false ? st : null; }, 10000).catch(() => null);
    record(tag + ": Stop Following stops main's listener", !!stopped, JSON.stringify(stopped));
    const idle = await evalPage(cdp, "document.getElementById('pp-voice').textContent");
    record(tag + ": ... and the button is back to Follow My Voice", idle === "Follow My Voice", String(idle));

    await evalPage(cdp, "document.getElementById('pp-voice').click(); true", { awaitPromise: false });
    await poll(cdp, "document.getElementById('pp-voice').classList.contains('is-active')", 15000).catch(() => false);
    const tab2Id = await shell(cdp, "createTab", {});
    const tab2 = await connectTab(app, tab2Id);
    await waitForRows(tab2, 20000);
    await evalPage(tab2, "document.getElementById('btn-present').click(); true", { awaitPromise: false });
    await poll(tab2, "!document.getElementById('prompter').hidden", 10000);
    await poll(tab2, "!document.getElementById('pp-voice').disabled", 10000).catch(() => false);
    await evalPage(tab2, "document.getElementById('pp-voice').click(); true", { awaitPromise: false });
    const taken = await poll(cdp, "(function(){ var t = document.getElementById('pp-voice-status').textContent; return t.indexOf('Another tab') !== -1 && !document.getElementById('pp-voice').classList.contains('is-active') ? t : null; })()", 15000).catch(() => null);
    record(tag + ": the first tab is told another tab is following now, and stops", !!taken, String(taken));
    const st2 = await shell(tab2, "voiceStatus", {});
    record(tag + ": main's one listener now belongs to the second tab", !!st2 && st2.running === true && st2.tabId === tab2Id, JSON.stringify(st2));

    await fireShell(cdp, "closeTab", { tabId: tab2Id });
    const gone = await pollNode(async () => { const st = await shell(cdp, "voiceStatus", {}); return st && st.running === false ? st : null; }, 10000).catch(() => null);
    record(tag + ": closing the listening tab stops its listener", !!gone, JSON.stringify(gone));
    try { tab2.close(); } catch { }
    record(tag + ": no native dialog was raised by any of it", (await dialogsSeen(cdp)) === dialogsBefore);
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

function openRelayStream(port, pathname) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET",
      headers: { host: `127.0.0.1:${port}`, accept: "text/event-stream" } }, (res) => {
      let buf = "";
      const ended = new Promise((r) => res.on("close", r));
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith("data: ")) { try { events.push(JSON.parse(block.slice(6))); } catch { } }
        }
      });
      resolve({ status: res.statusCode, type: res.headers["content-type"], events, ended, close: () => req.destroy() });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function caseTeleprompterVoiceRelay(target, fixturesDir) {
  const tag = target.name + " teleprompter: Follow My Voice relayed to the browser";
  const fixturePath = writeFixture(fixturesDir, "prompter-relay.splitpage", "Prompter — relay",
    [["Wide shot", "The first line the reader says out loud."]]);
  let app = null;
  try {
    app = await launchApp(target, {
      label: "prompter-relay",
      fixtures: [fixturePath],
      env: {
        SPLITPAGE_TEST_VOICE_HELPER: path.join(__dirname, "fake-voice-helper.mjs"),
        FAKE_VOICE_TEXT: "the first line the reader says"
      }
    });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Prompter — relay"), 20000);
    const tab1Id = await tabIdOfTarget(cdp);

    await evalPage(cdp, "window.__desktopTest.runMenuCommand('prompter-open-in-browser')", { awaitPromise: false });
    const opens = await waitForExternalOpens(cdp, 1);
    const m = opens && /^http:\/\/127\.0\.0\.1:(\d+)\/\?teleprompter=1#script=([0-9a-f]{64})&voice=(\d+)-([0-9a-f]{64})$/.exec(opens[0]);
    record(tag + ": the URL carries a voice relay beside the script, on the same listener", !!m && m[1] === m[3] && m[2] !== m[4],
      opens ? opens[0] : "none");
    const toast = await toastContaining(cdp, "listens through this app", 10000);
    record(tag + ": the page says Follow My Voice there listens through this app", !!toast, String(toast));
    if (!m) return;
    const port = Number(m[1]);
    const st0 = await shell(cdp, "voiceStatus", {});
    record(tag + ": nothing listens until the browser asks", !!st0 && st0.running === false, JSON.stringify(st0));

    const stream = await openRelayStream(port, "/prompter-voice/" + m[4]);
    record(tag + ": the relay answers as an event stream", !!stream && stream.status === 200 && /^text\/event-stream/.test(stream.type || ""),
      stream ? stream.status + " " + stream.type : "no answer");
    if (!stream) return;
    const heard = await pollNode(async () => stream.events.some((e) => e.type === "final") ? stream.events : null, 15000).catch(() => null);
    record(tag + ": what the listener hears arrives down the stream (start, interim, final)",
      !!heard && heard[0].type === "start" && heard.some((e) => e.type === "interim") &&
      heard.some((e) => e.type === "final" && e.text === "the first line the reader says"), JSON.stringify(heard));
    const st1 = await shell(cdp, "voiceStatus", {});
    record(tag + ": main runs one listener, for this tab's browser copy", !!st1 && st1.running === true && st1.tabId === "relay:" + tab1Id,
      JSON.stringify(st1));
    const share1 = await shell(cdp, "prompterShareStatus", {});
    record(tag + ": the share holds one relay stream", !!share1 && share1.voiceStreams === 1, JSON.stringify(share1));

    stream.close();
    const stopped = await pollNode(async () => { const st = await shell(cdp, "voiceStatus", {}); return st && st.running === false ? st : null; }, 10000).catch(() => null);
    record(tag + ": the browser closing the stream stops main's listener", !!stopped, JSON.stringify(stopped));

    const again = await openRelayStream(port, "/prompter-voice/" + m[4]);
    await pollNode(async () => { const st = await shell(cdp, "voiceStatus", {}); return st && st.running ? st : null; }, 10000).catch(() => null);
    const witnessId = await shell(cdp, "createTab", {});
    const witness = await connectTab(app, witnessId);
    await waitForRows(witness, 20000);
    await fireShell(cdp, "closeTab", { tabId: tab1Id });
    const ended = again ? await Promise.race([again.ended.then(() => true), sleep(10000).then(() => false)]) : false;
    record(tag + ": closing the desktop tab ends its browser copy's relay", ended === true);
    const gone = await pollNode(async () => { const st = await shell(witness, "voiceStatus", {}); return st && st.running === false ? st : null; }, 10000).catch(() => null);
    record(tag + ": ... and stops the listener", !!gone, JSON.stringify(gone));
    try { cdp.close(); } catch { }
    app.cdp = witness;
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }
}

async function chromiumLaunches(cdp) {
  return (await shell(cdp, "chromiumLaunches", {})) || [];
}

async function caseTeleprompterPresentInChromium(target, fixturesDir) {
  const tag = target.name + " teleprompter: present in chromium";
  const fixturePath = writeFixture(fixturesDir, "prompter-chromium.splitpage", "Prompter — chromium",
    [["Wide shot", "The first line the reader says out loud."]]);
  let app = null;
  try {
    app = await launchApp(target, {
      label: "prompter-chromium",
      fixtures: [fixturePath],
      env: {
        SPLITPAGE_TEST_CHROMIUM: "edge",
        SPLITPAGE_TEST_VOICE_HELPER: path.join(__dirname, "fake-voice-helper.mjs")
      }
    });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Prompter — chromium"), 20000);
    const arity = await evalPage(cdp, "typeof window.splitpageDesktop.openPrompterInChromium === 'function' && window.splitpageDesktop.openPrompterInChromium.length");
    record(tag + ": the bridge has openPrompterInChromium() and it takes no argument", arity === 0, "length=" + arity);

    const inPage = await evalPage(cdp, "(function(){ document.getElementById('btn-file').click(); var b = document.getElementById('menu-present-chromium'); var shown = !!b && !b.hidden && b.textContent === 'Use Chromium Speech Recognition'; if (shown) b.click(); return shown; })()");
    record(tag + ": File ▸ This document ▸ Use Chromium Speech Recognition is offered", inPage === true, String(inPage));
    const launched = await pollNode(async () => { const l = await chromiumLaunches(cdp); return l.length ? l : null; }, 15000).catch(() => null);
    record(tag + ": main starts the Chromium browser it found, once", !!launched && launched.length === 1 && launched[0].browser === "edge", JSON.stringify(launched));
    const m = launched && PROMPTER_URL_RE.exec(launched[0].url);
    record(tag + ": on the same loopback prompter URL, with no voice relay", !!m, launched ? launched[0].url : "");
    if (m) {
      const script = await fetchJson(`http://127.0.0.1:${m[1]}/prompter-script/${m[2]}`).catch(() => null);
      record(tag + ": the script is served for it", !!script && script.status === 200 && script.body.text === fs.readFileSync(fixturePath, "utf8"),
        script ? "status=" + script.status : "no answer");
    }
    const opens = await externalOpens(cdp);
    record(tag + ": the default browser is not asked", opens.length === 0, JSON.stringify(opens));
    const toast = await toastContaining(cdp, "Opened in Microsoft Edge", 10000);
    record(tag + ": the page names the browser and its own speech recognition", !!toast && toast.indexOf("own speech recognition") !== -1, String(toast));

    await evalPage(cdp, "window.__desktopTest.runMenuCommand('prompter-open-in-chromium')", { awaitPromise: false });
    const twice = await pollNode(async () => { const l = await chromiumLaunches(cdp); return l.length >= 2 ? l : null; }, 15000).catch(() => null);
    record(tag + ": View ▸ Use Chromium Speech Recognition does the same", !!twice && twice.length === 2 && PROMPTER_URL_RE.test(twice[1].url), JSON.stringify(twice));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
  }

  app = null;
  try {
    app = await launchApp(target, { label: "prompter-chromium-none", fixtures: [fixturePath], env: { SPLITPAGE_TEST_CHROMIUM: "none" } });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    await poll(cdp, "(window.__splitpageFormats.state()||{}).title === " + JSON.stringify("Prompter — chromium"), 20000);
    await evalPage(cdp, "window.__desktopTest.runMenuCommand('prompter-open-in-chromium')", { awaitPromise: false });
    const none = await toastContaining(cdp, "No Chromium browser", 10000);
    record(tag + ": with none installed the page says so and points at Present in browser", !!none && none.indexOf("Present in browser") !== -1, String(none));
    record(tag + ": ... nothing is started", (await chromiumLaunches(cdp)).length === 0);
    record(tag + ": ... nor handed to the default browser", (await externalOpens(cdp)).length === 0);
    const status = await shell(cdp, "prompterShareStatus", {});
    record(tag + ": ... and nothing is shared", !!status && status.listening === false && status.shares.length === 0, JSON.stringify(status));
  } finally {
    if (app) { await teardown(app, tag + " (none)"); rmrf(app.userDataDir); }
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

function driveEnv(fake, extra) {
  return Object.assign({
    SPLITPAGE_TEST_GOOGLE_BASE: fake.base,
    SPLITPAGE_GOOGLE_CLIENT_ID: fake.clientId,
    SPLITPAGE_GOOGLE_CLIENT_SECRET: fake.clientSecret
  }, extra || {});
}

async function driveCall(cdp, expr) {
  return evalPage(cdp, "(" + expr + ").then(function (r) { if (r && r.bytes) { r.bytesIsView = ArrayBuffer.isView(r.bytes); " +
    "r.text = new TextDecoder().decode(r.bytes); delete r.bytes; } return r; }, function (e) { return { rejected: String(e && e.message || e) }; })");
}

async function driveSignInThroughFake(cdp, fake, override) {
  const before = (await externalOpens(cdp)).length;
  await evalPage(cdp, "window.__driveSignIn = null; window.splitpageDesktop.driveSignIn().then(function (r) { window.__driveSignIn = r; }, " +
    "function (e) { window.__driveSignIn = { ok: false, code: 'REJECTED', message: String(e) }; }); true");
  const opens = await waitForExternalOpens(cdp, before + 1, 15000);
  const authUrl = opens ? opens[opens.length - 1] : null;
  if (!authUrl) return { authUrl: null, callback: null, result: null };
  let back;
  try { back = fake.approve(authUrl, override); } catch (e) { return { authUrl, callback: { status: null, text: String(e.message) }, result: null }; }
  const callback = await fetch(back).then(async (r) => ({ status: r.status, text: await r.text() }))
    .catch((e) => ({ status: null, text: String(e) }));
  const result = await poll(cdp, "window.__driveSignIn", 15000).catch(() => null);
  return { authUrl, back, callback, result };
}

function driveSecretOnDisk(dir, secrets) {
  for (const s of secrets) {
    const f = dirContainsText(dir, s);
    if (f) return s.slice(0, 16) + "… in " + f;
  }
  return null;
}

async function driveSecretsInPage(cdp, secrets) {
  const blob = await evalPage(cdp, "JSON.stringify({ ls: Object.assign({}, localStorage), ss: Object.assign({}, sessionStorage), " +
    "html: document.documentElement.outerHTML, keys: Object.keys(window.splitpageDesktop) })");
  return secrets.filter((s) => String(blob).indexOf(s) !== -1).map((s) => s.slice(0, 16) + "…");
}

async function caseGoogleDriveNotConfigured(target) {
  const tag = target.name + " google drive: not configured";
  const { startFakeGoogle } = await import("./fake-google.mjs");
  const fake = await startFakeGoogle();
  let app = null;
  try {
    app = await launchApp(target, { label: "drive-unconfigured",
      env: { SPLITPAGE_TEST_GOOGLE_BASE: fake.base, SPLITPAGE_GOOGLE_CLIENT_ID: "", SPLITPAGE_GOOGLE_CLIENT_SECRET: "" } });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    const entry = await evalPage(cdp, "!document.getElementById('menu-drive-open').hidden");
    record(tag + ": File ▸ Google Drive files… is offered on desktop", entry === true);
    const st = await driveCall(cdp, "window.splitpageDesktop.driveStatus()");
    const expectedPath = path.join(app.userDataDir, "google-oauth-client.json");
    record(tag + ": status says not configured, and names the exact file and the env vars",
      !!st && st.ok === true && st.configured === false && st.signedIn === false && st.clientFilePath === expectedPath &&
      JSON.stringify(st.envVars) === JSON.stringify(["SPLITPAGE_GOOGLE_CLIENT_ID", "SPLITPAGE_GOOGLE_CLIENT_SECRET"]), JSON.stringify(st));
    const si = await driveCall(cdp, "window.splitpageDesktop.driveSignIn()");
    record(tag + ": sign-in answers NOT_CONFIGURED", !!si && si.ok === false && si.code === "NOT_CONFIGURED", JSON.stringify(si));
    record(tag + ": ... and nothing was opened in the browser", (await externalOpens(cdp)).length === 0);
    const list = await driveCall(cdp, "window.splitpageDesktop.driveList('root')");
    record(tag + ": a Drive call before any sign-in answers SIGNED_OUT", !!list && list.ok === false && list.code === "SIGNED_OUT", JSON.stringify(list));

    fs.writeFileSync(expectedPath, JSON.stringify({ installed: { client_id: fake.clientId, client_secret: fake.clientSecret,
      redirect_uris: ["http://localhost"] } }));
    const st2 = await driveCall(cdp, "window.splitpageDesktop.driveStatus()");
    record(tag + ": dropping Google's client JSON at that path configures it", !!st2 && st2.configured === true && st2.signedIn === false, JSON.stringify(st2));
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    await fake.close();
  }
}

async function caseGoogleDriveRoundTrip(target) {
  const tag = target.name + " google drive: round trip";
  const { startFakeGoogle } = await import("./fake-google.mjs");
  const fake = await startFakeGoogle();
  const env = driveEnv(fake, { SPLITPAGE_TEST_DRIVE_BASIC_TEXT: "1" });
  let app = null;
  const answers = [];
  try {
    app = await launchApp(target, { label: "drive-round-trip", env });
    let cdp = app.cdp;
    await waitForRows(cdp, 20000);
    const userDataDir = app.userDataDir;
    const tokenFile = path.join(userDataDir, "google-drive-token.bin");

    const info = await shell(cdp, "driveInfo", {});
    record(tag + ": main points Google's endpoints at the fake (test mode only)", !!info && info.tokenEndpoint === fake.base + "/token", JSON.stringify(info));

    const surface = await evalPage(cdp, "(function () { var d = window.splitpageDesktop; var keys = Object.keys(d); " +
      "return { drive: keys.filter(function (k) { return /drive/i.test(k); }).sort(), " +
      "suspicious: keys.filter(function (k) { return /token|oauth|secret|credential|google/i.test(k); }) }; })()");
    record(tag + ": the bridge has exactly the six drive calls",
      !!surface && JSON.stringify(surface.drive) === JSON.stringify(["driveDownload", "driveList", "driveSignIn", "driveSignOut", "driveStatus", "driveUpload"]),
      JSON.stringify(surface));
    record(tag + ": no bridge member is named for a token or a credential", !!surface && surface.suspicious.length === 0, JSON.stringify(surface && surface.suspicious));

    const signIn = await driveSignInThroughFake(cdp, fake);
    const auth = signIn.authUrl ? new URL(signIn.authUrl) : null;
    const p = auth ? auth.searchParams : new URLSearchParams();
    record(tag + ": the consent URL goes to the (fake) Google auth endpoint with PKCE S256, a state, offline access",
      !!auth && auth.origin + auth.pathname === fake.base + "/o/oauth2/v2/auth" && p.get("code_challenge_method") === "S256" &&
      /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") || "") && (p.get("state") || "").length >= 32 && p.get("access_type") === "offline" &&
      p.get("client_id") === fake.clientId && p.get("scope") === "https://www.googleapis.com/auth/drive", signIn.authUrl || "no URL");
    record(tag + ": the redirect is a loopback listener on an OS-picked port", /^http:\/\/127\.0\.0\.1:\d+$/.test(p.get("redirect_uri") || ""), p.get("redirect_uri"));
    record(tag + ": the callback page tells the person to return to the app",
      !!signIn.callback && signIn.callback.status === 200 && /return to Splitpage/.test(signIn.callback.text), JSON.stringify(signIn.callback).slice(0, 300));
    const r = signIn.result;
    answers.push(r);
    record(tag + ": sign-in succeeds and says who", !!r && r.ok === true && r.signedIn === true && r.email === "writer@example.com", JSON.stringify(r));
    record(tag + ": the sign-in is stored (safeStorage)", !!r && r.persisted === true && fs.existsSync(tokenFile), JSON.stringify({ persisted: r && r.persisted, file: fs.existsSync(tokenFile) }));
    const closed = await fetch((p.get("redirect_uri") || "http://127.0.0.1:1") + "/?code=x&state=" + p.get("state")).then(() => false).catch(() => true);
    record(tag + ": the loopback listener is gone after its one callback", closed);
    record(tag + ": main exchanged the code with the verifier (the fake checks it)", fake.log.includes("POST /token"), JSON.stringify(fake.log));

    const root = await driveCall(cdp, "window.splitpageDesktop.driveList('root')");
    answers.push(root);
    record(tag + ": list My Drive", !!root && root.ok === true && root.files.map((f) => f.name).join(",") === "Scripts", JSON.stringify(root));
    const scripts = await driveCall(cdp, "window.splitpageDesktop.driveList('scriptsFolder01')");
    answers.push(scripts);
    record(tag + ": list a folder", !!scripts && scripts.ok === true && scripts.folder.name === "Scripts" &&
      scripts.files.map((f) => f.name).join(",") === "Budget,Notes,Pilot.fountain", JSON.stringify(scripts));
    const dl = await driveCall(cdp, "window.splitpageDesktop.driveDownload('pilotFile01')");
    answers.push(dl);
    record(tag + ": download hands the page the file's bytes", !!dl && dl.ok === true && dl.bytesIsView === true &&
      dl.text === fake.files.get("pilotFile01").data.toString("utf8") && dl.file.name === "Pilot.fountain", JSON.stringify(dl).slice(0, 300));
    const up = await driveCall(cdp, "window.splitpageDesktop.driveUpload({ parentId: 'scriptsFolder01', name: 'Smoke — 🎬.splitpage', " +
      "bytes: new TextEncoder().encode('{\"rows\":[]}'), mimeType: 'application/json' })");
    answers.push(up);
    const created = up && up.file && fake.files.get(up.file.id);
    record(tag + ": upload makes a new file in that folder", !!up && up.ok === true && !!created && created.name === "Smoke — 🎬.splitpage" &&
      created.parents[0] === "scriptsFolder01" && created.data.toString("utf8") === "{\"rows\":[]}", JSON.stringify(up));
    const upd = up && up.file ? await driveCall(cdp, "window.splitpageDesktop.driveUpload({ fileId: " + JSON.stringify(up.file.id) +
      ", bytes: new TextEncoder().encode('{\"rows\":[1]}') })") : null;
    answers.push(upd);
    record(tag + ": upload with a fileId replaces that file's content", !!upd && upd.ok === true && !!created &&
      created.data.toString("utf8") === "{\"rows\":[1]}" && created.name === "Smoke — 🎬.splitpage", JSON.stringify(upd));

    const requestsBefore = fake.log.length;
    const refusals = {
      urlAsFolder: await driveCall(cdp, "window.splitpageDesktop.driveList('https://www.googleapis.com/drive/v3/files')"),
      pathAsFile: await driveCall(cdp, "window.splitpageDesktop.driveDownload('../google-drive-token.bin')"),
      nameWithNewline: await driveCall(cdp, "window.splitpageDesktop.driveUpload({ parentId: 'root', name: 'a\\nb', bytes: 'x' })"),
      notBytes: await driveCall(cdp, "window.splitpageDesktop.driveUpload({ parentId: 'root', name: 'a', bytes: { length: 3 } })"),
      tooLarge: await driveCall(cdp, "window.splitpageDesktop.driveUpload({ parentId: 'root', name: 'big', bytes: new Uint8Array(64 * 1024 * 1024 + 1) })")
    };
    record(tag + ": a URL, a path, a bad name or non-bytes are refused as BAD_ARGS, oversize as TOO_LARGE",
      refusals.urlAsFolder.code === "BAD_ARGS" && refusals.pathAsFile.code === "BAD_ARGS" && refusals.nameWithNewline.code === "BAD_ARGS" &&
      refusals.notBytes.code === "BAD_ARGS" && refusals.tooLarge.code === "TOO_LARGE", JSON.stringify(refusals));
    record(tag + ": none of the refused calls reached Google", fake.log.length === requestsBefore, JSON.stringify(fake.log.slice(requestsBefore)));

    const secrets = fake.secrets();
    record(tag + ": setup — the fake issued a refresh and an access token", secrets.some((s) => s.startsWith("1//")) && secrets.some((s) => s.startsWith("ya29.")));
    const inAnswers = secrets.filter((s) => JSON.stringify(answers).indexOf(s) !== -1);
    record(tag + ": no bridge answer carried a token", inAnswers.length === 0, inAnswers.join(","));
    const inPage = await driveSecretsInPage(cdp, secrets);
    record(tag + ": no token anywhere the page can see (storage, document, bridge)", inPage.length === 0, inPage.join(","));
    const onDisk = driveSecretOnDisk(userDataDir, secrets);
    record(tag + ": no token in plain text in any file under the profile (the blob is encrypted)", !onDisk, onDisk || "");
    const mentionsGoogle = dirContainsText(userDataDir, fake.base);
    record(tag + ": nothing under the profile (desktop-state.json, drafts, history) even names the Google endpoint", !mentionsGoogle, String(mentionsGoogle || ""));

    await teardown(app, tag + " (first launch)");
    app = await launchApp(target, { label: "drive-relaunch", env, userDataDir });
    cdp = app.cdp;
    await waitForRows(cdp, 20000);
    const st = await driveCall(cdp, "window.splitpageDesktop.driveStatus()");
    record(tag + ": after a relaunch, still signed in from the stored token", !!st && st.signedIn === true && st.persisted === true &&
      st.email === "writer@example.com", JSON.stringify(st));
    const tokenCallsBefore = fake.log.filter((l) => l === "POST /token").length;
    const again = await driveCall(cdp, "window.splitpageDesktop.driveList('scriptsFolder01')");
    record(tag + ": ... and Drive works, through a refresh-token exchange", !!again && again.ok === true &&
      fake.log.filter((l) => l === "POST /token").length === tokenCallsBefore + 1, JSON.stringify(again && again.code));

    const refreshToken = fake.secrets().find((s) => s.startsWith("1//"));
    const out = await driveCall(cdp, "window.splitpageDesktop.driveSignOut()");
    record(tag + ": sign-out answers signed out", !!out && out.ok === true && out.status && out.status.signedIn === false, JSON.stringify(out));
    record(tag + ": sign-out deletes the stored token", !fs.existsSync(tokenFile));
    record(tag + ": sign-out revokes it with Google", fake.isRevoked(refreshToken));
    const after = await driveCall(cdp, "window.splitpageDesktop.driveList('root')");
    record(tag + ": after sign-out Drive calls answer SIGNED_OUT", !!after && after.ok === false && after.code === "SIGNED_OUT", JSON.stringify(after));
    const leftOnDisk = driveSecretOnDisk(userDataDir, fake.secrets());
    record(tag + ": no token anywhere under the profile after sign-out", !leftOnDisk, leftOnDisk || "");
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    await fake.close();
  }
}

async function caseGoogleDriveBadState(target) {
  const tag = target.name + " google drive: bad state refused";
  const { startFakeGoogle } = await import("./fake-google.mjs");
  const fake = await startFakeGoogle();
  let app = null;
  try {
    app = await launchApp(target, { label: "drive-bad-state", env: driveEnv(fake) });
    const cdp = app.cdp;
    await waitForRows(cdp, 20000);
    const tokenFile = path.join(app.userDataDir, "google-drive-token.bin");

    const forged = await driveSignInThroughFake(cdp, fake, { state: "forged-by-another-page" });
    record(tag + ": a callback with the wrong state is refused with a page saying so",
      !!forged.callback && forged.callback.status === 400 && /refused/.test(forged.callback.text), JSON.stringify(forged.callback).slice(0, 300));
    record(tag + ": sign-in answers STATE_MISMATCH", !!forged.result && forged.result.ok === false && forged.result.code === "STATE_MISMATCH", JSON.stringify(forged.result));
    record(tag + ": the code was never exchanged", !fake.log.includes("POST /token"), JSON.stringify(fake.log));
    const redirect = forged.authUrl ? new URL(forged.authUrl).searchParams.get("redirect_uri") : "http://127.0.0.1:1";
    const closed = await fetch(redirect + "/").then(() => false).catch(() => true);
    record(tag + ": the listener closed after that one callback", closed);
    const st = await driveCall(cdp, "window.splitpageDesktop.driveStatus()");
    record(tag + ": still signed out, nothing stored", !!st && st.signedIn === false && !fs.existsSync(tokenFile), JSON.stringify(st));

    const denied = await driveSignInThroughFake(cdp, fake, { error: "access_denied" });
    record(tag + ": consent refused in the browser answers DENIED", !!denied.result && denied.result.code === "DENIED", JSON.stringify(denied.result));

    const info = await shell(cdp, "driveInfo", {});
    const good = await driveSignInThroughFake(cdp, fake);
    const sessionOnly = !info.encryptionAvailable || info.backend === "basic_text";
    record(tag + ": a fresh sign-in after the refusal works", !!good.result && good.result.ok === true, JSON.stringify(good.result));
    record(tag + ": storage follows the backend (" + info.backend + "): " + (sessionOnly ? "session only, nothing written" : "stored"),
      !!good.result && (sessionOnly
        ? good.result.persisted === false && good.result.canPersist === false && !fs.existsSync(tokenFile)
        : good.result.persisted === true && fs.existsSync(tokenFile)), JSON.stringify({ result: good.result, file: fs.existsSync(tokenFile) }));
    const list = await driveCall(cdp, "window.splitpageDesktop.driveList('root')");
    record(tag + ": ... and Drive works", !!list && list.ok === true, JSON.stringify(list && list.code));
    const onDisk = driveSecretOnDisk(app.userDataDir, fake.secrets());
    record(tag + ": no token in plain text under the profile", !onDisk, onDisk || "");
  } finally {
    if (app) { await teardown(app, tag); rmrf(app.userDataDir); }
    await fake.close();
  }
}

const SERVER_JS = path.join(DESKTOP_DIR, "..", "server", "server.js");

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

async function presenceOthers(srv, token, docId) {
  const r = await fetchJson(srv.url + "api/presence", {
    method: "POST", headers: { "content-type": "application/json", "x-splitpage-token": token },
    body: JSON.stringify({ docId, id: "smoke-observer", name: "Observer", rowId: "", field: "", gone: false })
  });
  return r.body && Array.isArray(r.body.here) ? r.body.here : null;
}

const connOf = (cdp) => evalPage(cdp, "window.__hostedTest.conn()");

const { connectTabViaDialog, openViaPicker, submitPin } = createDialogHelpers({ evalPage, poll });

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

    record(tag + ": tab 2 asks for server X's PIN, the server it inherited without a token",
      !!(await poll(cdp2, "!document.getElementById('pin-modal').hidden", 15000).catch(() => false)));
    record(tag + ": tab 2 joins server Y through the Servers dialog, opened over that PIN prompt", await connectTabViaDialog(cdp2, srvY));
    record(tag + ": tab 2's PIN prompt for X closed once it joined Y", await evalPage(cdp2, "document.getElementById('pin-modal').hidden"));
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

    const m1 = "ON-X-" + Date.now(), m2 = "ON-Y-" + Date.now();
    await addMarkerRow(cdp1, m1);
    record(tag + ": tab 1 saves", !!(await saveTabNow(cdp1)));
    await addMarkerRow(cdp2, m2);
    record(tag + ": tab 2 saves", !!(await saveTabNow(cdp2)));
    const docX = await readServerDoc(srvX, tokX, twin.id), docY = await readServerDoc(srvY, tokY, twin.id);
    record(tag + ": tab 1's edit is on server X and not on Y", serverDocHas(docX, m1) && !serverDocHas(docY, m1));
    record(tag + ": tab 2's edit is on server Y and not on X", serverDocHas(docY, m2) && !serverDocHas(docX, m2));

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

    await submitPin(cdpY, srvY.pin);
    record(tag + ": after the PIN, the Y tab reopens Y's document", !!(await poll(cdpY, titleExpr("Restore On Y"), 20000).catch(() => false)));
    const after = readDesktopStateFile(userDataDir);
    record(tag + ": the rewritten desktop-state.json holds no planted token", !!after && !JSON.stringify(after).includes(PLANT));

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
      await submitPin(cdpX, srvX.pin);
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

async function runTargetSuite(target, groupFilter) {
  console.log(`\n==== target: ${target.name} (${target.exe}) ====`);
  const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-smoke-fixtures-"));
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
    ["save-in-place birthtime vs the duplicate rule", () => caseAtomicSaveKeepsBirthtime(target, fixturesDir)],
    ["duplicate document id across tabs (DOC-CLAIMS)", () => caseDuplicateDocIdAcrossTabs(target, fixturesDir)],
    ["history: round trip (put/list/get/copy/touch/Older put/usage) + relaunch", () => caseHistoryRoundTripAndRelaunch(target)],
    ["history: id validation", () => caseHistoryIdValidation(target)],
    ["history: exit-after-body fault, relaunch shows the prior generation", () => caseHistoryKillAfterBody(target)],
    ["history: torn index.json falls back to index.prev.json", () => caseHistoryTornIndex(target)],
    ["history: cap-driven eviction + 50-per-document trim", () => caseHistoryCapEviction(target)],
    ["history: concurrent puts + a copy, one queue, two tabs", () => caseHistoryConcurrentPuts(target)],
    ["history: legacy localStorage migration into Older", () => caseHistoryLegacyMigration(target)],
    ["history: FORMAT ahead of ours goes read-only", () => caseHistoryNewerFormatReadOnly(target)],
    ["history: 3.0.0's v1-backup/ is deleted at launch, v2 history intact", () => caseHistoryV1BackupRemoved(target)],
    ["history: a raw v1 tree is left dormant, history starts fresh", () => caseHistoryV1RawTreeDormant(target)],
    ["blobs: put/get/missing over the bridge, bad sha refused, relaunch", () => caseBlobRoundTripAndRelaunch(target)],
    ["draft: crash-recovery of an untitled document", () => caseDraftCrashUntitled(target)],
    ["draft: crash-recovery brings a picture back from the blob folder (#82)", () => caseDraftCrashWithImage(target)],
    ["gallery: a dropped video file opens through main only (#135)", () => caseGalleryVideoFile(target)],
    ["gallery: a pasted video link's thumbnail comes through main, by host and id (#141)", () => caseGalleryVideoThumbnail(target)],
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
    ["teleprompter: open in browser (file, save-first, share lifetime)", () => caseTeleprompterOpenInBrowserFile(target, fixturesDir)],
    ["teleprompter: open in browser (--library server document)", () => caseTeleprompterOpenInBrowserServer(target)],
    ["teleprompter: Follow My Voice on desktop (fake listener)", () => caseTeleprompterVoiceDesktop(target, fixturesDir)],
    ["teleprompter: voice relay to Present in Browser (fake listener)", () => caseTeleprompterVoiceRelay(target, fixturesDir)],
    ["teleprompter: present in chromium (Use Chromium Speech Recognition)", () => caseTeleprompterPresentInChromium(target, fixturesDir)],
    ["google drive: not configured (says where the client goes)", () => caseGoogleDriveNotConfigured(target)],
    ["google drive: sign-in, list/download/upload, relaunch, sign-out (fake Google)", () => caseGoogleDriveRoundTrip(target)],
    ["google drive: bad state refused, storage follows the backend", () => caseGoogleDriveBadState(target)],
    ["per-tab connections: two servers side by side, close one", () => caseTwoServersSideBySide(target)],
    ["per-tab connections: a server tab beside a file tab", () => caseServerTabBesideFileTab(target, fixturesDir)],
    ["per-tab connections: session restore of server tabs", () => caseRestoreServerTabs(target)],
    ["window.close() canary (src/js grep)", () => caseWindowCloseCanary()]
  ];
  try {
    groups.forEach(([name]) => groupNames.add(name));
    for (const [name, fn, opts] of groups) {
      if (groupFilter && !name.toLowerCase().includes(groupFilter)) continue;
      groupsRun++;
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
  if (!targets.some((t) => !t.cannotRun)) {
    targets.filter((t) => t.cannotRun).forEach((t) => console.error("SKIP - " + t.name + " :: " + t.cannotRun));
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
    if (target.cannotRun) {
      skip(target.name + " (whole target)", target.cannotRun);
      continue;
    }
    try {
      await runTargetSuite(target, groupFilter);
    } catch (e) {
      record(target.name + ": target suite", false, "uncaught exception: " + (e && e.stack || e));
    }
  }

  if (groupFilter && groupsRun === 0) {
    console.log("");
    console.log("NO GROUP MATCHED --only-group " + JSON.stringify(onlyGroup) + ". It matches the registered group");
    console.log("name (e.g. \"open/boot/security\"), not the tag printed on each check line (\"boot+security\").");
    console.log("Registered groups:");
    groupNames.forEach((n) => console.log("  " + n));
    console.log("NOTHING RAN - 0 desktop checks — PARTIAL RUN matched nothing");
    process.exit(1);
  }

  console.log("");
  if (skippedLines.length) {
    console.log(`SKIPPED (${skippedLines.length}) — not run here, so not covered:`);
    skippedLines.forEach((l) => console.log("  - " + l));
    console.log("");
  } else {
    console.log("SKIPPED (0) — every check in this file ran.");
    console.log("");
  }
  if (unexpectedForceKills.length) {
    console.log(`FORCE-KILLED (${unexpectedForceKills.length}) — Browser.close did not close these, and they were not expected to need the kill:`);
    unexpectedForceKills.forEach((l) => console.log("  - " + l));
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
