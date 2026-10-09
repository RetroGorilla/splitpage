"use strict";

const {
  app, BrowserWindow, WebContentsView, Menu, protocol, net, ipcMain, dialog, shell,
  utilityProcess, session, nativeTheme, screen, safeStorage
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const os = require("node:os");
const net_ = require("node:net");
const { spawn } = require("node:child_process");
const { createDraftStore, writeFileDurableSync, MAX_BODY_BYTES } = require("./drafts");
const { createPrompterShare, isShareableName, MAX_SCRIPT_BYTES } = require("./prompter-share");
const { createGoogleDrive } = require("./google-drive");
const { documentServerHost } = require("./bind-host");
const { checkFileGone, copyKept, FILE_CHECK_TIMEOUT_MS } = require("./close-keep");
const { createVoiceHelper } = require("./voice-helper");
const { findChromiumBrowsers, launchChromiumBrowser, chromiumBrowserName } = require("./chromium-browsers");
const {
  createBlobStore, imageBlobRefusal, sniffImageMime, isSha256, MAX_MISSING_QUERY
} = require("./blob-store");
const { createHistoryFsBackend, MAX_BODY_BYTES: HISTORY_MAX_BODY_BYTES } = require("./history-fs-backend");
const {
  APP_ORIGIN, TABSTRIP_ORIGIN, channelFor, channelsForOrigin, checkArgs
} = require("./ipc-channels");

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

if (process.env.SPLITPAGE_USER_DATA) {
  app.setPath("userData", process.env.SPLITPAGE_USER_DATA);
}

let testDialogAnswers = null;
let testDialogCursor = 0;
let testDialogsSeen = 0;
if (process.env.SPLITPAGE_TEST_DIALOGS) {
  try {
    testDialogAnswers = JSON.parse(fs.readFileSync(process.env.SPLITPAGE_TEST_DIALOGS, "utf8"));
    if (!Array.isArray(testDialogAnswers)) testDialogAnswers = null;
  } catch {
    testDialogAnswers = null;
  }
}
function consumeTestDialogAnswer() {
  testDialogsSeen++;
  if (!testDialogAnswers || testDialogCursor >= testDialogAnswers.length) return undefined;
  return testDialogAnswers[testDialogCursor++];
}

const SKIP_UPDATE_CHECK = process.env.SPLITPAGE_NO_UPDATE_CHECK === "1";

const TEST_MODE = process.env.SPLITPAGE_TEST === "1";
const testExternalOpens = [];
const testChromiumLaunches = [];
const testVideoOpens = [];
const videoFileGrants = new Map();
const VIDEO_FILE_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|wmv|mpg|mpeg|3gp)$/i;
if (TEST_MODE) {

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

  shell.openExternal = async (url) => { testExternalOpens.push(String(url)); };
}

const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "splitpage")
  : path.resolve(__dirname, "..");

const SHARED_ROOT = path.join(APP_ROOT, "shared");
const historyPolicy = require(path.join(SHARED_ROOT, "history-policy.js"));
const { HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE, historyUtf8Length, sanitizeHistoryMeta } = historyPolicy;
const { createHistoryStore } = require(path.join(SHARED_ROOT, "history-store.js"));
const {
  DOC_ID_RE, chooseDuplicateLoser, docIdFromSha256Hex, duplicateReplacementInput
} = require(path.join(SHARED_ROOT, "doc-id-policy.js"));

const STATIC_ALLOWLIST = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/icon-maskable.svg": { file: "icon-maskable.svg", type: "image/svg+xml" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/help.md": { file: "help.md", type: "text/markdown; charset=utf-8" },
  "/VERSION": { file: "VERSION", type: "text/plain; charset=utf-8" }
};

const rawArgv = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);

function argHas(list, flag) { return list.includes(flag); }
function argValueOf(list, flag, fallback) {
  const i = list.indexOf(flag);
  if (i === -1 || i === list.length - 1) return fallback;
  const value = list[i + 1];
  if (typeof value === "string" && value.startsWith("-")) return fallback;
  return value;
}
function argValuesOf(list, flag) {
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    if (list[i] === flag && list[i + 1] && !list[i + 1].startsWith("--")) out.push(list[i + 1].trim());
  }
  return out;
}

const OPENABLE_EXTENSIONS = [".splitpage", ".md", ".html", ".htm", ".docx", ".txt", ".csv"];
function filesToOpenFrom(list, baseDir) {
  const out = [];
  for (const item of list) {
    if (item.startsWith("-")) continue;
    const ext = path.extname(item).toLowerCase();
    if (!OPENABLE_EXTENSIONS.includes(ext)) continue;
    try {
      const abs = path.resolve(baseDir, item);
      if (fs.statSync(abs).isFile()) out.push(abs);
    } catch { }
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

let REVIEW_PIN = "";
if (argHas(rawArgv, "--review-pin") || argHas(rawArgv, "--share-readonly")) {
  const given = argValueOf(rawArgv, "--review-pin", "");
  REVIEW_PIN = (given && !given.startsWith("--")) ? given.trim() : String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  if (!JOIN_PIN) JOIN_PIN = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  if (REVIEW_PIN === JOIN_PIN) REVIEW_PIN = "";
}
const REVIEW_KEY = REVIEW_PIN ? crypto.randomBytes(16).toString("hex") : "";

const TUNNEL_TARGET = argHas(rawArgv, "--tunnel") ? argValueOf(rawArgv, "--tunnel", "") : null;
const TUNNEL_REMOTE_PORT = Number(argValueOf(rawArgv, "--remote-port", 8791));
const TUNNEL_LOCAL_PORT = Number(argValueOf(rawArgv, "--local-port", String(TUNNEL_REMOTE_PORT)));

const argvFilesToOpen = filesToOpenFrom(rawArgv, process.cwd());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {

let documentServerChild = null;
let documentServerPort = null;
let tunnelChild = null;
let tunnelLocalUrl = null;
let tunnelWindow = null;

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

const fileRegistry = new Map();
function registerPath(absPath) {
  const id = crypto.randomBytes(16).toString("hex");
  fileRegistry.set(id, absPath);
  return id;
}

const TITLEBAR_H = 36;

const MIN_WINDOW_W = 480;
const MIN_WINDOW_H = 400;

const CRASH_RELOAD_MAX = 2;
const CRASH_RELOAD_WINDOW_MS = 60 * 1000;

const TABSTRIP_ROOT = app.isPackaged
  ? path.join(APP_ROOT, "tabstrip")
  : path.join(__dirname, "tabstrip");

const TABSTRIP_ALLOWLIST = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/tabstrip.js": { file: "tabstrip.js", type: "text/javascript; charset=utf-8" },
  "/tabstrip.css": { file: "tabstrip.css", type: "text/css; charset=utf-8" }
};

const tabs = new Map();

const windowsById = new Map();

const webContentsIdToTabId = new Map();
const pathToTabId = new Map();
const serverDocIdToTabId = new Map();

function pathKey(absPath) {
  const resolved = path.resolve(absPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

let lastFocusedWindowId = null;
let quitConfirmed = false;
let quitKeepingDrafts = false;
let hostingConfirmed = false;
let sessionWritesFrozen = false;
let sessionEnding = false;
let firstTabCreated = false;
let hadPriorSession = false;
let sessionRestoreInProgress = false;
let draftFlushReqId = 0;
const pendingDraftFlushes = new Map();
const DRAFT_FLUSH_BUDGET_MS = 1500;
let pendingRestoreNotice = null;

const closeConfirmedWindows = new WeakSet();
const closeConfirmedTabViews = new WeakSet();

const docClaims = new Map();
let docClaimSeq = 0;
const docClaimCleanupRegistered = new WeakSet();

function homeKeyForClaim(tab) {
  if (tab.serverKey) {
    const url = tab.source.kind === "server" && tab.source.serverUrl ? "@" + tab.source.serverUrl : "";
    return "server:" + String(tab.serverKey).slice(0, 200) + url;
  }
  const absPath = tab.fileId ? fileRegistry.get(tab.fileId) : null;
  if (absPath) return "file:" + pathKey(absPath);
  return null;
}

function replacementDocId(fromId, homeKey) {
  const digest = crypto.createHash("sha256")
    .update(duplicateReplacementInput(fromId, homeKey), "utf8")
    .digest("hex");
  return docIdFromSha256Hex(digest);
}

function tabWebContentsForClaim(webContentsId) {
  const tabId = webContentsIdToTabId.get(webContentsId);
  const tab = tabId ? tabs.get(tabId) : null;
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  return tab.view.webContents;
}

function checkDuplicateDocId(senderId) {
  const mine = docClaims.get(senderId);
  if (!mine) return;
  for (const [otherId, theirs] of docClaims) {
    if (otherId === senderId) continue;
    const loser = chooseDuplicateLoser(mine, theirs);
    if (!loser) continue;
    const winner = loser === mine ? theirs : mine;
    const loserId = loser === mine ? senderId : otherId;
    const toId = replacementDocId(loser.docId, loser.homeKey);
    if (loser.pendingToId === toId) continue;
    const wc = tabWebContentsForClaim(loserId);
    if (!wc) continue;
    loser.pendingToId = toId;
    try {
      wc.send("splitpage:reassign-doc-id", { fromId: loser.docId, toId, otherTitle: winner.title });
    } catch { }
  }
}

function recordDocClaim(sender, tab) {
  const webContentsId = sender.id;
  const docId = typeof tab.docId === "string" && DOC_ID_RE.test(tab.docId) ? tab.docId : null;
  const homeKey = docId ? homeKeyForClaim(tab) : null;
  if (!docId || !homeKey) {
    docClaims.delete(webContentsId);
    return;
  }
  const previous = docClaims.get(webContentsId);
  if (previous && previous.docId === docId && previous.homeKey === homeKey) {
    previous.title = tab.title;
    return;
  }
  if (!docClaimCleanupRegistered.has(sender)) {
    docClaimCleanupRegistered.add(sender);
    sender.once("destroyed", () => { docClaims.delete(webContentsId); });
  }
  docClaims.set(webContentsId, {
    docId,
    homeKey,
    seq: ++docClaimSeq,
    title: tab.title,
    pendingToId: null
  });
  checkDuplicateDocId(webContentsId);
}

let draftStore = null;
let draftsPreviousSession = "none";
function draftsHasDraft(tabId) {
  try { return !!(draftStore && draftStore.hasDraft(tabId)); } catch { return false; }
}
function draftsIsHeld(tabId) {
  try { return !!(draftStore && draftStore.isHeld(tabId)); } catch { return false; }
}
function draftsList() {
  try { return draftStore ? draftStore.list() : []; } catch { return []; }
}
function draftsDiscardForUserDecision(tabIds, reason) {
  if (!draftStore || !tabIds.length) return;
  try { draftStore.discardForUserDecision(tabIds, reason); }
  catch (err) {
    if (TEST_MODE) process.stderr.write(`[splitpage] draft discard failed: ${err && err.stack || err}\n`);
  }
}
function draftsDiscardClean(tabId) {
  if (!draftStore) return;
  try { Promise.resolve(draftStore.discardClean(tabId, Infinity)).catch(() => {}); } catch { }
}

function draftTestHooksFromEnv() {
  if (!TEST_MODE) return null;
  const hooks = {
    onKill() {
      killDocumentServer();
      killTunnel();
      process.kill(process.pid, "SIGKILL");
    }
  };
  const fail = process.env.SPLITPAGE_TEST_DRAFT_FAIL;
  if (typeof fail === "string" && fail) {
    const [code, count] = fail.split(":");
    if (code) hooks.failNext = { code, count: Number.isInteger(Number(count)) && Number(count) > 0 ? Number(count) : 1 };
  }
  const killAt = Number(process.env.SPLITPAGE_TEST_DRAFT_KILL_BEFORE_RENAME);
  if (Number.isInteger(killAt) && killAt > 0) hooks.killBeforeRenameAt = killAt;
  const delayMs = Number(process.env.SPLITPAGE_TEST_DRAFT_WRITE_DELAY_MS);
  if (Number.isFinite(delayMs) && delayMs > 0) hooks.writeDelayMs = delayMs;
  return hooks;
}

function initDraftStore() {
  try {
    draftStore = createDraftStore({
      dir: path.join(app.getPath("userData"), "drafts"),
      fs, fsp, path, crypto,
      appVersion: app.getVersion(),
      testHooks: draftTestHooksFromEnv()
    });
    const result = draftStore.init();
    draftsPreviousSession = (result && result.previousSession) || "none";
    return result;
  } catch (err) {
    draftStore = null;
    if (TEST_MODE) process.stderr.write(`[splitpage] draft store unavailable: ${err && err.stack || err}\n`);
    return { previousSession: "none", drafts: [] };
  }
}

function tabIsUnsaved(tab) {
  return !!(tab && !tab.crashedNotReloaded && (tab.dirty || draftsIsHeld(tab.id)));
}

function tabHasFile(tab) {
  if (!tab || tab.crashedNotReloaded || !tab.source || tab.source.kind !== "file") return false;
  const absPath = tab.source.absPath;
  return typeof absPath === "string" && !!absPath;
}

const TEST_CLOSE_STAT_DELAY_MS = TEST_MODE ? Number(process.env.SPLITPAGE_TEST_CLOSE_STAT_DELAY_MS) || 0 : 0;

function closeCheckStat(p) {
  if (TEST_CLOSE_STAT_DELAY_MS > 0) return new Promise((r) => setTimeout(r, TEST_CLOSE_STAT_DELAY_MS)).then(() => fsp.stat(p));
  return fsp.stat(p);
}

function tabFileGone(tab) {
  if (!tabHasFile(tab)) return Promise.resolve(false);
  return checkFileGone(closeCheckStat, tab.source.absPath, FILE_CHECK_TIMEOUT_MS);
}

function keepDraftsOfGoneFiles(goneTabs) {
  return Promise.all(goneTabs.map((tab) => {
    tab.keepDraftOnClose = true;
    return requestDraftFlush(tab, DRAFT_FLUSH_BUDGET_MS, true)
      .then((result) => (copyKept(result, draftsHasDraft(tab.id)) ? null : tab));
  })).then((unkept) => unkept.filter(Boolean));
}

const DRAFT_ORIGIN_KINDS = new Set(["untitled", "file", "server", "import"]);
const DRAFT_FILE_KINDS = new Set(["md", "html", "splitpage"]);
const DRAFT_NAME_MAX = 300;

function draftScalarString(v, max) {
  if (typeof v !== "string" || !v) return null;
  /* eslint-disable-next-line no-control-regex -- stripping control characters
     is the function's job; the class is written out above. */
  const clean = v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
  return clean || null;
}

function draftFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function draftServerOrigin(server) {
  if (!server || typeof server !== "object") return null;
  let base = null;
  try {
    const u = new URL(String(server.base == null ? "" : server.base));
    if (u.protocol === "http:" || u.protocol === "https:") base = u.origin + u.pathname;
  } catch { base = null; }
  const docId = draftScalarString(server.docId, DRAFT_NAME_MAX);
  const rev = draftFiniteNumber(server.rev);
  if (!base && !docId) return null;
  return { base, docId, rev: rev === null ? 0 : rev };
}

function buildDraftHeader(tab, p) {
  const fileId = typeof p.fileId === "string" ? p.fileId : null;
  const filePath = fileId ? fileRegistry.get(fileId) || null : null;
  const w = windowsById.get(tab.windowId);
  const index = w ? w.tabIds.indexOf(tab.id) : -1;
  return {
    title: draftScalarString(p.title, DRAFT_NAME_MAX) || "",
    docId: typeof p.docId === "string" && DOC_ID_RE.test(p.docId) ? p.docId : null,
    docIdWrittenOut: p.docIdWrittenOut === true,
    schema: draftFiniteNumber(p.schema),
    editSeq: draftFiniteNumber(p.editSeq),
    origin: {
      kind: DRAFT_ORIGIN_KINDS.has(p.originKind) ? p.originKind : "untitled",
      filePath,
      fileName: filePath ? path.basename(filePath) : null,
      fileKind: DRAFT_FILE_KINDS.has(p.fileKind) ? p.fileKind : null,
      importName: draftScalarString(p.importName, DRAFT_NAME_MAX),
      baseLastModified: draftFiniteNumber(p.baseLastModified),
      baseSize: draftFiniteNumber(p.baseSize),
      server: draftServerOrigin(p.server)
    },
    placement: { windowKey: tab.windowId, index: index >= 0 ? index : 0, active: !!(w && w.activeTabId === tab.id) }
  };
}

function draftBodyTooLarge(str) {
  if (str.length > MAX_BODY_BYTES) return true;
  return Buffer.byteLength(str, "utf8") > MAX_BODY_BYTES;
}

function requestDraftFlush(tab, budgetMs, keep) {
  return new Promise((resolve) => {
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) { resolve({ ok: false, code: "NO_TAB" }); return; }
    const reqId = ++draftFlushReqId;
    const timer = setTimeout(() => {
      if (pendingDraftFlushes.delete(reqId)) resolve({ ok: false, code: "EBUSY" });
    }, budgetMs);
    pendingDraftFlushes.set(reqId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      tab.view.webContents.send("splitpage:draft-flush", reqId, keep === true);
    } catch {
      pendingDraftFlushes.delete(reqId);
      clearTimeout(timer);
      resolve({ ok: false, code: "NO_TAB" });
    }
  });
}

const DESKTOP_STATE_VERSION = 2;
const TAB_OR_WINDOW_ID_RE = /^[0-9a-f]{32}$/;
const LAST_KNOWN_TITLE_MAX = 300;
const RECENTS_MAX = 20;

function stateFilePath() { return path.join(app.getPath("userData"), "desktop-state.json"); }

function mintTabOrWindowId() { return crypto.randomBytes(16).toString("hex"); }

const DESKTOP_STATE_TMP_RE = /^\.tmp-[0-9a-f]{12}-desktop-state\.json$/;
function sweepDesktopStateTempFiles() {
  const dir = path.dirname(stateFilePath());
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!DESKTOP_STATE_TMP_RE.test(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { }
  }
  return removed;
}

function normalizeBounds(b) {
  if (!b || typeof b !== "object") return null;
  const ok = ["x", "y", "width", "height"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k]));
  return ok ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}

const SERVER_URL_MAX = 2048;
const TUNNEL_USERHOST_RE = /^[A-Za-z0-9._@:[\]-]{1,255}$/;
const CONN_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

function normalizeServerUrl(v) {
  if (v === "" || v === null || v === undefined) return "";
  if (typeof v !== "string" || v.length > SERVER_URL_MAX || /\s/.test(v) || !v.endsWith("/")) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash || v.indexOf("?") !== -1 || v.indexOf("#") !== -1) return null;
  if (!/^https?:\/\//i.test(v)) return null;
  return v;
}

function normalizeTunnel(t) {
  if (!t || typeof t !== "object") return null;
  const port = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
  if (typeof t.userHost !== "string" || !TUNNEL_USERHOST_RE.test(t.userHost) || t.userHost[0] === "-") return null;
  if (!port(t.remotePort) || !port(t.localPort)) return null;
  return { userHost: t.userHost, remotePort: t.remotePort, localPort: t.localPort };
}

function normalizeConnToken(t) { return typeof t === "string" && CONN_TOKEN_RE.test(t) ? t : ""; }
function normalizeConnRole(r) { return r === "edit" || r === "review" ? r : ""; }

function serverSource(serverDocId, c) {
  const o = c || {};
  return {
    kind: "server",
    serverDocId,
    serverUrl: normalizeServerUrl(o.serverUrl) || "",
    tunnel: normalizeTunnel(o.tunnel),
    token: normalizeConnToken(o.token),
    role: normalizeConnRole(o.role)
  };
}

function serverRouteKey(src) {
  return (src.serverUrl || "") + "\n" + src.serverDocId;
}

function normalizeTabSource(src) {
  if (src && typeof src === "object") {
    if (src.kind === "file" && typeof src.absPath === "string" && src.absPath && path.isAbsolute(src.absPath)) {
      return { kind: "file", absPath: src.absPath };
    }
    if (src.kind === "server" && typeof src.serverDocId === "string" && src.serverDocId) {
      const serverUrl = normalizeServerUrl(src.serverUrl);
      if (serverUrl === null) return { kind: "blank" };
      return { kind: "server", serverDocId: src.serverDocId, serverUrl, tunnel: normalizeTunnel(src.tunnel) };
    }
  }
  return { kind: "blank" };
}

function liveTabSource(src) {
  const base = normalizeTabSource(src);
  if (base.kind !== "server") return base;
  return serverSource(base.serverDocId, { ...base, token: src.token, role: src.role });
}

function blankDesktopWindow(extra) {
  const tabId = mintTabOrWindowId();
  return {
    windowId: mintTabOrWindowId(),
    bounds: null,
    maximized: false,
    activeTabId: tabId,
    tabs: [{ tabId, source: { kind: "blank" }, lastKnownTitle: "" }],
    ...(extra || {})
  };
}

function freshDesktopState() {
  return { version: DESKTOP_STATE_VERSION, windows: [blankDesktopWindow()], recents: [] };
}

function migrateDesktopStateV1(v1) {
  const tabId = mintTabOrWindowId();
  const source = typeof v1.lastFilePath === "string" && v1.lastFilePath
    ? { kind: "file", absPath: v1.lastFilePath }
    : { kind: "blank" };
  return {
    version: DESKTOP_STATE_VERSION,
    windows: [{
      windowId: mintTabOrWindowId(),
      bounds: normalizeBounds(v1.windowBounds),
      maximized: v1.windowMaximized === true,
      activeTabId: tabId,
      tabs: [{ tabId, source, lastKnownTitle: "" }]
    }],
    recents: []
  };
}

function normalizeRecentsList(raw) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.absPath !== "string" || !r.absPath || !path.isAbsolute(r.absPath)) continue;
    const key = pathKey(r.absPath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      absPath: r.absPath,
      title: typeof r.title === "string" ? r.title.slice(0, LAST_KNOWN_TITLE_MAX) : "",
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0
    });
    if (out.length >= RECENTS_MAX) break;
  }
  return out;
}

function normalizeDesktopStateV2(raw) {
  const seen = new Set();
  const uniqueId = (id) => {
    const v = typeof id === "string" && TAB_OR_WINDOW_ID_RE.test(id) && !seen.has(id) ? id : mintTabOrWindowId();
    seen.add(v);
    return v;
  };
  const windows = [];
  for (const w of Array.isArray(raw && raw.windows) ? raw.windows : []) {
    if (!w || typeof w !== "object") continue;
    const tabs = [];
    for (const t of Array.isArray(w.tabs) ? w.tabs : []) {
      if (!t || typeof t !== "object") continue;
      tabs.push({
        tabId: uniqueId(t.tabId),
        source: normalizeTabSource(t.source),
        lastKnownTitle: typeof t.lastKnownTitle === "string" ? t.lastKnownTitle.slice(0, LAST_KNOWN_TITLE_MAX) : ""
      });
    }
    if (!tabs.length) continue;
    windows.push({
      windowId: uniqueId(w.windowId),
      bounds: normalizeBounds(w.bounds),
      maximized: w.maximized === true,
      activeTabId: tabs.some((t) => t.tabId === w.activeTabId) ? w.activeTabId : tabs[0].tabId,
      tabs
    });
  }
  const recents = normalizeRecentsList(raw && raw.recents);
  if (!windows.length) {
    const fresh = freshDesktopState();
    fresh.recents = recents;
    return fresh;
  }
  return { version: DESKTOP_STATE_VERSION, windows, recents };
}

let desktopStateSynthesized = null;

function readDesktopStateV2() {
  let text;
  try { text = fs.readFileSync(stateFilePath(), "utf8"); } catch { text = null; }
  if (desktopStateSynthesized && desktopStateSynthesized.text === text) {
    return structuredClone(desktopStateSynthesized.state);
  }
  let parsed;
  try { parsed = text === null ? undefined : JSON.parse(text); } catch { parsed = undefined; }

  const isObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const state = isObject && parsed.version === DESKTOP_STATE_VERSION ? normalizeDesktopStateV2(parsed)
    : isObject && !("version" in parsed) ? migrateDesktopStateV1(parsed)
    : freshDesktopState();
  desktopStateSynthesized = { text, state: structuredClone(state) };
  return state;
}

const desktopStateQueue = [];
let desktopStateDraining = false;

function writeDesktopStateV2(mutator) {
  return new Promise((resolve) => {
    desktopStateQueue.push({ mutator, resolve });
    if (!desktopStateDraining) drainDesktopStateQueue();
  });
}

function drainDesktopStateQueue() {
  desktopStateDraining = true;
  try {
    while (desktopStateQueue.length) {
      const job = desktopStateQueue.shift();
      let written = false;
      try {
        const current = readDesktopStateV2();
        const result = job.mutator(current);
        if (result !== false) {
          const next = normalizeDesktopStateV2(result && typeof result === "object" ? result : current);
          const file = stateFilePath();
          const text = JSON.stringify(next, null, 2);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          writeFileDurableSync(file, text);
          desktopStateSynthesized = null;
          written = true;
        }
      } catch (err) {
        if (TEST_MODE) process.stderr.write(`[splitpage] desktop-state write failed: ${err && err.stack || err}\n`);
      }
      job.resolve(written);
    }
  } finally {
    desktopStateDraining = false;
  }
}

let recentDocuments = [];

const recentFileIdByPath = new Map();
function fileIdForPath(absPath) {
  const key = pathKey(absPath);
  const existing = recentFileIdByPath.get(key);
  if (existing && fileRegistry.get(existing) === absPath) return existing;
  const id = registerPath(absPath);
  recentFileIdByPath.set(key, id);
  return id;
}

function loadRecentsAtLaunch() {
  recentDocuments = readDesktopStateV2().recents || [];
}

function persistRecents() {
  const snapshot = recentDocuments.map((r) => ({ ...r }));
  return writeDesktopStateV2((current) => { current.recents = snapshot; return current; });
}

function noteRecentDocument(absPath, title) {
  if (typeof absPath !== "string" || !absPath) return false;
  const key = pathKey(absPath);
  const name = typeof title === "string" ? title.slice(0, LAST_KNOWN_TITLE_MAX) : "";
  const at = Date.now();
  const existingIndex = recentDocuments.findIndex((r) => pathKey(r.absPath) === key);
  if (existingIndex === 0) {
    const head = recentDocuments[0];
    head.at = at;
    if (!name || head.title === name) return false;
    head.title = name;
    return true;
  }
  const previous = existingIndex === -1 ? null : recentDocuments.splice(existingIndex, 1)[0];
  recentDocuments.unshift({
    absPath,
    title: name || (previous ? previous.title : ""),
    at
  });
  if (recentDocuments.length > RECENTS_MAX) recentDocuments.length = RECENTS_MAX;
  return true;
}

function noteRecentDocumentAndPersist(absPath, title) {
  if (!noteRecentDocument(absPath, title)) return;
  if (sessionWritesFrozen || sessionRestoreInProgress || !windowsById.size) persistRecents();
  else persistShellState();
}

function removeRecentDocumentByFileId(fileId) {
  const absPath = typeof fileId === "string" ? fileRegistry.get(fileId) : null;
  if (!absPath) return false;
  const key = pathKey(absPath);
  const before = recentDocuments.length;
  recentDocuments = recentDocuments.filter((r) => pathKey(r.absPath) !== key);
  return recentDocuments.length !== before;
}

function recentsForRenderer() {
  return recentDocuments.map((r) => ({
    fileId: fileIdForPath(r.absPath),
    name: path.basename(r.absPath),
    title: r.title || "",
    at: r.at || 0
  }));
}

function primaryDesktopWindow(state) { return state.windows[0]; }

function shellStateAsV2() {
  const windows = [];
  for (const w of windowsById.values()) {
    if (!w.win || w.win.isDestroyed()) continue;
    const rows = [];
    for (const tabId of w.tabIds) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
      if (tab.source.kind === "blank" && !draftsHasDraft(tabId)) continue;
      rows.push({ tabId, source: normalizeTabSource(tab.source), lastKnownTitle: tab.title || "" });
    }
    if (!rows.length) {
      const active = tabs.get(w.activeTabId);
      rows.push({ tabId: w.activeTabId, source: { kind: "blank" }, lastKnownTitle: (active && active.title) || "" });
    }
    windows.push({
      windowId: w.id,
      bounds: normalizeBounds(w.bounds),
      maximized: !!w.maximized,
      activeTabId: w.activeTabId,
      tabs: rows
    });
  }
  return { version: DESKTOP_STATE_VERSION, windows, recents: recentDocuments };
}

function persistShellState() {
  if (sessionWritesFrozen || sessionRestoreInProgress) return Promise.resolve(false);
  if (!windowsById.size) return Promise.resolve(false);
  return writeDesktopStateV2(() => shellStateAsV2());
}

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

async function atomicWrite(absPath, buffer) {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  await fsp.writeFile(tmp, buffer);
  try {
    await fsp.rename(tmp, absPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

const HISTORY_DESKTOP_CAP_BYTES = 500 * 1024 * 1024;

function historyCapBytes() {
  if (TEST_MODE) {
    const n = Number(process.env.SPLITPAGE_TEST_HISTORY_CAP_BYTES);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return HISTORY_DESKTOP_CAP_BYTES;
}

const HISTORY_TEST_FAULT = TEST_MODE ? String(process.env.SPLITPAGE_TEST_HISTORY_FAULT || "") : "";

function historyTestKill() {
  killDocumentServer();
  killTunnel();
  process.kill(process.pid, "SIGKILL");
}

function historyTestBackendHooks() {
  if (HISTORY_TEST_FAULT !== "exit-after-body") return undefined;
  return { afterBodyPut: historyTestKill };
}

function historyWithEnospcFault(backend) {
  let armed = HISTORY_TEST_FAULT;
  const enospc = () => {
    if (armed === "enospc-once") armed = "";
    else if (armed !== "enospc-always") return;
    const err = new Error("Injected ENOSPC");
    err.code = "enospc";
    throw err;
  };
  return {
    get name() { return backend.name; },
    get persistent() { return backend.persistent; },
    get readOnly() { return backend.readOnly; },
    exclusive: (fn, o) => backend.exclusive((tx) => fn(Object.assign({}, tx, {
      put: async (sha, text) => { enospc(); return tx.put(sha, text); }
    })), o)
  };
}

let historyStore = null;

const historyHolds = new Map();

function historyAllHolds() {
  const out = [];
  for (const held of historyHolds.values()) out.push(...held);
  return out;
}

function historyProtectList(protect) {
  const out = [];
  if (!Array.isArray(protect)) return out;
  for (const p of protect.slice(0, 200)) {
    if (!p || typeof p !== "object") continue;
    const docId = typeof p.docId === "string" ? p.docId : "";
    const id = typeof p.id === "string" ? p.id : "";
    if (!(docId === HISTORY_OLDER_KEY || DOC_ID_RE.test(docId)) || !HISTORY_SNAP_ID_RE.test(id)) continue;
    out.push({ docId, id });
  }
  return out;
}

const HISTORY_V1_BACKUP_DIR = "v1-backup";
const HISTORY_V1_BACKUP_DELAY_MS = 3000;

function removeHistoryV1Backup(historyDir) {
  const target = path.join(historyDir, HISTORY_V1_BACKUP_DIR);
  const timer = setTimeout(() => {
    fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((err) => {
      if (TEST_MODE) process.stderr.write(`[splitpage] history v1-backup not removed (next launch tries again): ${err && err.stack || err}\n`);
    });
  }, HISTORY_V1_BACKUP_DELAY_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
}

function initHistoryStore() {
  const historyDir = path.join(app.getPath("userData"), "history");
  const backend = createHistoryFsBackend({
    dir: historyDir,
    fs, fsp, path, crypto,
    testHooks: historyTestBackendHooks()
  });
  historyStore = createHistoryStore({
    backend: /^enospc-/.test(HISTORY_TEST_FAULT) ? historyWithEnospcFault(backend) : backend,
    now: Date.now,
    hashText: (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex"),
    capBytes: historyCapBytes,
    maxBodyBytes: HISTORY_MAX_BODY_BYTES,
    holds: historyAllHolds
  });
  backend.open().then((r) => {
    if (!r.readOnly) removeHistoryV1Backup(historyDir);
  }, (err) => {
    if (TEST_MODE) process.stderr.write(`[splitpage] history open failed: ${err && err.stack || err}\n`);
  });
}

function historyWireMeta(m) {
  if (!m || typeof m !== "object") return m;
  const out = Object.assign({}, m);
  delete out.docId;
  return out;
}

let blobStore = null;

function initBlobStore() {
  try {
    blobStore = createBlobStore({ dir: path.join(app.getPath("userData"), "blobs"), fs, fsp, path, crypto });
    return blobStore.init();
  } catch (err) {
    blobStore = null;
    if (TEST_MODE) process.stderr.write(`[splitpage] blob store unavailable: ${err && err.stack || err}\n`);
    return null;
  }
}

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
    } catch { }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function startDocumentServer() {
  const host = documentServerHost({ hosting: HOSTING, testMode: TEST_MODE });
  const port = await findFreePort(WANTED_PORT, host);
  if (port == null) {
    const message = `Ports ${WANTED_PORT}-${WANTED_PORT + 20} are all busy. Try --port with something else.`;
    if (TEST_MODE) {
      process.stderr.write(`[splitpage-test] ${message}\n`);
      killDocumentServer();
      killTunnel();
      app.exit(71);
      return false;
    }
    dialog.showErrorBox("Splitpage", message);
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
      REVIEW_PIN,
      REVIEW_KEY,
      ALLOW_ORIGINS: ALLOW_ORIGINS.join(","),
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

function readAppVersion() {
  try { return fs.readFileSync(path.join(APP_ROOT, "VERSION"), "utf8").trim(); } catch { return app.getVersion(); }
}

function compareVersions(a, b) {
  const va = splitVersion(a), vb = splitVersion(b);
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const na = va.core[i] || 0, nb = vb.core[i] || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  if (!va.pre.length || !vb.pre.length) return va.pre.length === vb.pre.length ? 0 : (va.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i], y = vb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function splitVersion(v) {
  const s = String(v).trim().replace(/\+.*$/, "");
  const dash = s.indexOf("-");
  return {
    core: (dash === -1 ? s : s.slice(0, dash)).split(".").map((n) => parseInt(n, 10) || 0),
    pre: dash === -1 ? [] : s.slice(dash + 1).split(".").filter(Boolean)
  };
}

const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const INSTALLER_EXT = { win32: ".exe", darwin: ".dmg", linux: ".appimage" };

const DEFAULT_UPDATE_API =
  "https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest";

function updateApiUrl() {
  return process.env.SPLITPAGE_UPDATE_API || DEFAULT_UPDATE_API;
}

function isAllowedDownloadHost(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { return false; }
  let api;
  try { api = new URL(updateApiUrl()); } catch { api = null; }
  if (api && parsed.origin === api.origin) return true;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "github.com"
    || host === "api.github.com"
    || host.endsWith(".githubusercontent.com");
}

function pickUpdateAsset(assets) {
  const ext = INSTALLER_EXT[process.platform];
  if (!ext) return null;
  const candidates = (assets || []).filter((a) => {
    const name = String((a && a.name) || "");
    return SAFE_ASSET_NAME.test(name)
      && name.toLowerCase().endsWith(ext)
      && isAllowedDownloadHost(String((a && a.browser_download_url) || ""));
  });
  if (!candidates.length) return null;

  const arch = process.arch;
  const other = ["x64", "arm64", "ia32", "armv7l"].filter((a) => a !== arch);
  const mentions = (name, token) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(name);

  const mine = candidates.filter((a) => mentions(a.name, arch));
  if (mine.length === 1) return describeAsset(mine[0]);
  if (mine.length > 1) return null;

  const neutral = candidates.filter((a) => !other.some((o) => mentions(a.name, o)));
  if (neutral.length === 1) return describeAsset(neutral[0]);
  return null;
}

function describeAsset(asset) {
  return {
    name: path.basename(String(asset.name)),
    url: String(asset.browser_download_url),
    size: Number.isFinite(asset.size) ? asset.size : 0
  };
}

const CHECKSUMS_ASSET = /^SHA256SUMS(\.txt)?$/i;

async function fetchPublishedChecksum(assets, assetName) {
  const entry = (assets || []).find((a) => CHECKSUMS_ASSET.test(String((a && a.name) || ""))
    && isAllowedDownloadHost(String((a && a.browser_download_url) || "")));
  if (!entry) return null;
  try {
    const res = await net.fetch(entry.browser_download_url, { headers: { "User-Agent": "splitpage-desktop" } });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 200000) return null;
    for (const line of text.split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
      if (m && path.basename(m[2]) === assetName) return m[1].toLowerCase();
    }
  } catch { }
  return null;
}

let updateStatus = {
  version: readAppVersion(),
  checkedAt: null,
  checking: !SKIP_UPDATE_CHECK,
  latest: null,
  updateAvailable: false,
  pending: null,
  justUpdated: null,
  desktop: true,
  canInstall: false,
  releaseUrl: null,
  download: { state: "idle", received: 0, total: 0, error: null }
};

let updateAsset = null;
let updateAssets = [];
let updateFile = null;
let updateDownloadPromise = null;

function updateDir() {
  return path.join(app.getPath("userData"), "updates");
}

function broadcastUpdateStatus() {
  for (const tab of tabs.values()) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    try { tab.view.webContents.send("splitpage:update-status", updateStatus); } catch { }
  }
}

function setUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch };
  broadcastUpdateStatus();
}

function setDownloadState(patch) {
  setUpdateStatus({ download: { ...updateStatus.download, ...patch } });
}

async function checkForUpdate() {
  if (SKIP_UPDATE_CHECK) return;
  const current = readAppVersion();
  const apiUrl = updateApiUrl();
  try {
    const res = await net.fetch(apiUrl, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "splitpage-desktop" }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.json();
    const latest = String(body.tag_name || body.name || "").replace(/^v/, "").trim();
    const newer = !!latest && compareVersions(latest, current) > 0;
    updateAssets = Array.isArray(body.assets) ? body.assets : [];
    updateAsset = newer ? pickUpdateAsset(updateAssets) : null;
    setUpdateStatus({
      version: current,
      checkedAt: new Date().toISOString(),
      checking: false,
      latest,
      updateAvailable: newer,
      canInstall: !!updateAsset,
      releaseUrl: body.html_url || null,
      error: undefined
    });
  } catch (err) {
    setUpdateStatus({
      version: current,
      checkedAt: new Date().toISOString(),
      checking: false,
      error: err.message
    });
  }
}

function downloadUpdate() {
  if (updateDownloadPromise) return updateDownloadPromise;
  if (updateStatus.download.state === "ready" && updateFile) {
    return Promise.resolve({ ok: true, state: "ready" });
  }
  const asset = updateAsset;
  if (!asset) return Promise.resolve({ ok: false, error: "no-installer" });
  if (!isAllowedDownloadHost(asset.url)) return Promise.resolve({ ok: false, error: "bad-url" });

  updateDownloadPromise = (async () => {
    const dir = updateDir();
    const target = path.join(dir, asset.name);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    if (path.dirname(path.resolve(target)) !== path.resolve(dir)) throw new Error("bad asset name");

    updateFile = null;
    setDownloadState({ state: "downloading", received: 0, total: asset.size || 0, error: null });

    const res = await net.fetch(asset.url, { headers: { "User-Agent": "splitpage-desktop" } });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const declared = Number(res.headers.get("content-length")) || asset.size || 0;
    setDownloadState({ total: declared });

    const hash = crypto.createHash("sha256");
    const handle = await fsp.open(target, "w");
    let received = 0;
    let lastReport = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        await handle.write(buf);
        received += buf.length;
        const now = Date.now();
        if (now - lastReport > 200) { lastReport = now; setDownloadState({ received }); }
      }
    } finally {
      await handle.close();
    }
    setDownloadState({ received });

    if (declared && received !== declared) {
      throw new Error(`download is ${received} bytes, expected ${declared} — it was cut short`);
    }
    const digest = hash.digest("hex");
    const published = await fetchPublishedChecksum(updateAssets, asset.name);
    if (!published) {
      throw new Error("this release has no published checksum, so it is not being installed");
    }
    if (published !== digest) {
      throw new Error("the download does not match the checksum published for it");
    }

    updateFile = target;
    setDownloadState({ state: "ready", error: null, verified: true });
    return { ok: true, state: "ready" };
  })().catch(async (err) => {
    updateFile = null;
    await fsp.rm(updateDir(), { recursive: true, force: true }).catch(() => {});
    setDownloadState({ state: "failed", error: err.message });
    return { ok: false, error: "download-failed", message: err.message };
  }).finally(() => { updateDownloadPromise = null; });

  return updateDownloadPromise;
}

let installOnQuit = false;
let installQuitWatcher = null;

function startInstallerNow() {
  try {
    if (process.platform === "win32") {
      const child = spawn(updateFile, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
    } else {
      shell.openPath(updateFile);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "could-not-run", message: err.message };
  }
}

function runUpdateInstaller() {
  if (updateStatus.download.state !== "ready" || !updateFile) {
    return Promise.resolve({ ok: false, error: "not-downloaded" });
  }
  if (!fs.existsSync(updateFile)) {
    setDownloadState({ state: "idle", received: 0, error: null });
    updateFile = null;
    return Promise.resolve({ ok: false, error: "not-downloaded" });
  }
  if (TEST_MODE) return Promise.resolve({ ok: true, testMode: true });

  installOnQuit = true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    installQuitWatcher = done;
    app.quit();
    setTimeout(() => {
      if (settled) return;
      installOnQuit = false;
      installQuitWatcher = null;
      setDownloadState({ state: "ready" });
      done({ ok: false, error: "quit-cancelled" });
    }, 3000);
  });
}

const SERVER_DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

let prompterShare = null;
function prompterShareInstance() {
  if (!prompterShare) {
    prompterShare = createPrompterShare({
      staticAllowlist: STATIC_ALLOWLIST,
      readStatic: (entry) => {
        const absPath = path.join(APP_ROOT, entry.file);
        if (!absPath.startsWith(APP_ROOT)) return Promise.reject(new Error("outside APP_ROOT"));
        return fsp.readFile(absPath);
      },
      cspHeader: readAppCsp,
      voice: {
        start: (ownerId) => voiceHelperInstance().start(VOICE_RELAY_PREFIX + ownerId),
        stop: (ownerId, session) => {
          const helper = voiceHelperInstance();
          const st = helper.status();
          if (st.tabId === VOICE_RELAY_PREFIX + ownerId && st.session === session) helper.stop(VOICE_RELAY_PREFIX + ownerId);
        }
      },
      corsOrigins: () => documentServerPort
        ? [`http://127.0.0.1:${documentServerPort}`, `http://localhost:${documentServerPort}`]
        : []
    });
  }
  return prompterShare;
}

function prompterRelaysVoice() {
  return voiceHelperInstance().available();
}

async function pickChromiumBrowser() {
  if (TEST_MODE && process.env.SPLITPAGE_TEST_CHROMIUM) {
    const id = process.env.SPLITPAGE_TEST_CHROMIUM;
    const name = chromiumBrowserName(id);
    return name ? { id, name, path: "(test)" } : null;
  }
  try {
    const found = await findChromiumBrowsers();
    return found[0] || null;
  } catch {
    return null;
  }
}

async function openPrompterInBrowser(tab, opts) {
  if (!tab) return { ok: false, code: "NO_TAB" };
  if (tab.dirty) return { ok: false, code: "UNSAVED_CHANGES" };
  const chromium = !!(opts && opts.chromium);
  let browser = null;
  if (chromium) {
    browser = await pickChromiumBrowser();
    if (!browser) return { ok: false, code: "NO_CHROMIUM" };
    if (!tabs.has(tab.id)) return { ok: false, code: "NO_TAB" };
    if (tab.dirty) return { ok: false, code: "UNSAVED_CHANGES" };
  }
  const source = tab.source || { kind: "blank" };
  let url;
  let relay = !chromium && prompterRelaysVoice();
  if (source.kind === "server") {
    if (source.serverUrl) return { ok: false, code: "REMOTE_SERVER" };
    const id = typeof source.serverDocId === "string" ? source.serverDocId : "";
    if (!SERVER_DOC_ID_RE.test(id)) return { ok: false, code: "NOT_SAVED" };
    if (!documentServerPort) return { ok: false, code: "NO_SERVER" };
    url = `http://127.0.0.1:${documentServerPort}/?doc=${encodeURIComponent(id)}&teleprompter=1`;
    if (relay) {
      try {
        url += "#" + await prompterShareInstance().publishVoice(tab.id);
      } catch (err) {
        if (TEST_MODE) process.stderr.write(`[splitpage] prompter voice relay failed: ${err && err.stack || err}\n`);
        relay = false;
      }
      if (!tabs.has(tab.id)) { if (prompterShare) prompterShare.revoke(tab.id); return { ok: false, code: "NO_TAB" }; }
    }
  } else if (source.kind === "file") {
    const absPath = source.absPath;
    if (!isShareableName(absPath)) return { ok: false, code: "NOT_A_PROJECT" };
    let text;
    try {
      const st = await fsp.stat(absPath);
      if (!st.isFile()) return { ok: false, code: "READ_FAILED" };
      if (st.size > MAX_SCRIPT_BYTES) return { ok: false, code: "TOO_LARGE" };
      text = await fsp.readFile(absPath, "utf8");
    } catch {
      return { ok: false, code: "READ_FAILED" };
    }
    if (!tabs.has(tab.id)) return { ok: false, code: "NO_TAB" };
    if (tab.dirty) return { ok: false, code: "UNSAVED_CHANGES" };
    try {
      url = await prompterShareInstance().publish(tab.id, path.basename(absPath), text, { voice: relay });
    } catch (err) {
      if (TEST_MODE) process.stderr.write(`[splitpage] prompter share failed: ${err && err.stack || err}\n`);
      return { ok: false, code: "SERVE_FAILED" };
    }
  } else {
    return { ok: false, code: "NOT_SAVED" };
  }
  if (browser) {
    try {
      if (TEST_MODE) testChromiumLaunches.push({ browser: browser.id, url });
      else await launchChromiumBrowser(browser, url);
    } catch {
      return { ok: false, code: "OPEN_FAILED" };
    }
    return { ok: true, kind: source.kind, voice: "browser", browser: browser.name };
  }
  try {
    await shell.openExternal(url);
  } catch {
    return { ok: false, code: "OPEN_FAILED" };
  }
  return { ok: true, kind: source.kind, voice: relay ? "relay" : "browser" };
}

const DRIVE_TEST_BASIC_TEXT = TEST_MODE && process.env.SPLITPAGE_TEST_DRIVE_BASIC_TEXT === "1";
let driveBasicTextArmed = false;
function driveSafeStorage() {
  return {
    isEncryptionAvailable() {
      if (DRIVE_TEST_BASIC_TEXT && process.platform === "linux" && !driveBasicTextArmed &&
          typeof safeStorage.setUsePlainTextEncryption === "function") {
        driveBasicTextArmed = true;
        safeStorage.setUsePlainTextEncryption(true);
      }
      if (!safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === "linux" && !DRIVE_TEST_BASIC_TEXT) {
        let backend = "unknown";
        try { backend = safeStorage.getSelectedStorageBackend(); } catch { }
        if (backend === "basic_text" || backend === "unknown") return false;
      }
      return true;
    },
    encryptString: (s) => safeStorage.encryptString(s),
    decryptString: (b) => safeStorage.decryptString(b)
  };
}

let googleDrive = null;
function googleDriveInstance() {
  if (!googleDrive) {
    googleDrive = createGoogleDrive({
      userDataDir: app.getPath("userData"),
      env: process.env,
      safeStorage: driveSafeStorage(),
      openExternal: (url) => shell.openExternal(url),
      testMode: TEST_MODE,
      testEndpointsBase: TEST_MODE && process.env.SPLITPAGE_TEST_GOOGLE_BASE ? process.env.SPLITPAGE_TEST_GOOGLE_BASE : undefined,
      log: (line) => { if (TEST_MODE) process.stderr.write("[splitpage] " + line + "\n"); }
    });
  }
  return googleDrive;
}

const VOICE_SCRIPT = app.isPackaged
  ? path.join(APP_ROOT, "voice", "listen.ps1")
  : path.join(__dirname, "voice", "listen.ps1");

function voiceCommand() {
  if (TEST_MODE) {
    if (!process.env.SPLITPAGE_TEST_VOICE_HELPER) return null;
    return {
      file: process.execPath,
      args: [process.env.SPLITPAGE_TEST_VOICE_HELPER],
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" })
    };
  }
  if (process.platform !== "win32") return null;
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(powershell) || !fs.existsSync(VOICE_SCRIPT)) return null;
  return {
    file: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", VOICE_SCRIPT],
    env: process.env
  };
}

const VOICE_RELAY_PREFIX = "relay:";

let voiceHelper = null;
function voiceHelperInstance() {
  if (!voiceHelper) {
    voiceHelper = createVoiceHelper({
      command: voiceCommand,
      onEvent: (tabId, event) => {
        if (tabId.startsWith(VOICE_RELAY_PREFIX)) {
          if (prompterShare) prompterShare.pushVoice(tabId.slice(VOICE_RELAY_PREFIX.length), event);
          return;
        }
        const tab = tabs.get(tabId);
        if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
        try { tab.view.webContents.send("splitpage:voice-event", event); } catch { }
      }
    });
  }
  return voiceHelper;
}

const videoEmbed = require(path.join(SHARED_ROOT, "video-embed.js"));

const VIDEO_TEST_BASES = TEST_MODE && process.env.SPLITPAGE_TEST_VIDEO_BASE
  ? (() => {
      const base = String(process.env.SPLITPAGE_TEST_VIDEO_BASE).replace(/\/+$/, "");
      const out = {};
      for (const k of Object.keys(videoEmbed.VIDEO_HOSTS)) out[k] = base + "/" + k;
      return out;
    })()
  : null;

const YOUTUBE_EMBED_REFERER = "https://com.retrogorilla.splitpage/";

function videoThumbnail(host, ref) {
  const v = videoEmbed.parseVideoRef(host, ref);
  if (!v) return Promise.resolve({ ok: false, code: "BAD_REF" });
  return videoEmbed.fetchVideoThumbnail(v, { fetch: globalThis.fetch, bases: VIDEO_TEST_BASES || undefined }).then((res) => {
    if (TEST_MODE) process.stderr.write("[splitpage] video-thumbnail " + host + " " + (res.ok ? "ok" : res.code) + "\n");
    return res.ok ? { ok: true, bytes: res.bytes, mime: res.mime } : { ok: false, code: res.code };
  });
}

function installPlayerReferer(ses) {
  const embedPrefix = (VIDEO_TEST_BASES ? VIDEO_TEST_BASES.youtubePlayer : videoEmbed.VIDEO_HOSTS.youtubePlayer) + "/embed/";
  const filter = { urls: [embedPrefix + "*"] };
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders || {};
    const hasReferer = Object.keys(headers).some((k) => k.toLowerCase() === "referer");
    const fromTab = details.resourceType === "subFrame" && typeof details.webContentsId === "number" &&
      webContentsIdToTabId.has(details.webContentsId);
    if (!hasReferer && fromTab && details.url.startsWith(embedPrefix)) headers.Referer = YOUTUBE_EMBED_REFERER;
    callback({ requestHeaders: headers });
  });
}

let appCspHeader = null;

async function readAppCsp() {
  if (appCspHeader !== null) return appCspHeader;
  appCspHeader = "";
  try {
    const html = await fsp.readFile(path.join(APP_ROOT, "index.html"), "utf8");
    const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html.slice(0, 20000));
    if (m) appCspHeader = m[1] + "; frame-ancestors 'none'";
  } catch { }
  return appCspHeader;
}

const TABSTRIP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

function registerProtocol() {
  protocol.handle("splitpage", async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return new Response("bad url", { status: 400 }); }
    const pathname = decodeURIComponent(url.pathname);

    if (url.hostname === "tabstrip") {
      const stripEntry = TABSTRIP_ALLOWLIST[pathname === "/" ? "/index.html" : pathname];
      if (!stripEntry) return new Response("not found", { status: 404 });
      const stripPath = path.join(TABSTRIP_ROOT, stripEntry.file);
      if (!stripPath.startsWith(TABSTRIP_ROOT)) return new Response("not found", { status: 404 });
      try {
        const buf = await fsp.readFile(stripPath);
        return new Response(buf, {
          status: 200,
          headers: { "content-type": stripEntry.type, "content-security-policy": TABSTRIP_CSP }
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    if (url.hostname !== "app") return new Response("not found", { status: 404 });

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

    if (pathname === "/update-status.json") {
      return new Response(JSON.stringify(updateStatus), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    const key = pathname === "/" ? "/index.html" : pathname;
    const entry = STATIC_ALLOWLIST[key];
    if (!entry) return new Response("not found", { status: 404 });

    const absPath = path.join(APP_ROOT, entry.file);
    if (!absPath.startsWith(APP_ROOT)) return new Response("not found", { status: 404 });
    try {
      const buf = await fsp.readFile(absPath);
      const headers = { "content-type": entry.type };
      const csp = await readAppCsp();
      if (csp) headers["content-security-policy"] = csp;
      return new Response(buf, { status: 200, headers });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function themeChoicePath() { return path.join(app.getPath("userData"), "theme.json"); }

function readThemeChoice() {
  try {
    const mode = JSON.parse(fs.readFileSync(themeChoicePath(), "utf8")).theme;
    return mode === "light" || mode === "dark" ? mode : "system";
  } catch { return "system"; }
}

function writeThemeChoice(mode) {
  if (readThemeChoice() === mode) return;
  try {
    fs.mkdirSync(path.dirname(themeChoicePath()), { recursive: true });
    fs.writeFileSync(themeChoicePath(), JSON.stringify({ theme: mode }), "utf8");
  } catch { }
}

function backgroundColorForTheme() {
  return nativeTheme.shouldUseDarkColors ? "#0F0E0C" : "#F1F0ED";
}

function boundsIfVisible(b) {
  if (!b || typeof b.x !== "number") return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
           b.y < wa.y + wa.height && b.y + b.height > wa.y;
  });
  return onScreen ? b : null;
}

function savedBoundsIfVisible() {
  return boundsIfVisible(primaryDesktopWindow(readDesktopStateV2()).bounds);
}

function titleBarOverlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: "#0F0E0C", symbolColor: "#ECEBE7", height: TITLEBAR_H }
    : { color: "#F1F0ED", symbolColor: "#171613", height: TITLEBAR_H };
}

function mintUniqueTabId(preferred) {
  if (typeof preferred === "string" && TAB_OR_WINDOW_ID_RE.test(preferred) && !tabs.has(preferred)) return preferred;
  let id = mintTabOrWindowId();
  while (tabs.has(id)) id = mintTabOrWindowId();
  return id;
}

function mintUniqueWindowId(preferred) {
  if (typeof preferred === "string" && TAB_OR_WINDOW_ID_RE.test(preferred) && !windowsById.has(preferred)) return preferred;
  let id = mintTabOrWindowId();
  while (windowsById.has(id)) id = mintTabOrWindowId();
  return id;
}

function createTabWindow(restoreSpec) {
  const spec = restoreSpec || {};
  const saved = boundsIfVisible(normalizeBounds(spec.bounds)) || (windowsById.size ? null : savedBoundsIfVisible());
  const iconPath = app.isPackaged ? undefined : path.join(APP_ROOT, "installer", "icon.ico");

  const win = new BrowserWindow({
    width: saved ? saved.width : 1400,
    height: saved ? saved.height : 900,
    x: saved ? saved.x : (typeof spec.x === "number" ? spec.x : undefined),
    y: saved ? saved.y : (typeof spec.y === "number" ? spec.y : undefined),
    minWidth: MIN_WINDOW_W,
    minHeight: MIN_WINDOW_H,
    backgroundColor: backgroundColorForTheme(),
    show: false,
    skipTaskbar: TEST_MODE,
    title: "Splitpage",
    icon: iconPath,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlayColors(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "tabstrip-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: !TEST_MODE
    }
  });

  const windowId = mintUniqueWindowId(spec.windowId);
  const rec = {
    id: windowId,
    win,
    tabIds: [],
    activeTabId: null,
    lastFocusedAt: Date.now(),
    boundsSaveTimer: null,
    bounds: saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null,
    maximized: !!spec.maximized
  };
  windowsById.set(windowId, rec);
  if (lastFocusedWindowId === null) lastFocusedWindowId = windowId;

  if (rec.maximized && saved && !TEST_MODE) win.maximize();

  win.once("ready-to-show", () => { if (!TEST_MODE) win.show(); });

  win.loadURL("splitpage://tabstrip/index.html");

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("splitpage://tabstrip/")) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on("focus", () => {
    lastFocusedWindowId = windowId;
    rec.lastFocusedAt = Date.now();
  });

  win.on("resize", () => { layoutWindow(windowId); scheduleBoundsSave(windowId); });
  win.on("move", () => scheduleBoundsSave(windowId));
  win.on("maximize", () => {
    rec.maximized = true;
    layoutWindow(windowId);
    persistShellState();
  });
  win.on("unmaximize", () => {
    rec.maximized = false;
    if (!win.isDestroyed()) rec.bounds = win.getBounds();
    layoutWindow(windowId);
    persistShellState();
  });

  win.on("close", (event) => {
    if (quitConfirmed || sessionEnding) {
      closeConfirmedWindows.add(win);
      return;
    }
    if (closeConfirmedWindows.has(win)) return;
    if (rec.closeKeepingDrafts) { event.preventDefault(); return; }

    const isLastWindow = liveWindows().length <= 1;

    if (HOSTING && isLastWindow && !hostingConfirmed) {
      if (!askHostingPrompt(win)) { event.preventDefault(); return; }
    }

    const tabIds = rec.tabIds.slice();
    const confirmClose = () => {
      settleDraftsForClose(tabIds, true, "close-without-saving");
      if (HOSTING && isLastWindow) hostingConfirmed = true;
      if (isLastWindow) sessionWritesFrozen = true;
      closeConfirmedWindows.add(win);
    };

    if (!tabIds.some((id) => tabHasFile(tabs.get(id)))) {
      if (askAboutUnsaved(unsavedTabsOf(tabIds, []), "Close window", win) !== "discard") { event.preventDefault(); return; }
      confirmClose();
      return;
    }

    event.preventDefault();
    rec.closeKeepingDrafts = true;
    const parent = () => (win.isDestroyed() ? undefined : win);
    askBeforeClosing(tabIds, "Close window", parent, () => !quitKeepingDrafts && !quitConfirmed && !sessionEnding).then((answer) => {
      rec.closeKeepingDrafts = false;
      if (answer !== "discard" || win.isDestroyed()) return;
      confirmClose();
      win.close();
    });
  });

  win.on("session-end", () => {
    if (sessionEnding) return;
    sessionEnding = true;
    sessionWritesFrozen = true;
    if (draftStore) { try { draftStore.markSessionEnd(); } catch { } }
    const flushes = [];
    for (const tab of tabs.values()) {
      if (tab.view.webContents.isDestroyed()) continue;
      flushes.push(tabFileGone(tab).then((gone) => {
        if (gone) tab.keepDraftOnClose = true;
        return requestDraftFlush(tab, DRAFT_FLUSH_BUDGET_MS, gone);
      }));
    }
    Promise.all(flushes).then((results) => {
      if (!TEST_MODE) return;
      const ok = results.filter((r) => r && r.ok).length;
      process.stderr.write(`[splitpage] session-end flush: ${ok}/${results.length} tabs answered\n`);
    });
  });

  win.on("closed", () => {
    clearTimeout(rec.boundsSaveTimer);
    for (const tabId of rec.tabIds.slice()) forgetTab(tabId);
    windowsById.delete(windowId);
    if (lastFocusedWindowId === windowId) {
      const next = windowsById.keys().next();
      lastFocusedWindowId = next.done ? null : next.value;
    }
    persistShellState();
  });

  return rec;
}

function createTunnelWindow() {
  const saved = savedBoundsIfVisible();
  const iconPath = app.isPackaged ? undefined : path.join(APP_ROOT, "installer", "icon.ico");

  const win = new BrowserWindow({
    width: saved ? saved.width : 1400,
    height: saved ? saved.height : 900,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: MIN_WINDOW_W,
    minHeight: MIN_WINDOW_H,
    backgroundColor: backgroundColorForTheme(),
    show: false,
    skipTaskbar: TEST_MODE,
    title: "Splitpage",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: !TEST_MODE
    }
  });

  win.once("ready-to-show", () => { if (!TEST_MODE) win.show(); });
  win.loadURL(tunnelLocalUrl);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`http://localhost:${TUNNEL_LOCAL_PORT}/`)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.on("closed", () => { if (tunnelWindow === win) tunnelWindow = null; });
  return win;
}

function firstWindowRecord() {
  const it = windowsById.values().next();
  return it.done ? null : it.value;
}

function windowRecordFor(windowId) {
  return windowsById.get(windowId) || (lastFocusedWindowId ? windowsById.get(lastFocusedWindowId) : null) || firstWindowRecord();
}

function claimRoutingKey(map, key, tabId) {
  const owner = map.get(key);
  if (owner && owner !== tabId && tabs.has(owner)) return false;
  map.set(key, tabId);
  return true;
}

function indexTabSource(tab) {
  if (tab.source.kind === "file") claimRoutingKey(pathToTabId, pathKey(tab.source.absPath), tab.id);
  if (tab.source.kind === "server") claimRoutingKey(serverDocIdToTabId, serverRouteKey(tab.source), tab.id);
}

function unindexTabSource(tab) {
  for (const [key, id] of pathToTabId) if (id === tab.id) pathToTabId.delete(key);
  for (const [key, id] of serverDocIdToTabId) if (id === tab.id) serverDocIdToTabId.delete(key);
}

function deliverRestoreNotice(tab) {
  if (!pendingRestoreNotice || !tab || tab.view.webContents.isDestroyed()) return;
  const notice = pendingRestoreNotice;
  pendingRestoreNotice = null;
  try { tab.view.webContents.send("splitpage:restore-notice", { skipped: notice.skipped }); }
  catch { }
}

function retargetRestoreNotice(deadTabId, deadWindow) {
  if (!pendingRestoreNotice || pendingRestoreNotice.tabId !== deadTabId) return;
  let next = deadWindow && deadWindow.activeTabId ? tabs.get(deadWindow.activeTabId) : null;
  if (!next) {
    for (const rec of liveWindows()) {
      next = rec.activeTabId ? tabs.get(rec.activeTabId) : null;
      if (next) break;
    }
  }
  if (!next) { pendingRestoreNotice = null; return; }
  if (next.ready) deliverRestoreNotice(next);
  else pendingRestoreNotice.tabId = next.id;
}

function forgetTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  unindexTabSource(tab);
  webContentsIdToTabId.delete(tab.webContentsId);
  tabs.delete(tabId);
  if (prompterShare) prompterShare.revoke(tabId);
  if (voiceHelper) { voiceHelper.forget(tabId); voiceHelper.forget(VOICE_RELAY_PREFIX + tabId); }
  const w = windowsById.get(tab.windowId);
  if (w) {
    const i = w.tabIds.indexOf(tabId);
    if (i !== -1) w.tabIds.splice(i, 1);
    if (w.activeTabId === tabId) {
      w.activeTabId = w.tabIds.length ? w.tabIds[Math.max(0, Math.min(i, w.tabIds.length - 1))] : null;
    }
  }
  historyHolds.delete(tab.webContentsId);
  retargetRestoreNotice(tabId, w);
}

function createTab(windowId, opts) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return null;
  const o = opts || {};
  const tabId = mintUniqueTabId(o.tabId);

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: !TEST_MODE
    }
  });
  view.setBackgroundColor(backgroundColorForTheme());

  const tab = {
    id: tabId,
    windowId,
    view,
    webContentsId: view.webContents.id,
    source: liveTabSource(o.source),
    fileId: null,
    title: "",
    dirty: false,
    pristine: true,
    docId: null,
    serverKey: null,
    launchIntent: o.launchIntent || { type: "blank" },
    ready: false,
    pendingPayload: o.pendingPayload || null,
    reloadTimes: [],
    crashedNotReloaded: false,
    firstTabOfLaunch: !firstTabCreated
  };

  tabs.set(tabId, tab);
  webContentsIdToTabId.set(tab.webContentsId, tabId);
  indexTabSource(tab);

  const at = typeof o.index === "number" ? Math.max(0, Math.min(o.index, w.tabIds.length)) : w.tabIds.length;
  w.tabIds.splice(at, 0, tabId);
  w.win.contentView.addChildView(view);

  wireTabView(tab);

  view.webContents.loadURL(`splitpage://app/index.html?tab=${tabId}`);

  firstTabCreated = true;
  activateTab(tabId);
  persistShellState();
  return tab;
}

function wireTabView(tab) {
  const contents = tab.view.webContents;
  const tabId = tab.id;

  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (url.startsWith("splitpage://app/")) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  contents.on("context-menu", (event, params) => {
    const template = [];
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions || [];
      if (suggestions.length) {
        suggestions.forEach((s) => {
          template.push({ label: s, click: () => contents.replaceMisspelling(s) });
        });
      } else {
        template.push({ label: "No spelling suggestions", enabled: false });
      }
      template.push({ type: "separator" });
      template.push({
        label: "Add to dictionary",
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      template.push({ type: "separator" });
    }
    const flags = params.editFlags || {};
    if (flags.canCut) template.push({ label: "Cut", click: () => contents.cut() });
    if (flags.canCopy) template.push({ label: "Copy", click: () => contents.copy() });
    if (flags.canPaste) template.push({ label: "Paste", click: () => contents.paste() });
    if (flags.canSelectAll) template.push({ label: "Select all", click: () => contents.selectAll() });
    if (!template.length) return;
    const w = windowsById.get(tab.windowId);
    Menu.buildFromTemplate(template).popup({ window: w ? w.win : undefined });
  });

  contents.on("will-prevent-unload", (event) => {
    const w = windowsById.get(tab.windowId);
    if (quitConfirmed || sessionEnding
        || (w && closeConfirmedWindows.has(w.win)) || closeConfirmedTabViews.has(tab.view)) {
      event.preventDefault();
      return;
    }
    const answer = consumeTestDialogAnswer();
    let leave;
    if (answer === "confirm") leave = true;
    else if (answer === "cancel") leave = false;
    else {
      const choice = dialog.showMessageBoxSync(w ? w.win : undefined, {
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

  contents.on("render-process-gone", (_event, details) => {
    if (details && details.reason === "clean-exit") return;
    if (!tabs.has(tabId)) return;
    if (draftStore && draftsHasDraft(tabId)) {
      try { draftStore.hold(tabId); } catch { }
    }

    const now = Date.now();
    tab.reloadTimes = tab.reloadTimes.filter((t) => now - t < CRASH_RELOAD_WINDOW_MS);
    const w = windowsById.get(tab.windowId);
    const windowAlive = !!(w && !w.win.isDestroyed());
    tab.ready = false;

    if (tab.reloadTimes.length >= CRASH_RELOAD_MAX || !windowAlive || quitConfirmed || sessionEnding) {
      tab.crashedNotReloaded = true;
      if (windowAlive) { applyWindowTitle(w); pushShellState(w.id); }
      return;
    }

    tab.reloadTimes.push(now);
    tab.crashedNotReloaded = false;
    tab.pendingPayload = payloadForSource(tab.source);
    try { contents.reload(); } catch { tab.crashedNotReloaded = true; }
  });

  contents.on("did-navigate", () => {
    if (!tabs.has(tabId)) return;
    tab.ready = false;
    if (draftStore) { try { draftStore.resetSeq(tabId); } catch { } }
  });

  contents.on("destroyed", () => {
    if (!tabs.has(tabId)) return;
    const w = windowsById.get(tab.windowId);
    forgetTab(tabId);
    if (w && !w.win.isDestroyed()) {
      if (!w.tabIds.length) {
        closeConfirmedWindows.add(w.win);
        w.win.close();
      } else {
        activateTab(w.activeTabId);
        pushShellState(w.id);
        persistShellState();
      }
    }
  });
}

function destroyTabView(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const w = windowsById.get(tab.windowId);
  forgetTab(tabId);
  closeConfirmedTabViews.add(tab.view);
  try {
    if (w && !w.win.isDestroyed()) w.win.contentView.removeChildView(tab.view);
  } catch { }
  try {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  } catch { }
  if (w && !w.win.isDestroyed()) {
    if (!w.tabIds.length) {
      closeConfirmedWindows.add(w.win);
      w.win.close();
      return;
    }
    activateTab(w.activeTabId);
    pushShellState(w.id);
  }
  persistShellState();
}

function layoutWindow(windowId) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return;
  const size = w.win.getContentBounds();
  const height = Math.max(0, size.height - TITLEBAR_H);
  for (const tabId of w.tabIds) {
    const tab = tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) continue;
    const active = tabId === w.activeTabId;
    if (active) tab.view.setBounds({ x: 0, y: TITLEBAR_H, width: size.width, height });
    tab.view.setVisible(active);
  }
}

function activateTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const w = windowsById.get(tab.windowId);
  if (!w || w.win.isDestroyed()) return;
  w.activeTabId = tabId;
  layoutWindow(w.id);
  applyWindowTitle(w);
  if (!TEST_MODE) {
    try { tab.view.webContents.focus(); } catch { }
  }
  pushShellState(w.id);
}

function applyWindowTitle(w) {
  if (!w || w.win.isDestroyed()) return;
  const tab = tabs.get(w.activeTabId);
  const title = (tab && tab.title) || "Untitled";
  const dirty = !!(tab && tab.dirty && !tab.crashedNotReloaded);
  w.win.setTitle(dirty ? `• ${title} — Splitpage` : `${title} — Splitpage`);
  if (process.platform === "darwin") w.win.setDocumentEdited(dirty);
}

function scheduleBoundsSave(windowId) {
  const w = windowsById.get(windowId);
  if (!w) return;
  clearTimeout(w.boundsSaveTimer);
  w.boundsSaveTimer = setTimeout(() => {
    if (!w.win || w.win.isDestroyed()) return;
    w.maximized = w.win.isMaximized();
    if (!w.maximized) w.bounds = w.win.getBounds();
    persistShellState();
  }, 400);
}

function shellStateForWindow(windowId) {
  const w = windowsById.get(windowId);
  if (!w) return null;
  return {
    windowId,
    activeTabId: w.activeTabId,
    tabs: w.tabIds.map((id) => {
      const t = tabs.get(id);
      if (!t) return null;
      return {
        tabId: id,
        title: t.title || "Untitled",
        dirty: !!t.dirty && !t.crashedNotReloaded,
        crashed: !!t.crashedNotReloaded,
        isServerDoc: t.source.kind === "server",
        pristine: !!t.pristine,
        fullPathForTooltip: t.source.kind === "file" ? t.source.absPath : null
      };
    }).filter(Boolean)
  };
}

function pushShellState(windowId) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return;
  try { w.win.webContents.send("splitpage:tabstrip-state", shellStateForWindow(windowId)); } catch { }
}

function deliverOpenFile(tab, absPath) {
  const id = registerPath(absPath);
  readFileEntry(id, absPath).then((entry) => {
    if (tab.view.webContents.isDestroyed()) return;
    tab.fileId = id;
    tab.view.webContents.send("splitpage:open-file", entry);
    noteRecentDocumentAndPersist(absPath, tab.title || "");
  }).catch(() => { });
}

function routeOpenPath(absPath, opts) {
  const o = opts || {};
  let resolved;
  try {
    if (!fs.statSync(absPath).isFile()) return null;
    resolved = path.resolve(absPath);
  } catch { return null; }

  const existingId = pathToTabId.get(pathKey(resolved));
  const existing = existingId ? tabs.get(existingId) : null;
  if (existing) {
    activateTab(existing.id);
    focusWindow(existing.windowId);
    return { where: existingId === o.fromTabId ? "this-tab" : "other-tab", tabId: existing.id };
  }

  const w = windowRecordFor(o.fromWindowId);
  if (!w) return null;
  const target = tabs.get(o.fromTabId) || tabs.get(w.activeTabId);
  if (target && target.pristine && target.ready) {
    target.source = { kind: "file", absPath: resolved };
    indexTabSource(target);
    deliverOpenFile(target, resolved);
    activateTab(target.id);
    focusWindow(target.windowId);
    persistShellState();
    return { where: "this-tab", tabId: target.id };
  }

  const created = createTab(w.id, {
    source: { kind: "file", absPath: resolved },
    launchIntent: { type: "open-file" },
    pendingPayload: { kind: "open-file", absPath: resolved }
  });
  focusWindow(w.id);
  return created ? { where: "new-tab", tabId: created.id } : null;
}

function routeOpenServerDoc(serverDocId, c, opts) {
  const o = opts || {};
  if (typeof serverDocId !== "string" || !serverDocId) return null;
  const source = serverSource(serverDocId, c);

  const existingId = serverDocIdToTabId.get(serverRouteKey(source));
  const existing = existingId ? tabs.get(existingId) : null;
  if (existing) {
    activateTab(existing.id);
    focusWindow(existing.windowId);
    return { where: existingId === o.fromTabId ? "this-tab" : "other-tab", tabId: existing.id };
  }

  const w = windowRecordFor(o.fromWindowId);
  if (!w) return null;
  const target = tabs.get(o.fromTabId) || tabs.get(w.activeTabId);
  if (target && target.pristine && target.ready) {
    source.token = "";
    target.source = source;
    indexTabSource(target);
    if (!target.view.webContents.isDestroyed()) {
      target.view.webContents.send("splitpage:open-server-doc", payloadForSource(source));
    }
    activateTab(target.id);
    persistShellState();
    return { where: "this-tab", tabId: target.id };
  }

  const created = createTab(w.id, {
    source,
    launchIntent: { type: "open-server" },
    pendingPayload: payloadForSource(source)
  });
  return created ? { where: "new-tab", tabId: created.id } : null;
}

function reorderTab(tabId, index) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  const w = windowsById.get(tab.windowId);
  if (!w) return false;
  const from = w.tabIds.indexOf(tabId);
  if (from === -1) return false;
  w.tabIds.splice(from, 1);
  const to = Math.max(0, Math.min(from < index ? index - 1 : index, w.tabIds.length));
  w.tabIds.splice(to, 0, tabId);
  pushShellState(w.id);
  persistShellState();
  return true;
}

function moveTabToWindow(tabId, targetWindowId, index) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  const from = windowsById.get(tab.windowId);
  const to = windowsById.get(targetWindowId);
  if (!from || !to || from === to || to.win.isDestroyed()) return false;

  const i = from.tabIds.indexOf(tabId);
  if (i !== -1) from.tabIds.splice(i, 1);
  if (from.activeTabId === tabId) {
    from.activeTabId = from.tabIds.length ? from.tabIds[Math.max(0, Math.min(i, from.tabIds.length - 1))] : null;
  }

  try { from.win.contentView.removeChildView(tab.view); } catch { }
  to.win.contentView.addChildView(tab.view);

  tab.windowId = to.id;
  const at = typeof index === "number" ? Math.max(0, Math.min(index, to.tabIds.length)) : to.tabIds.length;
  to.tabIds.splice(at, 0, tabId);

  if (!from.tabIds.length && !from.win.isDestroyed()) {
    closeConfirmedWindows.add(from.win);
    from.win.close();
  } else {
    layoutWindow(from.id);
    applyWindowTitle(from);
    pushShellState(from.id);
  }
  activateTab(tabId);
  pushShellState(to.id);
  persistShellState();
  return true;
}

function tearOffToNewWindow(tabId, screenX, screenY) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  const from = windowsById.get(tab.windowId);
  if (!from) return false;
  if (from.tabIds.length <= 1) return false;
  const size = from.win.isDestroyed() ? { width: 1400, height: 900 } : from.win.getBounds();
  const created = createTabWindow({
    bounds: {
      x: Math.round(Number.isFinite(screenX) ? screenX : size.x),
      y: Math.round(Number.isFinite(screenY) ? screenY : size.y),
      width: size.width,
      height: size.height
    }
  });
  return moveTabToWindow(tabId, created.id, 0);
}

function liveWindows() {
  return [...windowsById.values()].filter((w) => w.win && !w.win.isDestroyed());
}

function goneFileTabsOf(tabIds) {
  const fileTabs = tabIds.map((id) => tabs.get(id)).filter(tabHasFile);
  return Promise.all(fileTabs.map(tabFileGone))
    .then((gone) => fileTabs.filter((tab, i) => gone[i] && tabs.get(tab.id) === tab));
}

function askAboutUnsaved(list, verb, parentWin) {
  if (!list.length) return "discard";
  const decision = buildUnsavedDialog(list, verb, parentWin);
  if (decision === "review") reviewFirstUnsaved(list);
  return decision;
}

function askBeforeClosing(tabIds, verb, parentOf, stillWanted) {
  return goneFileTabsOf(tabIds).then((gone) => {
    if (!stillWanted()) return "cancel";
    const unsaved = unsavedTabsOf(tabIds.filter((id) => tabs.has(id)), gone);
    const first = askAboutUnsaved(unsaved, verb, parentOf(unsaved));
    if (first !== "discard" || !gone.length) return first;
    return keepDraftsOfGoneFiles(gone).then((unkept) => {
      if (!stillWanted()) return "cancel";
      const missing = unkept.filter((tab) => tabs.get(tab.id) === tab);
      const again = askAboutUnsaved(missing, verb, parentOf(missing));
      if (again !== "discard") for (const tab of gone) tab.keepDraftOnClose = false;
      return again;
    });
  });
}

function unsavedTabsOf(tabIds, gone) {
  const out = [];
  for (const id of tabIds) {
    const tab = tabs.get(id);
    if (tabIsUnsaved(tab) || (tab && gone.includes(tab))) out.push(tab);
  }
  return out;
}

function allTabsInOrder() {
  const out = [];
  for (const w of windowsById.values()) for (const id of w.tabIds) if (tabs.has(id)) out.push(id);
  return out;
}

function unsavedTitles(list) {
  let listing = null;
  return list.map((tab) => {
    if (tab.title) return tab.title;
    if (!listing) listing = draftsList();
    const found = listing.find((d) => d.tabId === tab.id);
    return (found && found.title) || "Untitled";
  });
}

function buildUnsavedDialog(list, verb, parentWin) {
  const answer = consumeTestDialogAnswer();
  if (answer === "confirm") return "discard";
  if (answer === "cancel") return "cancel";
  if (answer === "review") return "review";

  if (list.length === 1) {
    const choice = dialog.showMessageBoxSync(parentWin, {
      type: "warning",
      buttons: ["Leave without saving", "Stay"],
      defaultId: 1,
      cancelId: 1,
      title: "Splitpage",
      message: "You have unsaved changes",
      detail: verb === "Close tab"
        ? "If you close this tab now, your changes will be lost."
        : "If you leave now, your changes will be lost."
    });
    return choice === 0 ? "discard" : "cancel";
  }

  const titles = unsavedTitles(list);
  const leaveLabel = verb === "Quit" ? "Quit without saving" : "Close without saving";
  const choice = dialog.showMessageBoxSync(parentWin, {
    type: "warning",
    buttons: ["Review", leaveLabel, "Cancel"],
    defaultId: 0,
    cancelId: 2,
    title: "Splitpage",
    message: `You have unsaved changes in ${list.length} documents`,
    detail: titles.map((t) => "• " + t).join("\n") + "\n\nIf you continue, these changes will be lost."
  });
  return choice === 0 ? "review" : choice === 1 ? "discard" : "cancel";
}

function reviewFirstUnsaved(list) {
  const first = list[0];
  if (!first || !tabs.has(first.id)) return;
  activateTab(first.id);
  focusWindow(first.windowId);
}

function askHostingPrompt(parentWin) {
  const answer = consumeTestDialogAnswer();
  if (answer === "confirm") return true;
  if (answer === "cancel") return false;
  return dialog.showMessageBoxSync(parentWin, {
    type: "warning",
    buttons: ["Stop sharing and close", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Splitpage",
    message: "Closing Splitpage stops the shared session — anyone connected loses access."
  }) === 0;
}

function settleDraftsForClose(tabIds, discardUnsaved, reason) {
  const unsaved = [];
  const clean = [];
  for (const id of tabIds) {
    const tab = tabs.get(id);
    if (!tab) continue;
    if (tab.crashedNotReloaded || tab.keepDraftOnClose) continue;
    if (tabIsUnsaved(tab)) unsaved.push(id); else clean.push(id);
  }
  if (discardUnsaved && unsaved.length) draftsDiscardForUserDecision(unsaved, reason);
  for (const id of clean) draftsDiscardClean(id);
}

function requestCloseTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const w = windowsById.get(tab.windowId);
  if (w && w.tabIds.length === 1) {
    if (!w.win.isDestroyed()) w.win.close();
    return;
  }
  if (tab.closeKeepingDraft) return;
  const parent = () => (w && !w.win.isDestroyed() ? w.win : undefined);
  const close = () => {
    settleDraftsForClose([tabId], true, "leave-without-saving");
    destroyTabView(tabId);
  };
  if (!tabHasFile(tab)) {
    if (askAboutUnsaved(unsavedTabsOf([tabId], []), "Close tab", parent()) === "discard") close();
    return;
  }
  tab.closeKeepingDraft = true;
  askBeforeClosing([tabId], "Close tab", parent, () => !quitKeepingDrafts && !quitConfirmed && !sessionEnding).then((answer) => {
    tab.closeKeepingDraft = false;
    if (answer === "discard" && tabs.get(tabId) === tab) close();
  });
}

function cycleTab(windowId, delta) {
  const w = windowsById.get(windowId);
  if (!w || w.tabIds.length < 2) return;
  const i = w.tabIds.indexOf(w.activeTabId);
  const next = w.tabIds[((i === -1 ? 0 : i) + delta + w.tabIds.length) % w.tabIds.length];
  activateTab(next);
}

function focusWindow(windowId) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return;
  lastFocusedWindowId = windowId;
  if (TEST_MODE) return;
  if (w.win.isMinimized()) w.win.restore();
  w.win.show();
  w.win.focus();
}

function payloadForSource(source) {
  if (!source) return null;
  if (source.kind === "file") return { kind: "open-file", absPath: source.absPath };
  if (source.kind === "server") {
    return { kind: "open-server", serverDocId: source.serverDocId, serverUrl: source.serverUrl || "" };
  }
  return null;
}

function flushPendingPayload(tab, opts) {
  const payload = tab.pendingPayload;
  if (!payload) return;
  if (!(opts && opts.force) && draftsHasDraft(tab.id)) return;
  tab.pendingPayload = null;
  if (payload.kind === "open-file") {
    deliverOpenFile(tab, payload.absPath);
  } else if (payload.kind === "open-server" && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.send("splitpage:open-server-doc", { serverDocId: payload.serverDocId });
  }
}

function draftSourceFromListing(listing) {
  const origin = (listing.header && listing.header.origin) || null;
  if (listing.filePath) return { kind: "file", absPath: listing.filePath };
  if (origin && origin.server && typeof origin.server.docId === "string" && origin.server.docId) {
    const base = typeof origin.server.base === "string" && origin.server.base
      ? origin.server.base.replace(/\/*$/, "/") : "";
    return normalizeTabSource({ kind: "server", serverDocId: origin.server.docId, serverUrl: base });
  }
  return { kind: "blank" };
}

function indexDraftPath(tabId, filePath) {
  if (typeof filePath !== "string" || !filePath || !path.isAbsolute(filePath)) return;
  claimRoutingKey(pathToTabId, pathKey(filePath), tabId);
}

function restoreSessionAtLaunch(draftInit) {
  const persisted = readDesktopStateV2();
  const drafts = (draftInit && Array.isArray(draftInit.drafts) ? draftInit.drafts : draftsList())
    .filter((d) => d && d.status !== "unsupported");
  const draftByTab = new Map(drafts.map((d) => [d.tabId, d]));
  hadPriorSession = persisted.windows.some((w) => w.tabs.some((t) => t.source.kind !== "blank"))
    || drafts.length > 0;

  const skipped = [];
  const placed = new Set();

  sessionRestoreInProgress = true;
  try {
    const built = [];
    for (const pw of persisted.windows) {
      const rec = createTabWindow({ windowId: pw.windowId, bounds: pw.bounds, maximized: pw.maximized });
      built.push({ rec, pw });
    }

    for (const { rec, pw } of built) {
      for (const pt of pw.tabs) {
        const listing = draftByTab.get(pt.tabId);

        if (listing) {
          const source = pt.source.kind === "blank" ? draftSourceFromListing(listing) : pt.source;
          const tab = createTab(rec.id, {
            tabId: pt.tabId,
            source,
            launchIntent: { type: "restore-draft" },
            pendingPayload: payloadForSource(source)
          });
          if (!tab) continue;
          if (draftStore) { try { draftStore.hold(tab.id); } catch { } }
          indexDraftPath(tab.id, listing.filePath);
          placed.add(tab.id);
          continue;
        }

        if (pt.source.kind === "file") {
          let exists = false;
          try { exists = fs.statSync(pt.source.absPath).isFile(); } catch { exists = false; }
          if (!exists) {
            skipped.push({ name: path.basename(pt.source.absPath), reason: "missing" });
            continue;
          }
          const tab = createTab(rec.id, {
            tabId: pt.tabId,
            source: pt.source,
            launchIntent: { type: "open-file" },
            pendingPayload: { kind: "open-file", absPath: pt.source.absPath }
          });
          if (tab) placed.add(tab.id);
          continue;
        }

        if (pt.source.kind === "server") {
          const tab = createTab(rec.id, {
            tabId: pt.tabId,
            source: pt.source,
            launchIntent: { type: "open-server" },
            pendingPayload: payloadForSource(pt.source)
          });
          if (tab) placed.add(tab.id);
          continue;
        }

      }
    }

    for (const listing of drafts) {
      if (placed.has(listing.tabId) || tabs.has(listing.tabId)) continue;
      const key = listing.placement && listing.placement.windowKey;
      const target = (typeof key === "string" && windowsById.get(key)) || firstWindowRecord();
      if (!target) continue;
      const index = listing.placement && Number.isInteger(listing.placement.index)
        ? listing.placement.index : undefined;
      const orphanSource = draftSourceFromListing(listing);
      const tab = createTab(target.id, {
        tabId: listing.tabId,
        source: orphanSource,
        launchIntent: { type: "restore-draft" },
        pendingPayload: payloadForSource(orphanSource),
        index
      });
      if (!tab) continue;
      if (draftStore) { try { draftStore.hold(tab.id); } catch { } }
      indexDraftPath(tab.id, listing.filePath);
      placed.add(tab.id);
    }

    if (!windowsById.size) createTabWindow({});
    const blankIdFor = new Map();
    for (const { rec, pw } of built) {
      const keep = pw.tabs.find((t) => t.tabId === pw.activeTabId && t.source.kind === "blank")
        || pw.tabs.find((t) => t.source.kind === "blank");
      if (keep && !tabs.has(keep.tabId)) blankIdFor.set(rec.id, keep.tabId);
    }
    for (const rec of liveWindows()) {
      if (rec.tabIds.length) continue;
      createTab(rec.id, {
        tabId: blankIdFor.get(rec.id),
        source: { kind: "blank" },
        launchIntent: { type: "blank" }
      });
    }

    for (const { rec, pw } of built) {
      if (!windowsById.has(rec.id) || !rec.tabIds.length) continue;
      activateTab(rec.tabIds.includes(pw.activeTabId) ? pw.activeTabId : rec.tabIds[0]);
    }
  } finally {
    sessionRestoreInProgress = false;
  }

  for (const f of argvFilesToOpen) routeLaunchFile(f);

  if (skipped.length) {
    const first = firstWindowRecord();
    if (first && first.activeTabId) pendingRestoreNotice = { tabId: first.activeTabId, skipped };
  }

  persistShellState();
}

function routeLaunchFile(absPath) {
  let resolved;
  try {
    if (!fs.statSync(absPath).isFile()) return;
    resolved = path.resolve(absPath);
  } catch { return; }

  const existingId = pathToTabId.get(pathKey(resolved));
  if (existingId && tabs.has(existingId)) {
    activateTab(existingId);
    return;
  }

  const w = firstWindowRecord();
  const target = w ? tabs.get(w.activeTabId) : null;
  if (target && target.source.kind === "blank" && !target.pendingPayload && !draftsHasDraft(target.id)) {
    target.source = { kind: "file", absPath: resolved };
    target.launchIntent = { type: "open-file" };
    target.pendingPayload = { kind: "open-file", absPath: resolved };
    indexTabSource(target);
    if (target.ready) flushPendingPayload(target);
    activateTab(target.id);
    return;
  }

  routeOpenPath(resolved, { fromWindowId: w ? w.id : null });
}

function activeTabContents() {
  const w = windowRecordFor(lastFocusedWindowId);
  if (!w) return null;
  const tab = tabs.get(w.activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  return tab.view.webContents;
}

function sendMenuCommand(command) {
  if (tunnelWindow && !tunnelWindow.isDestroyed()) {
    tunnelWindow.webContents.send("splitpage:menu-command", command);
    return;
  }
  const contents = activeTabContents();
  if (contents) contents.send("splitpage:menu-command", command);
}

function focusedWindowRecord() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    for (const w of windowsById.values()) if (w.win === focused) return w;
  }
  return windowRecordFor(lastFocusedWindowId);
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const exportSubmenu = [
    { label: "Word (.docx)", click: () => sendMenuCommand("export-docx") },
    { label: "Markdown (.md)", click: () => sendMenuCommand("export-md") },
    { label: "Markdown, two columns (.md)", click: () => sendMenuCommand("export-md-table") },
    { label: "Spreadsheet (.xlsx)", click: () => sendMenuCommand("export-xlsx") },
    { label: "Spreadsheet (.csv)", click: () => sendMenuCommand("export-csv") },
    { label: "Breakdown only (.xlsx)", click: () => sendMenuCommand("export-breakdown-xlsx") },
    { label: "Breakdown only (.csv)", click: () => sendMenuCommand("export-breakdown") },
    { label: "PDF (.pdf)", click: () => sendMenuCommand("export-pdf") },
    { type: "separator" },
    { label: "SplitShare (.html)", click: () => sendMenuCommand("export-html") },
    { type: "separator" },
    { label: "Narration only (.docx)", click: () => sendMenuCommand("export-narration-docx") },
    { label: "Narration only (.txt)", click: () => sendMenuCommand("export-narration-txt") },
    { type: "separator" },
    { label: "Gear (.pdf)", click: () => sendMenuCommand("export-packing-gear") },
    { label: "Props (.pdf)", click: () => sendMenuCommand("export-packing-prop") },
    { type: "separator" },
    { label: "B-roll shot list (.pdf)", click: () => sendMenuCommand("export-broll-pdf") },
    { label: "B-roll shot list (.xlsx)", click: () => sendMenuCommand("export-broll-xlsx") },
    { label: "B-roll shot list (.csv)", click: () => sendMenuCommand("export-broll-csv") }
  ];

  const fileMenu = {
    label: "File",
    submenu: [
      { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenuCommand("save") },
      { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenuCommand("save-as") },
      { label: "Save to file", id: "menu-save-back", click: () => sendMenuCommand("save-back") },
      { type: "separator" },
      { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => sendMenuCommand("open") },
      { label: "Paste a script…", click: () => sendMenuCommand("paste") },
      { label: "Import from Google Doc link…", click: () => sendMenuCommand("gdoc-import") },
      { label: "Google Drive files…", click: () => sendMenuCommand("drive-open") },
      { type: "separator" },
      { label: "Collaborate…", click: () => sendMenuCommand("collaborate") },
      { label: "Open from the server…", click: () => sendMenuCommand("server-open") },
      { label: "Put this script on the server", click: () => sendMenuCommand("server-publish") },
      { label: "Servers…", click: () => sendMenuCommand("servers") },
      { type: "separator" },
      { label: "Version history…", click: () => sendMenuCommand("history") },
      { type: "separator" },
      {
        label: "New Tab",
        accelerator: "CmdOrCtrl+T",
        click: () => {
          const w = focusedWindowRecord();
          if (w) createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
        }
      },
      { type: "separator" },
      { label: "Export…", accelerator: "CmdOrCtrl+E", registerAccelerator: false, click: () => sendMenuCommand("export") },
      { label: "Export", submenu: exportSubmenu },
      { type: "separator" },
      { label: "Settings…", click: () => sendMenuCommand("settings") },
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
      {
        label: "Find & replace",
        accelerator: "CmdOrCtrl+F",
        registerAccelerator: false,
        click: () => sendMenuCommand("find")
      },
      {
        label: "Search Commands…",
        accelerator: "CmdOrCtrl+K",
        registerAccelerator: false,
        click: () => sendMenuCommand("command-menu")
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
      {
        label: "Present in Browser (Follow My Voice)",
        accelerator: "CmdOrCtrl+Shift+P",
        click: () => sendMenuCommand("prompter-open-in-browser")
      },
      { label: "Use Chromium Speech Recognition", click: () => sendMenuCommand("prompter-open-in-chromium") },
      { type: "separator" },
      { label: "Hide shot scenes", accelerator: "CmdOrCtrl+Alt+H", click: () => sendMenuCommand("toggle-hide-shot") },
      { label: "Minimise the rundown", click: () => sendMenuCommand("toggle-rundown-min") },
      { type: "separator" },
      ...(app.isPackaged ? [] : [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" }
      ]),
      { label: "Actual Size", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: () => sendMenuCommand("script-zoom-reset") },
      { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", registerAccelerator: false, click: () => sendMenuCommand("script-zoom-in") },
      { label: "Zoom Out", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: () => sendMenuCommand("script-zoom-out") },
      { type: "separator" },
      { role: "togglefullscreen" }
    ]
  };

  const tabMenu = {
    label: "Tab",
    submenu: [
      {
        label: "Close Tab",
        accelerator: "CmdOrCtrl+W",
        click: () => {
          const w = focusedWindowRecord();
          if (w && w.activeTabId) requestCloseTab(w.activeTabId);
        }
      },
      { type: "separator" },
      {
        label: "Next Tab",
        accelerator: "Control+Tab",
        click: () => { const w = focusedWindowRecord(); if (w) cycleTab(w.id, 1); }
      },
      {
        label: "Previous Tab",
        accelerator: "Control+Shift+Tab",
        click: () => { const w = focusedWindowRecord(); if (w) cycleTab(w.id, -1); }
      }
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
    ? [{ role: "appMenu" }, fileMenu, editMenu, viewMenu, tabMenu, helpMenu]
    : [fileMenu, editMenu, viewMenu, tabMenu, helpMenu];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function senderOriginOf(event) {
  const url = event.senderFrame && event.senderFrame.url;
  if (typeof url !== "string") return null;
  if (url.startsWith(APP_ORIGIN + "/")) return APP_ORIGIN;
  if (url.startsWith(TABSTRIP_ORIGIN + "/")) return TABSTRIP_ORIGIN;
  return null;
}

function isTrustedSender(event) {
  return senderOriginOf(event) === APP_ORIGIN;
}

function isTrustedTabStripSender(event) {
  if (senderOriginOf(event) !== TABSTRIP_ORIGIN) return false;
  for (const w of windowsById.values()) {
    if (!w.win.isDestroyed() && w.win.webContents === event.sender) return true;
  }
  return false;
}

function ipcRefusalReason(channel, event, args) {
  if (!channel) return "unknown channel";
  const origin = senderOriginOf(event);
  if (!origin || !channel.allowedOrigins.includes(origin)) return "untrusted sender";
  const trusted = origin === APP_ORIGIN ? isTrustedSender(event) : isTrustedTabStripSender(event);
  if (!trusted) return "untrusted sender";
  const bad = checkArgs(channel.argsSchema, args);
  return bad ? channel.name + ": " + bad : null;
}

function logIpcRefusal(name, reason) {
  if (TEST_MODE) console.error("[splitpage-test] ipc refused " + name + ": " + reason);
}

function ipcChannelRow(name, direction) {
  const channel = channelFor(name, direction);
  if (!channel) throw new Error(`ipc: ${name} (${direction}) is not in desktop/ipc-channels.js`);
  return channel;
}

function ipcHandle(name, fn) {
  const channel = ipcChannelRow(name, "invoke");
  ipcMain.handle(name, (event, ...args) => {
    const reason = ipcRefusalReason(channel, event, args);
    if (reason) { logIpcRefusal(name, reason); throw new Error(reason); }
    return fn(event, ...args);
  });
}

function ipcOn(name, fn) {
  const channel = ipcChannelRow(name, "send");
  ipcMain.on(name, (event, ...args) => {
    const reason = ipcRefusalReason(channel, event, args);
    if (reason) { logIpcRefusal(name, reason); return; }
    fn(event, ...args);
  });
}

function ipcOnSync(name, fn) {
  const channel = ipcChannelRow(name, "sendSync");
  ipcMain.on(name, (event, ...args) => {
    const reason = ipcRefusalReason(channel, event, args);
    if (reason) { logIpcRefusal(name, reason); event.returnValue = channel.refusal; return; }
    try {
      event.returnValue = fn(event, ...args);
    } catch (err) {
      logIpcRefusal(name, (err && err.message) || "handler failed");
      event.returnValue = channel.refusal;
    }
  });
}

function tabStripWindowOf(event) {
  for (const w of windowsById.values()) {
    if (!w.win.isDestroyed() && w.win.webContents === event.sender) return w;
  }
  return null;
}

function tabOf(event) {
  const tabId = webContentsIdToTabId.get(event.sender.id);
  return tabId ? tabs.get(tabId) || null : null;
}

function dialogParentFor(event) {
  const tab = tabOf(event);
  if (tab) {
    const w = windowsById.get(tab.windowId);
    if (w && !w.win.isDestroyed()) return w.win;
  }
  return BrowserWindow.fromWebContents(event.sender) || undefined;
}

function launchIntentFor(tab) {
  if (draftsHasDraft(tab.id)) return { type: "restore-draft" };
  if (tab.source.kind === "file" && tab.pendingPayload) return { type: "open-file" };
  if (tab.source.kind === "server") return { type: "open-server" };
  return { type: "blank" };
}

function registerIpc() {
  ipcOnSync("splitpage:ipc-table-sync", (event) => channelsForOrigin(senderOriginOf(event)));

  ipcHandle("splitpage:open-file-dialog", async (event) => {
    const answer = consumeTestDialogAnswer();
    let chosen;
    if (answer !== undefined) {
      chosen = answer;
    } else {
      const win = dialogParentFor(event);
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

  ipcHandle("splitpage:save-file-dialog", async (event, options) => {
    const opts = options || {};
    const answer = consumeTestDialogAnswer();
    let chosen;
    if (answer !== undefined) {
      chosen = answer;
    } else {
      const win = dialogParentFor(event);
      const result = await dialog.showSaveDialog(win, {
        defaultPath: opts.suggestedName,
        filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : undefined
      });
      chosen = result.canceled || !result.filePath ? null : result.filePath;
    }
    if (!chosen) return null;
    const holderId = pathToTabId.get(pathKey(path.resolve(chosen)));
    const holder = holderId ? tabs.get(holderId) : null;
    const me = tabOf(event);
    if (holder && (!me || holder.id !== me.id)) {
      try {
        dialog.showMessageBoxSync(dialogParentFor(event), {
          type: "warning",
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
          message: `${path.basename(chosen)} is already open in another tab.`,
          detail: "Saving over it from here would leave two tabs editing one file, " +
            "and each save would overwrite the other. Close that tab first, or save this " +
            "document under a different name."
        });
      } catch { }
      return null;
    }
    const id = registerPath(chosen);
    return { id, name: path.basename(chosen) };
  });

  ipcHandle("splitpage:read-file", async (event, id) => {
    const absPath = fileRegistry.get(id);
    if (!absPath) throw new Error("ENOENT: unknown file id");
    return await readFileEntry(id, absPath);
  });

  ipcHandle("splitpage:write-file", async (event, id, data) => {
    const absPath = fileRegistry.get(id);
    if (!absPath) throw new Error("ENOENT: unknown file id");
    const buffer = toBuffer(data);
    await atomicWrite(absPath, buffer);
    const stat = await fsp.stat(absPath);
    return { lastModified: Math.floor(stat.mtimeMs), size: stat.size };
  });

  ipcHandle("splitpage:stat-file", async (event, id) => {
    const absPath = fileRegistry.get(id);
    if (!absPath) throw new Error("ENOENT: unknown file id");
    try {
      const stat = await fsp.stat(absPath);
      return { lastModified: Math.floor(stat.mtimeMs), size: stat.size };
    } catch {
      return null;
    }
  });

  ipcHandle("splitpage:recents-list", async () => {
    return recentsForRenderer();
  });

  ipcHandle("splitpage:recents-remove", async (event, fileId) => {
    if (removeRecentDocumentByFileId(fileId)) await persistRecents();
    return recentsForRenderer();
  });

  ipcHandle("splitpage:recents-clear", async () => {
    if (recentDocuments.length) {
      recentDocuments = [];
      await persistRecents();
    }
    return recentsForRenderer();
  });

  ipcHandle("splitpage:get-session-info", async () => {
    return {
      library: LIBRARY,
      hosting: HOSTING,
      port: documentServerPort,
      lanUrls: HOSTING && documentServerPort
        ? lanAddresses().map((addr) => `http://${addr}:${documentServerPort}/`)
        : [],
      pin: JOIN_PIN || "",
      reviewPin: REVIEW_PIN || "",
      reviewUrls: HOSTING && documentServerPort && REVIEW_KEY
        ? lanAddresses().map((addr) => `http://${addr}:${documentServerPort}/#review=${REVIEW_KEY}`)
        : [],
      testDialogsSeen: TEST_MODE ? testDialogsSeen : undefined
    };
  });

  ipcOnSync("splitpage:get-app-version-sync", () => app.getVersion());

  ipcOnSync("splitpage:tab-boot-sync", (event) => {
    const tab = tabOf(event);
    if (!tab) return null;
    const intent = launchIntentFor(tab);
    tab.launchIntent = intent;
    const hasDraftToRestore = intent.type === "restore-draft";
    if (draftStore) {
      if (hasDraftToRestore) {
        try { draftStore.hold(tab.id); } catch { }
      } else if (draftsIsHeld(tab.id)) {
        try { draftStore.release(tab.id); } catch { }
      }
    }
    const connection = tab.source.kind === "server"
      ? { serverUrl: tab.source.serverUrl || "", token: tab.source.token || "", tunnel: tab.source.tunnel || null }
      : null;
    if (tab.source.kind === "server") tab.source.token = "";
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      launchIntent: intent,
      connection,
      hadPriorSession,
      firstTabOfLaunch: tab.firstTabOfLaunch === true,
      hasDraftToRestore
    };
  });

  ipcOn("splitpage:open-external", (event, url) => {
    if (typeof url === "string" && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });

  ipcOn("splitpage:set-theme", (event, mode) => {
    if (mode !== "system" && mode !== "light" && mode !== "dark") return;
    if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
    writeThemeChoice(mode);
  });

  ipcHandle("splitpage:video-file-grant", async (event, filePath) => {
    if (!path.isAbsolute(filePath) || !VIDEO_FILE_EXT.test(filePath)) return null;
    let st;
    try { st = await fsp.stat(filePath); } catch { return null; }
    if (!st.isFile()) return null;
    for (const [token, granted] of videoFileGrants) if (granted === filePath) return token;
    if (videoFileGrants.size >= 1000) videoFileGrants.delete(videoFileGrants.keys().next().value);
    const token = crypto.randomBytes(16).toString("hex");
    videoFileGrants.set(token, filePath);
    return token;
  });

  ipcHandle("splitpage:video-file-open", async (event, token) => {
    const filePath = videoFileGrants.get(token);
    if (!filePath) return { ok: false, code: "UNKNOWN" };
    try {
      if (!(await fsp.stat(filePath)).isFile()) return { ok: false, code: "GONE" };
    } catch { return { ok: false, code: "GONE" }; }
    if (TEST_MODE) { testVideoOpens.push(filePath); return { ok: true }; }
    const failed = await shell.openPath(filePath);
    return failed ? { ok: false, code: "OPEN_FAILED" } : { ok: true };
  });

  ipcHandle("splitpage:video-thumbnail", async (event, host, ref) => videoThumbnail(host, ref));

  ipcHandle("splitpage:update-status", async () => {
    return updateStatus;
  });

  ipcHandle("splitpage:update-check", async () => {
    if (SKIP_UPDATE_CHECK) return updateStatus;
    setUpdateStatus({ checking: true });
    await checkForUpdate();
    return updateStatus;
  });

  ipcHandle("splitpage:update-download", async () => {
    return downloadUpdate();
  });

  ipcHandle("splitpage:update-install", async () => {
    return runUpdateInstaller();
  });

  ipcHandle("splitpage:prompter-open-in-browser", async (event) => {
    return openPrompterInBrowser(tabOf(event));
  });
  ipcHandle("splitpage:prompter-open-in-chromium", async (event) => {
    return openPrompterInBrowser(tabOf(event), { chromium: true });
  });

  ipcHandle("splitpage:voice-status", async () => {
    return { available: voiceHelperInstance().available() };
  });
  ipcHandle("splitpage:voice-start", async (event) => {
    const tab = tabOf(event);
    if (!tab) return { ok: false, code: "NO_TAB" };
    return voiceHelperInstance().start(tab.id);
  });
  ipcHandle("splitpage:voice-stop", async (event) => {
    const tab = tabOf(event);
    if (!tab) return { ok: true };
    return voiceHelperInstance().stop(tab.id);
  });

  ipcHandle("splitpage:drive-status", async (event) => {
    if (!tabOf(event)) return { ok: false, code: "NO_TAB" };
    return Object.assign({ ok: true }, googleDriveInstance().status());
  });

  ipcHandle("splitpage:drive-sign-in", async (event) => {
    if (!tabOf(event)) return { ok: false, code: "NO_TAB" };
    const result = await googleDriveInstance().signIn();
    if (result && result.ok && !TEST_MODE) {
      const win = dialogParentFor(event);
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    }
    return result;
  });

  ipcHandle("splitpage:drive-sign-out", async (event) => {
    if (!tabOf(event)) return { ok: false, code: "NO_TAB" };
    return googleDriveInstance().signOut();
  });

  ipcHandle("splitpage:drive-list", async (event, folderId) => {
    if (!tabOf(event)) return { ok: false, code: "NO_TAB" };
    return googleDriveInstance().listFolder(folderId);
  });

  ipcHandle("splitpage:drive-download", async (event, fileId) => {
    if (!tabOf(event)) return { ok: false, code: "NO_TAB" };
    return googleDriveInstance().download(fileId);
  });

  ipcHandle("splitpage:drive-upload", async (event, request) => {
    if (!tabOf(event)) return { ok: false, code: "NO_TAB" };
    return googleDriveInstance().upload(request);
  });

  ipcOn("splitpage:set-document-state", (event, docState) => {
    const tab = tabOf(event);
    if (!tab) return;
    const s = docState || {};

    tab.title = typeof s.title === "string" && s.title ? s.title.slice(0, LAST_KNOWN_TITLE_MAX) : "Untitled";
    tab.dirty = !!s.dirty;
    if ("pristine" in s) tab.pristine = !!s.pristine;
    if ("docId" in s) tab.docId = typeof s.docId === "string" ? s.docId : null;

    const hasFileId = "fileId" in s;
    const hasServerKey = "serverKey" in s;
    const absPath = hasFileId && typeof s.fileId === "string" ? fileRegistry.get(s.fileId) || null : null;
    if (hasServerKey) tab.serverKey = typeof s.serverKey === "string" && s.serverKey ? s.serverKey : null;
    if (hasFileId) tab.fileId = absPath ? s.fileId : null;
    if (hasFileId || hasServerKey) {
      const prev = tab.source.kind === "server" ? tab.source : null;
      unindexTabSource(tab);
      if (tab.serverKey) {
        const reported = "serverUrl" in s ? normalizeServerUrl(s.serverUrl) : null;
        const kept = prev && prev.serverDocId === tab.serverKey ? prev.serverUrl : "";
        const serverUrl = reported === null ? kept : reported;
        const sameServer = !!prev && prev.serverUrl === serverUrl;
        tab.source = serverSource(tab.serverKey, {
          serverUrl,
          tunnel: "tunnel" in s ? s.tunnel : (sameServer ? prev.tunnel : null),
          token: sameServer ? prev.token : "",
          role: "role" in s ? s.role : (sameServer ? prev.role : "")
        });
      }
      else if (absPath) tab.source = { kind: "file", absPath };
      else if (hasFileId && hasServerKey) tab.source = { kind: "blank" };
      indexTabSource(tab);
    }

    if (tab.source.kind === "file") noteRecentDocument(tab.source.absPath, tab.title);

    const w = windowsById.get(tab.windowId);
    if (w) {
      if (w.activeTabId === tab.id) applyWindowTitle(w);
      pushShellState(w.id);
    }
    persistShellState();
    try { recordDocClaim(event.sender, tab); }
    catch (err) { if (TEST_MODE) console.error("[splitpage-test] doc claim failed", err); }
  });

  ipcOn("splitpage:renderer-ready", (event) => {
    const tab = tabOf(event);
    if (!tab) return;
    tab.ready = true;
    flushPendingPayload(tab);
    if (pendingRestoreNotice && pendingRestoreNotice.tabId === tab.id) deliverRestoreNotice(tab);
  });

  ipcHandle("splitpage:route-open", async (event, payload) => {
    const tab = tabOf(event);
    if (!tab) throw new Error("unknown tab");
    const p = payload || {};
    if (p.kind === "file") {
      const absPath = fileRegistry.get(p.fileId);
      if (!absPath) throw new Error("ENOENT: unknown file id");
      const result = routeOpenPath(absPath, { fromWindowId: tab.windowId, fromTabId: tab.id });
      if (!result) throw new Error("ENOENT: file is not readable");
      return { where: result.where };
    }
    if (p.kind === "server") {
      const serverUrl = normalizeServerUrl(p.serverUrl);
      if (serverUrl === null) throw new Error("route-open: not a server address");
      const c = { serverUrl, token: p.token, tunnel: p.tunnel };
      const result = routeOpenServerDoc(String(p.serverDocId || ""), c, { fromWindowId: tab.windowId, fromTabId: tab.id });
      if (!result) throw new Error("could not route that server document");
      return { where: result.where };
    }
    throw new Error("route-open: unknown kind");
  });

  const DRAFT_STORE_DOWN = { ok: false, code: "EIO" };

  ipcHandle("splitpage:draft-write", async (event, payload) => {
    const tab = tabOf(event);
    if (!tab) return { ok: false, code: "NO_TAB" };
    if (!draftStore) return DRAFT_STORE_DOWN;
    const p = payload && typeof payload === "object" ? payload : {};
    const seq = draftFiniteNumber(p.seq);
    const baseJson = p.baseJson === undefined || p.baseJson === null ? null : p.baseJson;
    if (seq === null || typeof p.stateJson !== "string" || (baseJson !== null && typeof baseJson !== "string")) {
      return { ok: false, code: "BAD_PAYLOAD" };
    }
    if (draftBodyTooLarge(p.stateJson) || (baseJson !== null && draftBodyTooLarge(baseJson))) {
      return { ok: false, code: "TOO_LARGE" };
    }
    return await draftStore.write(tab.id, buildDraftHeader(tab, p), p.stateJson, baseJson, seq);
  });

  ipcHandle("splitpage:draft-discard", async (event, payload) => {
    const tab = tabOf(event);
    if (!tab) return { ok: false, code: "NO_TAB" };
    if (!draftStore) return DRAFT_STORE_DOWN;
    const seq = draftFiniteNumber(payload && payload.seq);
    if (seq === null) return { ok: false, code: "BAD_PAYLOAD" };
    if (tab.keepDraftOnClose) return { ok: false, code: "HELD" };
    return await draftStore.discardClean(tab.id, seq);
  });

  ipcHandle("splitpage:draft-take", async (event) => {
    const tab = tabOf(event);
    if (!tab || !draftStore) return null;
    const taken = await draftStore.take(tab.id);
    if (!taken || taken.corrupt || taken.unsupported) return taken || null;

    const origin = (taken.header && taken.header.origin) || null;
    const filePath = origin && origin.kind === "file" && typeof origin.filePath === "string" ? origin.filePath : "";
    taken.file = null;
    taken.fileProblem = null;
    if (filePath) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
          taken.fileProblem = "unreadable";
        } else {
          const id = registerPath(filePath);
          taken.file = await readFileEntry(id, filePath);
          unindexTabSource(tab);
          tab.fileId = id;
          tab.source = { kind: "file", absPath: filePath };
          indexTabSource(tab);
          persistShellState();
        }
      } catch (err) {
        taken.fileProblem = err && err.code === "ENOENT" ? "missing" : "unreadable";
      }
    }
    if (typeof taken.previousSession !== "string") taken.previousSession = draftsPreviousSession;
    if (!("ageMs" in taken)) taken.ageMs = null;
    return taken;
  });

  ipcOn("splitpage:draft-restore-done", (event, payload) => {
    const tab = tabOf(event);
    if (!tab || !draftStore) return;
    const outcome = payload && typeof payload.outcome === "string" ? payload.outcome : "";
    if (outcome === "failed") {
      flushPendingPayload(tab, { force: true });
      return;
    }
    try { draftStore.release(tab.id); } catch { }
    tab.pendingPayload = null;
  });

  ipcOn("splitpage:draft-flushed", (event, reqId, result) => {
    const resolve = pendingDraftFlushes.get(reqId);
    if (!resolve) return;
    pendingDraftFlushes.delete(reqId);
    resolve(result && typeof result === "object" ? result : { ok: false });
  });

  const historyDocIdArg = (v) => {
    if (typeof v !== "string" || !DOC_ID_RE.test(v)) throw new Error("history: invalid document id");
    return v;
  };

  ipcHandle("splitpage:history-put", async (event, docId, meta, stateJson, opts) => {
    const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
    const older = o.older === true;
    if (older) {
      if (docId !== null) throw new Error("history: an Older put names no document");
    } else {
      historyDocIdArg(docId);
    }
    const clean = sanitizeHistoryMeta(meta);
    if (!clean) throw new Error("history: invalid snapshot meta");
    if (typeof stateJson !== "string") throw new Error("history: invalid snapshot body");
    const held = historyProtectList(o.protect);
    historyHolds.set(event.sender.id, held);
    const r = older
      ? await historyStore.put(null, clean, stateJson, { protect: held, older: true })
      : await historyStore.put(docId, clean, stateJson, { protect: held });
    if (r.stored) {
      return {
        ok: true,
        sizeBytes: historyUtf8Length(stateJson),
        duplicate: !!r.duplicate,
        evicted: Number(r.evicted) || 0,
        overCap: !!r.overCap
      };
    }
    const out = { ok: false, code: typeof r.code === "string" ? r.code : "io" };
    if (r.evicted) out.evicted = r.evicted;
    return out;
  });

  ipcHandle("splitpage:history-list", async (event, docId) => {
    const id = docId == null ? null : historyDocIdArg(docId);
    const r = await historyStore.list(id);
    const usage = await historyStore.usage().catch(() => null);
    return {
      entries: r.entries.map(historyWireMeta),
      older: r.older.map(historyWireMeta),
      olderExpiresAt: r.olderExpiresAt,
      usage
    };
  });

  ipcHandle("splitpage:history-get", async (event, query, snapshotId) => {
    const q = query || {};
    const bucket = q.older === true ? HISTORY_OLDER_KEY : historyDocIdArg(q.docId);
    if (typeof snapshotId !== "string" || !HISTORY_SNAP_ID_RE.test(snapshotId)) {
      throw new Error("history: invalid snapshot id");
    }
    if (Array.isArray(q.protect)) historyHolds.set(event.sender.id, historyProtectList(q.protect));
    const r = await historyStore.get(bucket, snapshotId);
    return r ? { meta: historyWireMeta(r.meta), stateJson: r.stateJson } : null;
  });

  ipcHandle("splitpage:history-copy", async (event, fromDocId, toDocId) => {
    historyDocIdArg(fromDocId);
    historyDocIdArg(toDocId);
    if (fromDocId === toDocId) return { ok: true, copied: 0 };
    return historyStore.copy(fromDocId, toDocId);
  });

  ipcHandle("splitpage:history-touch", async (event, docId, title) => {
    historyDocIdArg(docId);
    await historyStore.touch(docId, title);
  });

  ipcHandle("splitpage:history-list-docs", async () => {
    return historyStore.listDocs();
  });

  ipcHandle("splitpage:blob-put", async (event, sha, bytes) => {
    if (typeof bytes === "string") return { ok: false, code: "BAD_BYTES" };
    let buf;
    try { buf = toBuffer(bytes); } catch { return { ok: false, code: "BAD_BYTES" }; }
    const refusal = imageBlobRefusal(buf);
    if (refusal) return { ok: false, code: refusal };
    if (!blobStore) return { ok: false, code: "UNAVAILABLE" };
    return blobStore.put(sha, buf);
  });

  ipcHandle("splitpage:blob-get", async (event, sha) => {
    if (!blobStore) return null;
    const buf = await blobStore.get(sha);
    if (!buf) return null;
    const mime = sniffImageMime(buf);
    return mime ? { bytes: buf, mime } : null;
  });

  ipcHandle("splitpage:blob-missing", async (event, shas) => {
    if (shas.length > MAX_MISSING_QUERY) throw new Error("blob-missing: at most " + MAX_MISSING_QUERY + " shas per call");
    if (!shas.every(isSha256)) throw new Error("blob-missing: every entry must be a sha256");
    if (!blobStore) return [...new Set(shas)];
    return blobStore.missing(shas);
  });

  ipcOnSync("splitpage:tabstrip-window-id-sync", (event) => {
    const w = tabStripWindowOf(event);
    return w ? w.id : null;
  });

  ipcHandle("splitpage:tabstrip-get-state", async (event) => {
    const w = tabStripWindowOf(event);
    return w ? shellStateForWindow(w.id) : null;
  });

  const stripTab = (_event, tabId) => tabs.get(tabId) || null;

  ipcOn("splitpage:tabstrip-new-tab", (event) => {
    const w = tabStripWindowOf(event);
    if (w) createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
  });

  ipcOn("splitpage:tabstrip-activate", (event, tabId) => {
    const tab = stripTab(event, tabId);
    if (tab) activateTab(tab.id);
  });

  ipcOn("splitpage:tabstrip-close", (event, tabId) => {
    const tab = stripTab(event, tabId);
    if (tab) requestCloseTab(tab.id);
  });

  ipcOn("splitpage:tabstrip-reorder", (event, tabId, index) => {
    const tab = stripTab(event, tabId);
    if (tab && Number.isInteger(index)) reorderTab(tab.id, index);
  });

  ipcOn("splitpage:tabstrip-move-here", (event, tabId, dropIndex) => {
    const tab = stripTab(event, tabId);
    const w = tab ? tabStripWindowOf(event) : null;
    if (tab && w) moveTabToWindow(tab.id, w.id, Number.isInteger(dropIndex) ? dropIndex : undefined);
  });

  ipcOn("splitpage:tabstrip-tear-off", (event, tabId, screenX, screenY) => {
    const tab = stripTab(event, tabId);
    if (tab) tearOffToNewWindow(tab.id, Number(screenX), Number(screenY));
  });

  ipcOnSync("splitpage:is-test-mode-sync", () => TEST_MODE);

  if (TEST_MODE) {
    ipcOn("splitpage:test-request-close", (event) => {
      const tab = tabOf(event);
      const w = tab ? windowsById.get(tab.windowId) : null;
      const win = w ? w.win : BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.close();
    });

    ipcOn("splitpage:test-request-close-tab", (event) => {
      const tab = tabOf(event);
      if (tab) requestCloseTab(tab.id);
    });

    ipcOn("splitpage:test-request-quit", () => {
      app.quit();
    });

    ipcHandle("splitpage:test-draft-status", async (event, tabId) => {
      const named = typeof tabId === "string" && TAB_OR_WINDOW_ID_RE.test(tabId) ? tabs.get(tabId) : null;
      const tab = named || tabOf(event);
      const id = tab ? tab.id : null;
      if (draftStore && id) {
        try { return draftStore.status(id); } catch { }
      }
      return {
        tabId: id, hasDraft: false, held: false, lastSeq: null, tombstoned: false,
        previousSession: draftsPreviousSession, writes: 0, failures: 0
      };
    });

    ipcOn("splitpage:test-crash-renderer", (event) => {
      event.sender.forcefullyCrashRenderer();
    });

    ipcHandle("splitpage:test-dup-loser", async (event, a, b) => {
      const claim = (c) => ({
        docId: String((c && c.docId) || ""),
        homeKey: String((c && c.homeKey) || ""),
        seq: Number((c && c.seq) || 0)
      });
      const ca = claim(a), cb = claim(b);
      const loser = chooseDuplicateLoser(ca, cb);
      return loser === ca ? "a" : loser === cb ? "b" : null;
    });

    ipcHandle("splitpage:test-shell", async (event, op, args) => {
      const caller = tabOf(event);
      const a = args || {};
      const listTargets = () => ({
        windows: [...windowsById.values()].map((w) => ({
          windowId: w.id,
          activeTabId: w.activeTabId,
          tabs: w.tabIds.map((id) => {
            const t = tabs.get(id);
            return t ? {
              tabId: id,
              title: t.title || "",
              dirty: !!t.dirty,
              pristine: !!t.pristine,
              isServerDoc: t.source.kind === "server",
              path: t.source.kind === "file" ? t.source.absPath : null,
              serverDocId: t.source.kind === "server" ? t.source.serverDocId : null,
              serverUrl: t.source.kind === "server" ? t.source.serverUrl : null,
              tunnel: t.source.kind === "server" ? t.source.tunnel : null,
              hasToken: t.source.kind === "server" ? !!t.source.token : false,
              role: t.source.kind === "server" ? t.source.role : null
            } : null;
          }).filter(Boolean)
        }))
      });

      switch (op) {
        case "getShellState": {
          const w = caller ? windowsById.get(caller.windowId) : null;
          return w ? shellStateForWindow(w.id) : null;
        }
        case "createTab": {
          const w = (a.windowId && windowsById.get(a.windowId)) || (caller && windowsById.get(caller.windowId));
          if (!w) throw new Error("test-shell: no such window");
          const created = createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
          return created ? created.id : null;
        }
        case "activateTab":
          if (!tabs.has(a.tabId)) throw new Error("test-shell: no such tab");
          activateTab(a.tabId);
          return true;
        case "closeTab":
          if (!tabs.has(a.tabId)) throw new Error("test-shell: no such tab");
          requestCloseTab(a.tabId);
          return true;
        case "reorderTab":
          return reorderTab(a.tabId, a.index);
        case "moveTabToWindow": {
          const tab = tabs.get(a.tabId);
          if (!tab) throw new Error("test-shell: no such tab");
          if (a.windowId === null || a.windowId === undefined) {
            const created = createTabWindow({});
            return moveTabToWindow(tab.id, created.id, 0) ? created.id : null;
          }
          return moveTabToWindow(tab.id, a.windowId, a.index);
        }
        case "listTargets":
          return listTargets();
        case "sessionEnd":
          for (const w of liveWindows()) w.win.emit("session-end", { reasons: ["logoff"], preventDefault() {} });
          return true;
        case "externalOpens":
          return testExternalOpens.slice();
        case "chromiumLaunches":
          return testChromiumLaunches.slice();
        case "videoFileOpens":
          return testVideoOpens.slice();
        case "prompterShareStatus":
          return prompterShare ? prompterShare.status() : { listening: false, port: null, shares: [] };
        case "voiceStatus":
          return voiceHelperInstance().status();
        case "driveInfo": {
          let backend = null;
          try { if (process.platform === "linux") backend = safeStorage.getSelectedStorageBackend(); } catch { backend = null; }
          return {
            backend,
            encryptionAvailable: safeStorage.isEncryptionAvailable(),
            tokenEndpoint: googleDriveInstance().endpoints.token
          };
        }
        default:
          throw new Error("test-shell: unknown op " + op);
      }
    });
  }
}

app.on("second-instance", (_event, argv, cwd) => {
  const files = filesToOpenFrom(app.isPackaged ? argv.slice(1) : argv.slice(2), cwd);
  for (const f of files) routeOpenPath(f, { fromWindowId: lastFocusedWindowId });
  focusWindow(lastFocusedWindowId);
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    argvFilesToOpen.push(filePath);
    return;
  }
  routeOpenPath(filePath, { fromWindowId: lastFocusedWindowId });
  focusWindow(lastFocusedWindowId);
});

app.setAppUserModelId("com.retrogorilla.splitpage");

app.whenReady().then(async () => {
  nativeTheme.themeSource = readThemeChoice();
  sweepDesktopStateTempFiles();
  loadRecentsAtLaunch();
  const draftInit = initDraftStore();
  initBlobStore();
  initHistoryStore();
  registerProtocol();
  registerIpc();
  buildMenu();

  nativeTheme.on("updated", () => {
    const overlay = titleBarOverlayColors();
    for (const w of windowsById.values()) {
      if (w.win.isDestroyed()) continue;
      w.win.setBackgroundColor(backgroundColorForTheme());
      try { w.win.setTitleBarOverlay(overlay); } catch { }
    }
    for (const tab of tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.setBackgroundColor(backgroundColorForTheme());
    }
    if (tunnelWindow && !tunnelWindow.isDestroyed()) tunnelWindow.setBackgroundColor(backgroundColorForTheme());
  });

  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
  });

  const APP_PAGE_RE = /^splitpage:\/\/app(\/|$)/;
  const APP_PERMISSIONS = ["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"];
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = webContents.getURL();
    const asking = details && typeof details.requestingUrl === "string" ? details.requestingUrl
      : (details && details.isMainFrame === false ? "" : url);
    callback(APP_PAGE_RE.test(url) && APP_PAGE_RE.test(asking) && APP_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const url = webContents ? webContents.getURL() : "";
    const asking = (details && details.requestingUrl) || requestingOrigin || "";
    return APP_PAGE_RE.test(url) && APP_PAGE_RE.test(asking) && APP_PERMISSIONS.includes(permission);
  });
  installPlayerReferer(session.defaultSession);

  if (TUNNEL_TARGET) {
    const ok = await startTunnel();
    if (!ok) { app.quit(); return; }
  } else if (LIBRARY) {
    await startDocumentServer();
  }

  if (!SKIP_UPDATE_CHECK) checkForUpdate();

  if (TUNNEL_TARGET) {
    tunnelWindow = createTunnelWindow();
    return;
  }

  restoreSessionAtLaunch(draftInit);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const fresh = createTabWindow({});
      createTab(fresh.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
    }
  });
});

app.on("before-quit", (event) => {
  if (sessionEnding) return;
  if (quitConfirmed) return;
  if (quitKeepingDrafts) { event.preventDefault(); return; }

  if (HOSTING && !hostingConfirmed) {
    const w = windowsById.get(lastFocusedWindowId) || firstWindowRecord();
    if (!askHostingPrompt(w && !w.win.isDestroyed() ? w.win : undefined)) {
      event.preventDefault();
      return;
    }
  }

  const tabIds = allTabsInOrder();
  const parentOf = (list) => {
    const w = list.length ? windowsById.get(list[0].windowId) : null;
    return w && !w.win.isDestroyed() ? w.win : undefined;
  };
  const stayOpen = () => {
    quitConfirmed = false;
    hostingConfirmed = false;
    sessionWritesFrozen = false;
  };
  const confirmQuit = () => {
    settleDraftsForClose(tabIds, true, "quit-without-saving");
    if (HOSTING) hostingConfirmed = true;
    quitConfirmed = true;
    sessionWritesFrozen = true;
  };

  if (!tabIds.some((id) => tabHasFile(tabs.get(id)))) {
    const unsaved = unsavedTabsOf(tabIds, []);
    if (askAboutUnsaved(unsaved, "Quit", parentOf(unsaved)) !== "discard") {
      stayOpen();
      event.preventDefault();
      return;
    }
    confirmQuit();
    return;
  }

  event.preventDefault();
  quitKeepingDrafts = true;
  askBeforeClosing(tabIds, "Quit", parentOf, () => !sessionEnding).then((answer) => {
    quitKeepingDrafts = false;
    if (sessionEnding) return;
    if (answer !== "discard") { stayOpen(); return; }
    confirmQuit();
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  if (installOnQuit) {
    installOnQuit = false;
    const started = startInstallerNow();
    if (installQuitWatcher) {
      installQuitWatcher(started.ok ? { ok: true, quitting: true } : started);
      installQuitWatcher = null;
    }
  }
  killDocumentServer();
  killTunnel();
  if (prompterShare) prompterShare.closeAll();
  if (voiceHelper) voiceHelper.stopAll();
  if (googleDrive) googleDrive.shutdown();
  if (draftStore) { try { draftStore.markCleanExit(); } catch { } }
});

}
