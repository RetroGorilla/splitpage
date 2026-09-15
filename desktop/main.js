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
  app, BrowserWindow, WebContentsView, Menu, protocol, net, ipcMain, dialog, shell,
  utilityProcess, session, nativeTheme, screen
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const os = require("node:os");
const net_ = require("node:net");
const { spawn } = require("node:child_process");
/* desktop/drafts.js is plain Node with no Electron dependency: the crash-draft
   store (createDraftStore) and the durable writer desktop-state.json v2 uses.
   It is listed in electron-builder.yml's `files` so a packaged build ships it
   — requiring it without that would crash the packaged app on startup. */
const { createDraftStore, writeFileDurableSync, MAX_BODY_BYTES } = require("./drafts");

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
/* Every dialog this process WOULD have shown, whether or not a test
   pre-answered it. TEST_MODE-only field of getSessionInfo (testDialogsSeen)
   so smoke.mjs can wait for "the prompt was asked" instead of sleeping. */
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

/* SPLITPAGE_TEST=1 marks an automated run (desktop/test/smoke.mjs). Such a
   run must never put anything on the screen of the person whose machine it
   is: no window is ever shown and every one stays off the taskbar
   (createTabWindow / createTunnelWindow),
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

let documentServerChild = null;
let documentServerPort = null; // set once /api/health answers
let tunnelChild = null;
let tunnelLocalUrl = null; // set once the tunnel is up; load path bypasses the bridge entirely
let tunnelWindow = null; // --tunnel's single window; deliberately outside every tab registry

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

/* ---------------------------------------------------------------------
 * 4b. TAB IDENTITY — the main process is the sole authority on what is
 *     open (invariant #42).
 *
 *     Every document lives in its own page (a WebContentsView) rather than
 *     its own window, so one BrowserWindow can hold several. The window's
 *     OWN webContents is not a document at all: it is the tab strip, on the
 *     separate origin splitpage://tabstrip (invariant #43).
 *
 *     Identity lives here and nowhere else. A tabId is minted once, names
 *     the tab's draft folder, survives a tear-off (the VIEW moves between
 *     windows, it is never re-created) and survives a relaunch (v2 persists
 *     it). The renderer is told its own tabId at boot and can never choose
 *     or change one.
 * --------------------------------------------------------------------- */

/* Cross-referenced in desktop/tabstrip/tabstrip.css: the strip page is
   exactly this tall, and every document view starts exactly this far down.
   Changing one without the other clips the strip or leaves a gap. */
const TITLEBAR_H = 36;

/* DOC-ID-FORMAT. A document's own id — minted in the renderer, carried inside
   the document, and the same 33 characters everywhere (history's and drafts'
   looser patterns were dropped for it). Declared once here because more than
   one section needs it: section 8b builds a version-history folder name out
   of it, and the duplicate-claim authority keys a Map on it. Every docId
   reaching this process came out of a file someone else may have written, so
   nothing may use one before it matches this (invariant #38). */
const DOC_ID_RE = /^d[0-9a-f]{32}$/;

/* The crash-loop guard (DRAFT-IPC-AND-SHAPES): main reloads a tab whose
   renderer died at most twice per minute. A third crash inside the window
   leaves the tab down rather than restarting a page that evidently cannot
   survive its own content — its draft stays on disk for the next launch. */
const CRASH_RELOAD_MAX = 2;
const CRASH_RELOAD_WINDOW_MS = 60 * 1000;

const TABSTRIP_ROOT = app.isPackaged
  ? path.join(APP_ROOT, "tabstrip")
  : path.join(__dirname, "tabstrip");

/* Same construction as STATIC_ALLOWLIST: a fixed table, never a path built
   from the request, so traversal is impossible by construction. /api/* is
   deliberately absent — the strip gets no proxy to the document server. */
const TABSTRIP_ALLOWLIST = {
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/tabstrip.js": { file: "tabstrip.js", type: "text/javascript; charset=utf-8" },
  "/tabstrip.css": { file: "tabstrip.css", type: "text/css; charset=utf-8" }
};

/* tabId -> TabRecord {id, windowId, view, webContentsId, source, fileId,
   title, dirty, pristine, docId, serverKey, launchIntent, ready,
   pendingPayload, reloadTimes}. */
const tabs = new Map();

/* windowId -> WindowRecord {id, win, tabIds (strip order), activeTabId,
   lastFocusedAt, boundsSaveTimer, bounds, maximized}. Insertion order is
   window order, which is also the order v2 persists them in. */
const windowsById = new Map();

/* Indices. webContentsIdToTabId is how every IPC handler turns an untrusted
   sender into the tab it belongs to without the page ever naming itself.
   pathToTabId and serverDocIdToTabId answer "is this already open?", which
   is decided by absolute path or server document id and never by docId
   (invariant #36). */
const webContentsIdToTabId = new Map();
const pathToTabId = new Map();
const serverDocIdToTabId = new Map();

/* Case-insensitive on win32, where two spellings of one path are one file. */
function pathKey(absPath) {
  const resolved = path.resolve(absPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

let lastFocusedWindowId = null;
/* TAB-IDENTITY's shell flags, in one place. quitConfirmed/hostingConfirmed
   say a question has already been asked and answered for this quit;
   sessionWritesFrozen/sessionEnding say the session on disk is now final and
   must not be rewritten by the windows closing one after another. */
let quitConfirmed = false;
let hostingConfirmed = false;
let sessionWritesFrozen = false;
let sessionEnding = false;
let firstTabCreated = false;
/* Read once at launch, before anything is written back (TAB-BOOT-SYNC). */
let hadPriorSession = false;
/* True only while whenReady rebuilds last session's windows and tabs. */
let sessionRestoreInProgress = false;
/* Monotonic id for splitpage:draft-flush; the draft-flushed replies quote it
   back so a late reply cannot be mistaken for the current one. */
let draftFlushReqId = 0;
/* reqId -> resolve for the flush requests still outstanding. A reply that
   quotes an id nobody is waiting for (the page answered twice, or answered
   after its budget ran out) is dropped rather than resolving something else. */
const pendingDraftFlushes = new Map();
/* How long a flush request is waited on before main stops caring. A
   session-end (Windows signing the user out) is on a clock it does not
   control: whatever has not reached disk by then is not going to, and the
   previous draft generation is still there either way (invariant #40). */
const DRAFT_FLUSH_BUDGET_MS = 1500;
/* {tabId, skipped:[{name, reason}]} — the one splitpage:restore-notice this
   launch owes the active tab of the first window, held until its renderer
   says it is listening (a message sent before that is simply dropped). */
let pendingRestoreNotice = null;

/* Windows whose close has already been explicitly decided (a hosting/
   unsaved-changes dialog answered "go ahead", or neither applied) — so the
   beforeunload round trip that can follow doesn't ask the same question
   twice. A plain WeakSet is enough: nothing needs to read it once GC'd. */
const closeConfirmedWindows = new WeakSet();
/* The same, per tab view: a tab whose own close was already decided must not
   be asked about again by its view's will-prevent-unload round trip. */
const closeConfirmedTabViews = new WeakSet();

/* ---- duplicate document ids across tabs (DOC-CLAIMS) -----------------

   A document carries its own id (invariant #35) and that id is what version
   history and crash drafts are filed under. Copy a file in Explorer and open
   both copies and there are suddenly two different documents claiming one
   identity: every snapshot either takes would land in the other's history,
   and each would look to the other like a newer version of itself.

   Only the main process can see both, so only the main process decides. One
   claim table across every window and every tab, keyed by the page's
   webContents id (never by tabId, because the claim must die with the PAGE:
   a tab that reloads after a renderer crash re-reports from scratch). The
   renderer's own BroadcastChannel check (02b-doc-id.js) is deliberately
   disabled under DESKTOP — two authorities racing would re-id BOTH copies.

   What the loser is told to do is in DOC-CLAIMS and orchestrator override
   §1: it adopts a derived replacement id and copies its history across. It
   does NOT rewrite the user's file to record the new id — a file nobody
   touched must not be rewritten (and re-synced by OneDrive) just because a
   copy of it was detected. That is why the replacement is DERIVED rather
   than random: until the user's next save, the same pair of copies must get
   the same answer on every relaunch, or the copy's history would scatter
   across a new id each time. */
const docClaims = new Map();
/* Strictly increasing for the life of the process, never reset. A higher seq
   means "adopted this identity later", which is the tie-break of last resort
   in chooseDuplicateLoser: the tab that got there first keeps the id, and
   more importantly BOTH tabs compute the same verdict from the same pair. */
let docClaimSeq = 0;
/* webContents we have already registered a 'destroyed' cleanup on. The window
   'closed' handler cannot do this job: a tab view can close on its own, and a
   torn-off tab's view outlives the window it started in (overview: the claim
   follows the tab, so cleanup must hang off the view's own webContents). */
const docClaimCleanupRegistered = new WeakSet();

/* The home a claim is made against: WHERE this document lives. Two claims on
   one docId are only a duplicate when the homes differ — the same path open
   twice is the same document, and routing (pathToTabId) already prevents it.

   A server document's id is shared by design, so a server home is recorded
   but can never lose to another server home. A file home is the resolved
   absolute path, lowercased on win32 exactly as pathKey() does, because two
   spellings of one path there are one file. Paths are resolved HERE from the
   opaque fileId: the renderer never sends one (invariant #34). */
function homeKeyForClaim(tab) {
  if (tab.serverKey) return "server:" + String(tab.serverKey).slice(0, 200);
  const absPath = tab.fileId ? fileRegistry.get(tab.fileId) : null;
  if (absPath) return "file:" + pathKey(absPath);
  return null;
}

/* OFF, and measured rather than assumed. The idea was that on win32
   birthtime is a real creation time, so of two identical files the one that
   came into existence later is the copy — with a 2 s window so a copy made by
   the same operation as the original was not judged on noise.

   It does not survive contact with this filesystem. atomicWrite() saves by
   writing `.<name>.tmp-xxxx` next to the document and renaming it over the
   original, and NTFS here does NOT carry the destination's creation time
   across that rename (the "file tunnelling" behaviour the rule was counting
   on): measured on Windows 11, every save-in-place moved birthtimeMs forward
   by exactly the elapsed time (two saves 2.5 s apart moved it 2517 ms and
   2512 ms; a plain in-place fs.writeFileSync moved it not at all). So every
   save Splitpage makes re-dates the file.

   That is not merely useless, it inverts the answer: save the ORIGINAL after
   someone copied it and the original now looks younger than the copy, so the
   rule would name the original as the loser and re-id the document the user
   has been working in, leaving the untouched copy holding the id. The seq
   tie-break below — which tab adopted the identity first — is the honest
   answer, and it is symmetric for free.

   Left as one clearly commented branch rather than deleted (overrides §2):
   if a future measurement shows a filesystem that really does preserve it,
   this is a one-word change. desktop/test/smoke.mjs's
   caseAtomicSaveKeepsBirthtime re-measures on every run and fails if the two
   ever disagree. */
const DUP_TRUST_BIRTHTIME = false;
const DUP_BIRTHTIME_NOISE_MS = 2000;

/* Pure, and symmetric: run on either claim of a pair it must name the same
   loser, or both tabs would re-id (or neither). Returns the claim that has to
   give the id up, or null when the pair is not a duplicate at all. */
function chooseDuplicateLoser(a, b) {
  if (!a || !b || !a.docId || a.docId !== b.docId) return null;
  /* One home, one document. Nothing to split. */
  if (a.homeKey === b.homeKey) return null;
  const aServer = a.homeKey.startsWith("server:");
  const bServer = b.homeKey.startsWith("server:");
  /* Two server documents sharing an id are the SAME document opened twice
     (or two connections to it) — that is what a server id means. */
  if (aServer && bServer) return null;
  /* A server document against a local file: the server copy is the one other
     people are also editing, so the local file is the copy that gets re-id'd.
     (In practice this is a file saved down from a server document.) */
  if (aServer !== bServer) return aServer ? b : a;
  /* Two files. Birthtime is NOT consulted — see DUP_TRUST_BIRTHTIME. */
  if (DUP_TRUST_BIRTHTIME &&
      a.birthtimeMs > 0 && b.birthtimeMs > 0 &&
      Math.abs(a.birthtimeMs - b.birthtimeMs) > DUP_BIRTHTIME_NOISE_MS) {
    return a.birthtimeMs > b.birthtimeMs ? a : b;
  }
  /* Nothing to tell them apart on disk: the tab that adopted the identity
     later is the newcomer. */
  return a.seq > b.seq ? a : b;
}

/* The replacement identity, derived so it is stable across relaunches. This
   MUST stay byte-identical to the renderer's
   deriveDocId('splitpage-dup', fromId + '\n' + homeKey) — both are sha256
   over UTF-8 of 'splitpage-dup\n<fromId>\n<homeKey>', first 32 hex after a
   'd'. Invariant #37: changing either side re-identifies every copy that has
   not been saved since, and splits its history. */
function replacementDocId(fromId, homeKey) {
  const digest = crypto.createHash("sha256")
    .update("splitpage-dup\n" + fromId + "\n" + homeKey, "utf8")
    .digest("hex");
  return "d" + digest.slice(0, 32);
}

/* The live page behind a claim, or null. Deliberately resolved through the
   tab registry rather than webContents.fromId(): a claim may only ever
   address a webContents that is still a document tab of this process. */
function tabWebContentsForClaim(webContentsId) {
  const tabId = webContentsIdToTabId.get(webContentsId);
  const tab = tabId ? tabs.get(tabId) : null;
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  return tab.view.webContents;
}

/* Compare this sender's claim against every other claim holding the same id
   and tell the loser once. "Once" is tracked by pendingToId rather than a
   flag, so a claim that later changes id or home is asked again, and a
   renderer that ignored the message (it is allowed to: reassignDocId refuses
   on a server document, or if its id moved on meanwhile) is not nagged. */
function checkDuplicateDocId(senderId) {
  const mine = docClaims.get(senderId);
  if (!mine) return;
  /* NEVER JUDGE ON EVIDENCE THAT HAS NOT ARRIVED. A claim whose stat is
     still in flight reads as birthtimeMs 0 — so a rule that consults it
     could name DIFFERENT losers for the same pair before and after that stat
     lands, and both tabs would be told to re-id: both give up the shared id,
     both show the "this file is a copy" toast, and the history under the
     original id is copied to two derived ids and owned by neither. With
     DUP_TRUST_BIRTHTIME off the verdict no longer depends on the stat at
     all, so this is now insurance rather than the load-bearing guard — it
     stays because it is what makes turning that flag back on safe, and it
     costs one deferred check. A skipped pair is not forgotten: when the
     other claim's stat settles it runs this check for itself, with both
     sides evidenced, and pendingToId still keeps each loser told exactly
     once. */
  if (mine.statPending) return;
  for (const [otherId, theirs] of docClaims) {
    if (otherId === senderId || theirs.statPending) continue;
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
    } catch { /* the page went away between the check and the send */ }
  }
}

/* Called from splitpage:set-document-state, inside its own try/catch: a
   duplicate check is a courtesy, and must never cost the dirty/title update
   it rides along with (invariant #42 — the TabRecord is the authority every
   close decision reads). */
function recordDocClaim(sender, tab) {
  const webContentsId = sender.id;
  const docId = typeof tab.docId === "string" && DOC_ID_RE.test(tab.docId) ? tab.docId : null;
  const homeKey = docId ? homeKeyForClaim(tab) : null;
  /* No id, or nowhere to live (a new unsaved document, a document just
     closed): it cannot collide with anything, and a stale claim would keep
     re-iding whatever opens next. */
  if (!docId || !homeKey) {
    docClaims.delete(webContentsId);
    return;
  }
  const previous = docClaims.get(webContentsId);
  /* The overwhelmingly common report: same document, same place, the title
     or the dirty flag moved. Re-claiming would burn a seq on every keystroke
     and lose the birthtime we already paid a stat for. */
  if (previous && previous.docId === docId && previous.homeKey === homeKey) {
    previous.title = tab.title;
    return;
  }
  if (!docClaimCleanupRegistered.has(sender)) {
    docClaimCleanupRegistered.add(sender);
    sender.once("destroyed", () => { docClaims.delete(webContentsId); });
  }
  const absPath = tab.fileId ? fileRegistry.get(tab.fileId) : null;
  const claim = {
    docId,
    homeKey,
    seq: ++docClaimSeq,
    birthtimeMs: 0,
    title: tab.title,
    pendingToId: null,
    /* True from the moment a file home is claimed until its stat answers.
       checkDuplicateDocId refuses to judge a pair while either side is
       pending, so a verdict is only ever computed from two fully-evidenced
       claims (see its own comment). */
    statPending: !!absPath
  };
  docClaims.set(webContentsId, claim);

  if (!absPath) {
    checkDuplicateDocId(webContentsId);
    return;
  }
  /* A file home is still stat'ed for its creation time before the verdict,
     even though DUP_TRUST_BIRTHTIME is off and nothing reads the answer
     today: it is what a re-enabled rule would need, and recording it here is
     what lets that be a one-word change. The await is why every use of
     `claim` afterwards re-checks that it is still the current claim: the page
     can have reported three more times, or closed, while the disk answered. A
     stat that fails simply leaves birthtimeMs at 0. */
  fsp.stat(absPath).then(
    (stat) => {
      claim.statPending = false;
      if (docClaims.get(webContentsId) !== claim) return;
      claim.birthtimeMs = Number(stat.birthtimeMs) || 0;
      checkDuplicateDocId(webContentsId);
    },
    () => {
      /* The stat failed, so birthtimeMs stays 0 and the seq tie-break
         decides — but the evidence is IN, which is what pending means. */
      claim.statPending = false;
      if (docClaims.get(webContentsId) !== claim) return;
      checkDuplicateDocId(webContentsId);
    }
  );
}

/* The draft store (DRAFT-STORE). Every question about a tab's crash draft
   goes through one of these helpers, so a store that failed to initialise
   (an unwritable userData, say) degrades to "no tab has a draft" instead of
   throwing out of a close handler and leaving a window that cannot close. */
let draftStore = null;
/* From draftStore.init(): 'running' means the previous run was killed rather
   than exited, which is what makes its drafts crash work. Kept because
   init() answers it once and nothing else can ask again afterwards. */
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
/* An explicit user decision: Leave / Close / Quit without saving. Runs
   BEFORE any view is destroyed or the quit proceeds (CLOSE-QUIT-LIFECYCLE),
   because the tombstone it persists is what stops a late write from the
   dying page bringing the discarded work back at the next launch. */
function draftsDiscardForUserDecision(tabIds, reason) {
  if (!draftStore || !tabIds.length) return;
  try { draftStore.discardForUserDecision(tabIds, reason); }
  catch (err) {
    if (TEST_MODE) process.stderr.write(`[splitpage] draft discard failed: ${err && err.stack || err}\n`);
  }
}
/* A tab that closes with nothing unsaved has no crash work worth keeping.
   Infinity as the seq means "whatever the newest write was, this supersedes
   it": the tab is gone, so no later write of it can be legitimate. Refused
   while the tab is held, which is exactly right — a held tab is unsaved. */
function draftsDiscardClean(tabId) {
  if (!draftStore) return;
  try { Promise.resolve(draftStore.discardClean(tabId, Infinity)).catch(() => {}); } catch { /* store unusable */ }
}

/* TEST_MODE only (DRAFT-STORE testHooks). SPLITPAGE_TEST_DRAFT_FAIL is
   'CODE:count' ('ENOSPC:3'); KILL_BEFORE_RENAME is the 1-based write that
   dies with its temp file written but not yet renamed, which is how a smoke
   case reproduces a power cut in the middle of a draft write. onKill has to
   take the document server and the ssh tunnel with it — SIGKILL leaves no
   chance to run will-quit, so anything not killed here is orphaned. */
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

/* Called once from whenReady, BEFORE any window exists: a tab's boot sync
   asks hasDraft() the moment its page loads, and init() is also what turns
   last session's state ('running' = killed) into previousSession and
   finishes any discard whose delete did not complete. */
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
    /* Crash recovery is a safety net, not a precondition for running: a
       store that cannot be created must not stop the app from opening. */
    draftStore = null;
    if (TEST_MODE) process.stderr.write(`[splitpage] draft store unavailable: ${err && err.stack || err}\n`);
    return { previousSession: "none", drafts: [] };
  }
}

/* CLOSE-QUIT-LIFECYCLE's unsaved(tab): the page says it is dirty, OR it is
   holding crash work that has not been restored yet (invariant #42). A tab
   whose renderer is gone and was not reloaded is deliberately NOT unsaved —
   there is no page left to save from, and its draft is kept either way. */
function tabIsUnsaved(tab) {
  return !!(tab && !tab.crashedNotReloaded && (tab.dirty || draftsIsHeld(tab.id)));
}

/* ---- the draft header allowlist (invariants #29, #34, #41) -------------

   The renderer PROPOSES a draft; main decides what of it reaches disk. Every
   field of the DraftHeader is rebuilt here from a scalar this process has
   validated, and the two that could carry something dangerous are not taken
   from the payload at all:

   - filePath comes only from fileRegistry.get(fileId). The page holds opaque
     ids, never paths, so a compromised renderer cannot name a folder to have
     its "file name" recorded in — nor learn one back, since the header it
     proposed is never echoed to it (invariant #34).
   - placement comes from the TabRecord, which is main's own authority on
     which window a tab is in and where (invariant #42).

   Nothing in any draft code path reads serverToken, launchToken, JOIN_PIN or
   getSessionInfo: a header is a file that outlives the session, and a PIN or
   a token written into one would be exactly the leak invariant #29 exists to
   prevent. The allowlist below is the enforcement — an unknown field of the
   payload is not copied, so a future renderer cannot smuggle one in by
   adding it to what it sends. */

const DRAFT_ORIGIN_KINDS = new Set(["untitled", "file", "server", "import"]);
/* The three kinds docFileHandle.kind can hold (18-local-files.js:218/233/245,
   14-export.js:85). Anything else — including null for an untitled or
   imported document — is recorded as null. */
const DRAFT_FILE_KINDS = new Set(["md", "html", "splitpage"]);
/* A name the user can see, long enough for a real title and no longer
   (DRAFT-IPC-AND-SHAPES: title <= 300). Deliberately its own constant rather
   than LAST_KNOWN_TITLE_MAX, which is declared further down this file: a
   `const` read during module evaluation would be in its temporal dead zone
   here. The two bounds agree, and for the same reason. */
const DRAFT_NAME_MAX = 300;

/* A displayable scalar: a non-empty string with control characters removed.
   The newline matters beyond tidiness — the header is LINE ONE of the draft
   file and the state JSON is line two, so a newline inside a title would
   split the header itself and make the draft unreadable. */
function draftScalarString(v, max) {
  if (typeof v !== "string" || !v) return null;
  /* C0 controls and DEL: everything below U+0020 (newline included) plus
     U+007F. Written as \x escapes deliberately — a literal control character
     in this source would be invisible to anyone reading it. */
  const clean = v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
  return clean || null;
}

function draftFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* {base, docId, rev} for a server document, or null.

   `base` is rebuilt through the URL parser rather than string-trimmed:
   origin + pathname drops the query, the fragment (where the launch token
   travels) and any user:password userinfo, so a URL that carried a secret
   cannot put it on disk. Only http(s) survives at all. */
function draftServerOrigin(server) {
  if (!server || typeof server !== "object") return null;
  let base = null;
  try {
    const u = new URL(String(server.base == null ? "" : server.base));
    if (u.protocol === "http:" || u.protocol === "https:") base = u.origin + u.pathname;
  } catch { base = null; }
  const docId = draftScalarString(server.docId, DRAFT_NAME_MAX);
  const rev = draftFiniteNumber(server.rev);
  /* Neither an address nor a document id is nothing worth recording, and a
     half-built server origin would only confuse the restore. */
  if (!base && !docId) return null;
  return { base, docId, rev: rev === null ? 0 : rev };
}

/* DraftWritePayload -> DraftHeader, minus the fields desktop/drafts.js stamps
   itself (format, formatVersion, tabId, writtenAt, appVersion, seq, state,
   base — see doWrite). */
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
    /* Where this tab was when the draft was written, so a restore can put it
       back in the same window, in the same position (DRAFT-STORE's listing
       feeds restoreSessionAtLaunch). windowKey is the windowId of THIS run;
       it only has to be consistent within the session file it is compared
       against, which is why an orphan draft falls back to the first window. */
    placement: { windowKey: tab.windowId, index: index >= 0 ? index : 0, active: !!(w && w.activeTabId === tab.id) }
  };
}

/* The same cheap-then-exact test the store uses: a string's UTF-8 length is
   never below its UTF-16 length, so the free check rules out the giant cases
   before anything scans megabytes. Checked HERE as well as in the store so a
   body over the cap is refused before it is handed on at all. */
function draftBodyTooLarge(str) {
  if (str.length > MAX_BODY_BYTES) return true;
  return Buffer.byteLength(str, "utf8") > MAX_BODY_BYTES;
}

/* Asks one tab to write whatever it is holding, and resolves with its reply
   or with a refusal once the budget runs out. The reqId is what makes a late
   reply harmless: it is matched against the outstanding request, and a reply
   for a request that has already timed out finds nothing to resolve. */
function requestDraftFlush(tab, budgetMs) {
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
      tab.view.webContents.send("splitpage:draft-flush", reqId);
    } catch {
      pendingDraftFlushes.delete(reqId);
      clearTimeout(timer);
      resolve({ ok: false, code: "NO_TAB" });
    }
  });
}

/* ---------------------------------------------------------------------
 * 5. desktop-state.json (version 2) — windows, their bounds, and their tabs.
 *
 *    Shape (contract DESKTOP-STATE-V2):
 *      {version:2, windows:[{windowId, bounds:{x,y,width,height}|null,
 *        maximized, activeTabId, tabs:[{tabId, source, lastKnownTitle}]}]}
 *      source = {kind:'file', absPath} | {kind:'server', serverDocId} | {kind:'blank'}
 *    Array order is window order and strip order. There is deliberately no
 *    docId and no draftId: a document's id lives in the document, and a
 *    tab's draft folder is named by its tabId.
 *
 *    The app is still single-window here. Every existing caller reads or
 *    writes windows[0] and its first tab, and "the last file" is that tab's
 *    file source. The tab shell (step F1) is what starts using more than one.
 * --------------------------------------------------------------------- */

const DESKTOP_STATE_VERSION = 2;
const TAB_OR_WINDOW_ID_RE = /^[0-9a-f]{32}$/;
const LAST_KNOWN_TITLE_MAX = 300;

function stateFilePath() { return path.join(app.getPath("userData"), "desktop-state.json"); }

function mintTabOrWindowId() { return crypto.randomBytes(16).toString("hex"); }

/* WHY FSYNC. The old write was a plain writeFileSync that swallowed errors:
   a crash or power cut mid-write could leave a torn file, and v1 only lost a
   window position. v2 holds every window's tabs, so a torn file would lose
   the whole session. writeFileDurableSync (desktop/drafts.js, required at the
   top of this file) writes a temp file in the same folder, flushes it to
   disk, then renames it over the target — retrying the rename, because on
   Windows it fails transiently while a scanner or sync client holds the
   destination open. The file on disk is therefore always either the previous
   complete version or the new one. drafts.js owns the one copy of that
   sequence so session.json and desktop-state.json can never drift apart. */

/* WHY A STARTUP SWEEP. The catch above removes the temp file when a write
   fails, but not when the process dies between creating it and the rename
   (killed from Task Manager, power cut, OS crash). Nothing else looks in
   userData itself — drafts.js sweeps only its own drafts folder — so each such
   crash would leave one more orphan in %APPDATA%\Splitpage for good. Only the
   exact names this writer makes for desktop-state.json match; nothing else in
   userData is touched. It runs once from app.whenReady, which is after the
   single-instance lock is held (no other Splitpage process can be mid-write)
   and before the first readDesktopStateV2. Keep it when step F1 switches to
   drafts.writeFileDurableSync: that temp file lands next to
   desktop-state.json too. */
const DESKTOP_STATE_TMP_RE = /^\.tmp-[0-9a-f]{12}-desktop-state\.json$/;
function sweepDesktopStateTempFiles() {
  const dir = path.dirname(stateFilePath());
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; } // first launch: no folder yet
  let removed = 0;
  for (const name of names) {
    if (!DESKTOP_STATE_TMP_RE.test(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* locked by a scanner — next launch */ }
  }
  return removed;
}

function normalizeBounds(b) {
  if (!b || typeof b !== "object") return null;
  const ok = ["x", "y", "width", "height"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k]));
  return ok ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}

function normalizeTabSource(src) {
  if (src && typeof src === "object") {
    if (src.kind === "file" && typeof src.absPath === "string" && src.absPath && path.isAbsolute(src.absPath)) {
      return { kind: "file", absPath: src.absPath };
    }
    if (src.kind === "server" && typeof src.serverDocId === "string" && src.serverDocId) {
      return { kind: "server", serverDocId: src.serverDocId };
    }
  }
  return { kind: "blank" };
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
  return { version: DESKTOP_STATE_VERSION, windows: [blankDesktopWindow()] };
}

/* v1 was {lastFilePath?, windowBounds?, windowMaximized?} with no version
   field. It becomes one window whose one tab is the last file, or blank. */
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
    }]
  };
}

/* Whitelists every field, so nothing the contract does not name (a stray
   docId or draftId, say) survives a read-modify-write. A malformed id is
   replaced, and a duplicate one too, because tabId names a draft folder and
   two tabs must never share one. A window left with no tabs is dropped; no
   windows at all means a fresh install. */
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
  if (!windows.length) return freshDesktopState();
  return { version: DESKTOP_STATE_VERSION, windows };
}

/* A v1 file, a missing file or a corrupt one has no ids on disk, so each
   read would mint new random ones until the first write lands. Remembering
   what the last such read produced, keyed by the exact file text, keeps the
   ids stable within a process (a tab must not change id between two reads)
   while still reading the latest file every time. */
let desktopStateSynthesized = null; // {text, state}

function readDesktopStateV2() {
  let text = null;
  try { text = fs.readFileSync(stateFilePath(), "utf8"); } catch { text = null; }
  if (desktopStateSynthesized && desktopStateSynthesized.text === text) {
    return structuredClone(desktopStateSynthesized.state);
  }
  let parsed;
  try { parsed = text === null ? undefined : JSON.parse(text); } catch { parsed = undefined; }

  const isObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  /* No version field is v1. A newer version this build does not understand,
     unparseable JSON, a non-object or no file at all is a fresh install.
     A v2 file is normalized, which mints ids only for ones that are missing,
     malformed or duplicated; caching it too is harmless, since the same text
     always normalizes to the same ids otherwise. */
  const state = isObject && parsed.version === DESKTOP_STATE_VERSION ? normalizeDesktopStateV2(parsed)
    : isObject && !("version" in parsed) ? migrateDesktopStateV1(parsed)
    : freshDesktopState();
  desktopStateSynthesized = { text, state: structuredClone(state) };
  return state;
}

/* The one way desktop-state.json is written: a single in-process serialized
   queue whose every job reads the latest file, applies `mutator` to it, and
   writes the result durably. The mutator edits the state it is given in place
   (or returns a replacement object); returning `false` skips the write.

   WHY A QUEUE. Each job has to read, merge and write as one step, or two
   callers that each read the same old state lose one of their changes. The
   jobs run synchronously, straight away when the queue is idle, so a write
   is on disk by the time the caller's own code continues. A mutator that
   itself asks for a write gets queued behind the current job instead of
   nesting inside it.

   Resolves true when the file was written, false when it was skipped or
   failed. It never rejects: losing window-position memory is not fatal, and
   no caller can do anything better with the error. */
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

/* The single-window callers' view: windows[0]. */
function primaryDesktopWindow(state) { return state.windows[0]; }

/* The live shell, rendered as v2. This — not a read-modify-write of single
   fields — is what every structural change persists, because the windows and
   tabs in memory ARE the session: anything the file still holds that the
   shell no longer has is a window or tab that has been closed.
*/
function shellStateAsV2() {
  const windows = [];
  for (const w of windowsById.values()) {
    if (!w.win || w.win.isDestroyed()) continue;
    const rows = [];
    for (const tabId of w.tabIds) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
      /* A blank tab is restored only when it is holding unsaved work
         (DESKTOP-STATE-V2): relaunching into a row of empty documents the
         user never asked for would be worse than losing nothing. */
      if (tab.source.kind === "blank" && !draftsHasDraft(tabId)) continue;
      rows.push({ tabId, source: tab.source, lastKnownTitle: tab.title || "" });
    }
    /* …except that a window whose tabs are ALL skipped would vanish from the
       file entirely (normalizeDesktopStateV2 drops a window with no tabs),
       taking its id and its remembered position with it — and "a blank
       document" is the single most common way to leave the app. Keeping the
       active tab as a blank row costs one restored blank tab, which is what a
       fresh install opens anyway, and keeps window placement memory working. */
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
  return { version: DESKTOP_STATE_VERSION, windows };
}

/* One call for every structural change (create, close, reorder, move,
   activate, document source change) and, debounced, for bounds.

   WHY THE RESTORE GUARD. Launch builds the session one tab at a time, and
   each createTab would otherwise write the file — so a crash halfway through
   a restore would persist a session missing every tab not yet rebuilt, and
   the NEXT launch would restore that truncated version instead. While the
   restore runs nothing is written; one write at the end publishes the whole
   session at once. */
function persistShellState() {
  if (sessionWritesFrozen || sessionRestoreInProgress) return Promise.resolve(false);
  if (!windowsById.size) return Promise.resolve(false);
  return writeDesktopStateV2(() => shellStateAsV2());
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
 * 8b. Version history storage — the desktop half of HISTORY-STORAGE, and
 *     every handler behind HISTORY-IPC.
 *
 *     In a browser, per-document version history lives in IndexedDB
 *     (src/js/03a-history-store.js). On the desktop it lives in a plain
 *     folder tree under userData instead, and THIS process owns all of it:
 *     validation, the on-disk format, eviction. The renderer names a
 *     document only by docId and a snapshot only by its snapshot id
 *     (invariant #38) — it can never name a folder, and a docId that does
 *     not match DOC_ID_RE never reaches a path at all. A docId comes out of
 *     a file someone else may have written, so that check is the same kind
 *     of boundary as "the renderer never sends a path" (invariant #34).
 *
 *       <userData>/history/
 *         FORMAT                      "1". A HIGHER number means a newer
 *                                     build wrote this folder; history then
 *                                     goes READ-ONLY rather than let this
 *                                     build rewrite an index whose shape it
 *                                     does not understand.
 *         docs/d-<docId>/index.json   {formatVersion, docId, title,
 *                                     lastOpenedAt, bytes, snapshots[]},
 *                                     snapshots oldest first
 *         docs/d-<docId>/s-<id>.snap  three lines: the magic line, the meta
 *                                     JSON (with no document id in it — the
 *                                     folder IS the document), then the
 *                                     state JSON verbatim
 *         older/index.json            the one-time migration's bucket:
 *                                     {formatVersion, migratedAt, expiresAt,
 *                                     bytes, snapshots[]}
 *         older/s-<id>.snap
 *
 *     ORDER OF WRITES. A body is written before the index that names it, and
 *     a delete removes the index entry before it unlinks the body. Whichever
 *     half a crash interrupts, what survives is repairable rather than
 *     wrong: a body with no index entry is an orphan the next launch adopts,
 *     and an index entry with no body is dropped. Nothing here is fsynced
 *     (atomicWrite, section 6, deliberately does not) — losing the very
 *     newest snapshot to a power cut is tolerable, which is exactly what
 *     separates history from the session file and the crash drafts, both of
 *     which use writeFileDurableSync instead.
 *
 *     ONE QUEUE. Every read and every mutation runs through
 *     historyExclusive, so the in-memory index can never be observed
 *     half-updated and two puts can never interleave their index writes. The
 *     first job through it is always ensureHistoryTable (the fsck).
 * --------------------------------------------------------------------- */

const HISTORY_PER_DOC = 50;
const HISTORY_OLDER_KEY = "_older";
const HISTORY_SNAP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
/* Orchestrator override §2, confirmed 2026-09-14: the Older bucket expires as
   a WHOLE, 90 days after the migration that created it, because counting from
   each legacy snapshot's own date would empty it on day one. One named
   constant here and one in 03a-history-store.js: changing the policy is two
   edits, both obvious. */
const HISTORY_OLDER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const HISTORY_FORMAT_VERSION = 1;
const HISTORY_SNAP_MAGIC = "splitpage-snapshot 1";
/* 256 MiB (HISTORY-IPC). A body past this is refused outright rather than
   written: one snapshot that size would swallow the whole budget by itself. */
const HISTORY_MAX_BODY_BYTES = 256 * 1024 * 1024;
const HISTORY_DESKTOP_CAP_BYTES = 500 * 1024 * 1024;
/* Identifying an orphan body needs only its first two lines — the magic and
   the meta JSON — so the fsck reads a bounded prefix instead of pulling a
   multi-megabyte document into memory for every file in the folder. */
const HISTORY_HEADER_READ_BYTES = 64 * 1024;
/* atomicWrite names its temp file `.<basename>.tmp-<12 hex>`. One older than
   this was left behind by a process that died between writing it and the
   rename; nothing else ever creates that shape here. */
const HISTORY_TMP_MAX_AGE_MS = 10 * 60 * 1000;
const HISTORY_TMP_RE = /^\..+\.tmp-[0-9a-f]{12}$/;
const HISTORY_SNAP_FILE_RE = /^s-([a-z0-9][a-z0-9_-]{2,63})\.snap$/;

/* TEST_MODE only (HISTORY-IPC). 'exit-after-body' kills this process between
   the body write and the index write, which is how a smoke case reproduces a
   power cut mid-snapshot and proves the next launch adopts the orphan;
   'enospc-once'/'enospc-always' make body writes fail the way a full disk
   does, without filling one. Read once — a normal launch has no faults. */
const HISTORY_TEST_FAULT = TEST_MODE ? String(process.env.SPLITPAGE_TEST_HISTORY_FAULT || "") : "";
let historyFaultArmed = HISTORY_TEST_FAULT;

/* The cap is 500 MB, overridable in TEST_MODE so an eviction case does not
   have to write half a gigabyte to reach it. */
function historyCapBytes() {
  if (TEST_MODE) {
    const n = Number(process.env.SPLITPAGE_TEST_HISTORY_CAP_BYTES);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return HISTORY_DESKTOP_CAP_BYTES;
}

/* Resolved at call time, never cached: SPLITPAGE_USER_DATA moves userData for
   a test run, and app.getPath is the one authority on where it landed. */
function historyRoot() { return path.join(app.getPath("userData"), "history"); }

/* Containment (invariant #38). path.relative answers "" for the root itself,
   something starting with ".." for anything outside it, and an absolute path
   when the two are on different drives — all three are refusals. */
function historyContained(root, p) {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* A bucket is a document (its docId) or the migration's Older bucket. The
   Older bucket is reachable ONLY through {older:true} in the IPC query, never
   by naming it — a hostile file claiming docId "_older" fails DOC_ID_RE. */
function historyIsBucket(bucket) {
  return bucket === HISTORY_OLDER_KEY || (typeof bucket === "string" && DOC_ID_RE.test(bucket));
}

function historyBucketDir(bucket) {
  if (!historyIsBucket(bucket)) return null;
  const root = historyRoot();
  const dir = bucket === HISTORY_OLDER_KEY
    ? path.join(root, "older")
    : path.join(root, "docs", "d-" + bucket);
  return historyContained(root, dir) ? dir : null;
}

function historyIndexFile(bucket) {
  const dir = historyBucketDir(bucket);
  if (!dir) return null;
  const p = path.join(dir, "index.json");
  return historyContained(dir, p) ? p : null;
}

function historySnapFile(bucket, snapId) {
  const dir = historyBucketDir(bucket);
  if (!dir || typeof snapId !== "string" || !HISTORY_SNAP_ID_RE.test(snapId)) return null;
  const p = path.join(dir, "s-" + snapId + ".snap");
  return historyContained(dir, p) ? p : null;
}

/* bucket -> {docId?, title?, lastOpenedAt?, migratedAt?, expiresAt?, bytes,
   snapshots: SnapshotMeta[] oldest first}. Loaded once by the fsck and kept
   current by every write below — this process holds the single-instance lock,
   so nothing else can be changing the folder underneath it. */
const historyIndexes = new Map();
let historyChain = Promise.resolve();
let historyEnsured = null;
let historyReadOnly = false;
/* The ENOSPC twin of the renderer's historyQuotaStuck (03a-history-store.js).
   WHY: an eviction is committed before the retry runs and cannot be undone.
   When the retry is refused too — the disk is genuinely full, not merely over
   OUR cap — evicting again on the next capture would delete roughly one more
   snapshot per capture while still storing nothing. So after one failed
   evict-and-retry, later refusals go straight to 'enospc' until some write
   succeeds again. Every put still makes its first attempt, so space freed
   elsewhere is picked up at once. */
let historyQuotaStuck = false;

/* One promise chain for every history job in this process. A job that throws
   is not allowed to wedge the chain, so the chain itself always continues. */
function historyExclusive(job) {
  const run = historyChain.then(async () => {
    if (!historyEnsured) {
      historyEnsured = ensureHistoryTable().then(() => true, (err) => {
        /* An unreadable history folder must not take a snapshot write down
           with it: carry on with an empty table, and let the write itself
           report 'io' if the disk really is the problem. */
        if (TEST_MODE) process.stderr.write(`[splitpage] history fsck failed: ${err && err.stack || err}\n`);
        return true;
      });
    }
    await historyEnsured;
    return job();
  });
  historyChain = run.then(() => {}, () => {});
  return run;
}

function historyClip(v, n) { return String(v == null ? "" : v).slice(0, n); }

function historyIsNoSpace(err) {
  const code = err && err.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

function historyErrorCode(err) { return historyIsNoSpace(err) ? "enospc" : "io"; }

/* SnapshotMeta (HISTORY-STORAGE), rebuilt from plain values with every length
   clamped — the same clamps 03a-history-store.js applies, so a meta means the
   same thing on both sides of the bridge. Deliberately carries no document
   id: on disk the folder is the document. Returns null when the id is
   unusable, which is what makes an invalid meta a rejected invoke. */
function sanitizeHistoryMeta(m) {
  if (!m || typeof m !== "object") return null;
  const id = typeof m.id === "string" ? m.id : "";
  if (!HISTORY_SNAP_ID_RE.test(id)) return null;
  let atMs = Number(m.atMs);
  if (!Number.isFinite(atMs)) atMs = Date.parse(m.at) || 0;
  if (!Number.isFinite(atMs)) atMs = 0;
  const out = {
    id,
    label: historyClip(m.label, 300),
    at: typeof m.at === "string" && m.at ? historyClip(m.at, 40) : new Date(atMs).toISOString(),
    atMs,
    by: historyClip(m.by, 100),
    rows: Math.max(0, Math.floor(Number(m.rows) || 0)),
    title: historyClip(m.title, 300),
    sizeBytes: Math.max(0, Math.floor(Number(m.sizeBytes) || 0)),
    kind: m.kind === "legacy" ? "legacy" : "snapshot",
    formatVersion: 1
  };
  if (m.legacyId != null) out.legacyId = historyClip(m.legacyId, 100);
  return out;
}

/* WHY A PUT RE-STAMPS atMs (orchestrator override §2b, and the same reasoning
   as 03a's historyStampAfter). Trims and the eviction planner call the
   largest atMs a document's NEWEST snapshot. After the system clock is
   corrected backwards, every new capture would otherwise sort below snapshots
   stamped in the "future": each save's trim would delete the previous real
   snapshot and keep the stale ones. So a put stamps strictly after the newest
   snapshot already stored in its bucket; `at` keeps the wall-clock text the
   user actually saw. copy and import-older keep their source atMs — they are
   not new work. */
function historyStampAfter(m, newestAtMs) {
  const n = Number(newestAtMs);
  if (newestAtMs != null && Number.isFinite(n) && !(m.atMs > n)) m.atMs = n + 1;
  return m;
}

/* A NON-POSITIVE expiresAt is "not stamped", never "expired since 1970".
   historyNewRecord starts an Older record at 0, and a bucket the fsck rebuilt
   from its bodies keeps that 0 when its index.json was missing or unparseable
   — which is exactly what a crash between the migration's body writes and its
   single index write leaves behind. Reading 0 as expired hid the whole
   migrated history from every list, while planHistoryEviction guards its
   expiry sweep with `expiresAt > 0` and so refused to delete it: invisible,
   undeletable, still counted against the cap, and (because the migration
   could never see its own entries come back) re-imported fruitlessly on every
   launch. The two predicates have to agree; fsckHistoryBucket re-stamps a
   rebuilt bucket so it can still expire on schedule. */
function historyOlderExpired(rec) {
  if (!rec || rec.expiresAt == null) return false;
  const expiresAt = Number(rec.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return Date.now() >= expiresAt;
}

function historyNewRecord(bucket) {
  return bucket === HISTORY_OLDER_KEY
    ? { migratedAt: 0, expiresAt: 0, bytes: 0, snapshots: [] }
    : { docId: bucket, title: "", lastOpenedAt: 0, bytes: 0, snapshots: [] };
}

function historyRecordFor(bucket) {
  let rec = historyIndexes.get(bucket);
  if (!rec) {
    rec = historyNewRecord(bucket);
    historyIndexes.set(bucket, rec);
  }
  return rec;
}

function historyIndexShape(bucket, rec) {
  if (bucket === HISTORY_OLDER_KEY) {
    return {
      formatVersion: HISTORY_FORMAT_VERSION,
      migratedAt: rec.migratedAt || 0,
      expiresAt: rec.expiresAt || 0,
      bytes: rec.bytes,
      snapshots: rec.snapshots
    };
  }
  return {
    formatVersion: HISTORY_FORMAT_VERSION,
    docId: bucket,
    title: rec.title || "",
    lastOpenedAt: rec.lastOpenedAt || 0,
    bytes: rec.bytes,
    snapshots: rec.snapshots
  };
}

function historyRecountBytes(rec) {
  rec.bytes = rec.snapshots.reduce((n, m) => n + (Number(m.sizeBytes) || 0), 0);
  return rec.bytes;
}

async function writeHistoryIndex(bucket) {
  const file = historyIndexFile(bucket);
  const rec = historyIndexes.get(bucket);
  if (!file || !rec) return;
  historyRecountBytes(rec);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, Buffer.from(JSON.stringify(historyIndexShape(bucket, rec)), "utf8"));
}

/* A bucket with nothing left in it goes as a whole, folder included — an
   expired Older bucket in particular, so a later migration starts a fresh 90
   days instead of inheriting an already-dead expiry. */
async function historyDropBucket(bucket) {
  historyIndexes.delete(bucket);
  const dir = historyBucketDir(bucket);
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* locked; next launch */ });
}

function historySnapText(meta, stateJson) {
  return HISTORY_SNAP_MAGIC + "\n" + JSON.stringify(meta) + "\n" + stateJson;
}

/* The first two lines of a .snap, from a bounded read. Returns null for
   anything that is not one of ours, which is what marks a file corrupt. */
async function readHistorySnapHeader(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(HISTORY_HEADER_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HISTORY_HEADER_READ_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    const nl1 = head.indexOf("\n");
    if (nl1 === -1 || head.slice(0, nl1).trim() !== HISTORY_SNAP_MAGIC) return null;
    const nl2 = head.indexOf("\n", nl1 + 1);
    if (nl2 === -1) return null;
    let parsed = null;
    try { parsed = JSON.parse(head.slice(nl1 + 1, nl2)); } catch { return null; }
    const meta = sanitizeHistoryMeta(parsed);
    if (!meta) return null;
    return { meta, headerBytes: Buffer.byteLength(head.slice(0, nl2 + 1), "utf8") };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/* The whole snapshot. The state JSON is handed back as TEXT and is never
   parsed here: main has no business knowing what a document looks like, and
   parsing it would only add a way for a corrupt body to take this process
   down. Everything after the SECOND newline is the body, newlines and all. */
async function readHistorySnapshotFile(bucket, snapId) {
  const file = historySnapFile(bucket, snapId);
  if (!file) return null;
  let text;
  try { text = await fsp.readFile(file, "utf8"); } catch { return null; }
  const nl1 = text.indexOf("\n");
  if (nl1 === -1 || text.slice(0, nl1).trim() !== HISTORY_SNAP_MAGIC) return null;
  const nl2 = text.indexOf("\n", nl1 + 1);
  if (nl2 === -1) return null;
  let parsed = null;
  try { parsed = JSON.parse(text.slice(nl1 + 1, nl2)); } catch { return null; }
  const meta = sanitizeHistoryMeta(parsed);
  if (!meta) return null;
  return { meta, stateJson: text.slice(nl2 + 1) };
}

/* ---- the fsck (runs once, as the first job on the queue) ---- */

async function ensureHistoryTable() {
  const root = historyRoot();
  historyIndexes.clear();
  historyReadOnly = false;

  let formatText = null;
  try { formatText = await fsp.readFile(path.join(root, "FORMAT"), "utf8"); } catch { /* first run */ }
  if (formatText == null) {
    await fsp.mkdir(path.join(root, "docs"), { recursive: true });
    await atomicWrite(path.join(root, "FORMAT"), Buffer.from(HISTORY_FORMAT_VERSION + "\n", "utf8"));
  } else {
    const n = parseInt(String(formatText).trim(), 10);
    /* A number we cannot read at all is treated as ours rather than as a
       reason to stop storing history; a HIGHER one is a newer build's folder
       and must not be rewritten by this one. */
    if (Number.isFinite(n) && n > HISTORY_FORMAT_VERSION) historyReadOnly = true;
  }

  const buckets = [];
  let names = [];
  try { names = await fsp.readdir(path.join(root, "docs")); } catch { /* nothing stored yet */ }
  for (const name of names) {
    if (!name.startsWith("d-")) continue;
    const docId = name.slice(2);
    if (DOC_ID_RE.test(docId)) buckets.push(docId);
  }
  try {
    if ((await fsp.stat(path.join(root, "older"))).isDirectory()) buckets.push(HISTORY_OLDER_KEY);
  } catch { /* no migration has run here */ }

  for (const bucket of buckets) {
    try { await fsckHistoryBucket(bucket); }
    catch (err) {
      if (TEST_MODE) process.stderr.write(`[splitpage] history bucket unreadable: ${err && err.stack || err}\n`);
    }
  }
}

/* Reconciles one bucket's index.json with the bodies actually on disk:
     - sweeps temp files older than 10 minutes (a write that died before its
       rename; nothing else in this folder has that name shape)
     - rebuilds a corrupt or missing index.json from the bodies' own headers
     - adopts orphan bodies (written, then the index write never happened)
     - drops index entries whose body is gone
     - renames a body that is not a readable snapshot to *.corrupt, so it is
       neither adopted every launch nor silently deleted
   Read-only mode does all the reading and none of the repairs. */
async function fsckHistoryBucket(bucket) {
  const dir = historyBucketDir(bucket);
  if (!dir) return;
  let names;
  try { names = await fsp.readdir(dir); } catch { return; }

  const now = Date.now();
  const bodies = new Map();          /* snapId -> {file, diskBytes} */
  for (const name of names) {
    if (HISTORY_TMP_RE.test(name)) {
      if (historyReadOnly) continue;
      const tmp = path.join(dir, name);
      try {
        const st = await fsp.stat(tmp);
        if (now - st.mtimeMs > HISTORY_TMP_MAX_AGE_MS) await fsp.unlink(tmp);
      } catch { /* gone, or locked — next launch */ }
      continue;
    }
    const m = HISTORY_SNAP_FILE_RE.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let diskBytes = 0;
    try { diskBytes = (await fsp.stat(file)).size; } catch { continue; }
    bodies.set(m[1], { file, diskBytes });
  }

  let raw = null;
  let indexBroken = false;
  try { raw = JSON.parse(await fsp.readFile(path.join(dir, "index.json"), "utf8")); }
  catch (err) { indexBroken = err && err.code !== "ENOENT"; }

  const rec = historyNewRecord(bucket);
  if (raw && typeof raw === "object") {
    if (bucket === HISTORY_OLDER_KEY) {
      rec.migratedAt = Number(raw.migratedAt) || 0;
      rec.expiresAt = Number(raw.expiresAt) || 0;
    } else {
      rec.title = historyClip(raw.title, 300);
      rec.lastOpenedAt = Number(raw.lastOpenedAt) || 0;
    }
  }

  const listed = raw && Array.isArray(raw.snapshots) ? raw.snapshots : [];
  const seen = new Set();
  for (const entry of listed) {
    const meta = sanitizeHistoryMeta(entry);
    if (!meta || seen.has(meta.id) || !bodies.has(meta.id)) continue;   /* body gone: drop the entry */
    seen.add(meta.id);
    rec.snapshots.push(meta);
  }

  let changed = indexBroken || rec.snapshots.length !== listed.length;
  for (const [snapId, body] of bodies) {
    if (seen.has(snapId)) continue;
    const header = await readHistorySnapHeader(body.file);
    if (!header) {
      if (!historyReadOnly) {
        await fsp.rename(body.file, body.file + ".corrupt").catch(() => {});
        changed = true;
      }
      continue;
    }
    /* An orphan body IS the snapshot — the crash simply happened between it
       and its index entry, so adopting it is exactly the repair. */
    if (!header.meta.sizeBytes) header.meta.sizeBytes = Math.max(0, body.diskBytes - header.headerBytes);
    header.meta.diskBytes = body.diskBytes;
    rec.snapshots.push(header.meta);
    seen.add(snapId);
    changed = true;
  }

  rec.snapshots.sort((a, b) => (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  historyRecountBytes(rec);

  /* A rebuilt Older bucket lost its migration record along with its index, so
     nothing on disk says when its 90 days started — and an unstamped bucket
     would live forever (planHistoryEviction only sweeps `expiresAt > 0`).
     Restarting the clock from now is the only date there is, and it keeps
     overrides §2's rule intact: the whole bucket expires at once, counted
     from the migration. */
  if (bucket === HISTORY_OLDER_KEY && rec.snapshots.length && !(Number(rec.expiresAt) > 0)) {
    rec.migratedAt = Number(rec.migratedAt) > 0 ? Number(rec.migratedAt) : Date.now();
    rec.expiresAt = rec.migratedAt + HISTORY_OLDER_TTL_MS;
    changed = true;
  }

  if (!rec.snapshots.length) {
    if (!historyReadOnly) await historyDropBucket(bucket);
    return;
  }
  historyIndexes.set(bucket, rec);
  if (changed && !historyReadOnly) {
    if (indexBroken) {
      await fsp.rename(path.join(dir, "index.json"), path.join(dir, "index.json.corrupt")).catch(() => {});
    }
    await writeHistoryIndex(bucket).catch(() => { /* reported by the next write */ });
  }
}

/* ---- eviction planner ----

   A LINE-FOR-LINE COPY of planHistoryEviction in src/js/03a-history-store.js,
   de-indented to this file's top level and otherwise untouched (it is written
   in the renderer's plain-ES5 house style for exactly that reason: `var`,
   function declarations, nothing from either closure). The browser and the
   desktop app must expire, trim and evict version history identically, and
   the ONLY way to keep two copies honest is to compare them — which is what
   caseHistoryPlannerTwin (step M) does, running the same fixtures through
   window.__historyTest.planEviction and through splitpage:test-history-plan
   and demanding the same answer. If you change one, change the other in the
   same commit. */
function planHistoryEviction(docs, capBytes, nowMs, opts) {
  opts = opts || {};
  var perDoc = Number(opts.perDoc) > 0 ? Math.floor(Number(opts.perDoc)) : 50;
  var olderKey = typeof opts.olderKey === "string" ? opts.olderKey : "_older";
  var cap = (typeof capBytes === "number" && capBytes >= 0) ? capBytes : Infinity;
  var now = (typeof nowMs === "number" && isFinite(nowMs)) ? nowMs : 0;
  var protect = Object.create(null);
  (Array.isArray(opts.protect) ? opts.protect : []).forEach(function (p) {
    if (p && typeof p.docId === "string" && typeof p.id === "string") protect[p.docId + "\n" + p.id] = true;
  });
  function toMs(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    if (typeof v === "string" && v) { var p = Date.parse(v); return isFinite(p) ? p : 0; }
    return 0;
  }
  var list = [], older = null, total = 0, deletes = [];
  (Array.isArray(docs) ? docs : []).forEach(function (d) {
    if (!d || typeof d.docId !== "string") return;
    var snaps = [];
    (Array.isArray(d.snapshots) ? d.snapshots : []).forEach(function (s) {
      if (!s || typeof s.id !== "string") return;
      var size = Number(s.sizeBytes);
      snaps.push({ id: s.id, atMs: toMs(s.atMs), size: isFinite(size) && size > 0 ? size : 0 });
    });
    snaps.sort(function (a, b) { return (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    snaps.forEach(function (s) { total += s.size; });
    var entry = { docId: d.docId, lastOpenedAt: toMs(d.lastOpenedAt), expiresAt: toMs(d.expiresAt), snaps: snaps };
    if (d.docId === olderKey) older = entry; else list.push(entry);
  });
  var totalBefore = total;
  /* Deletes entry's oldest snapshot that is not protected — never its
     newest one when keepNewest. false when nothing there may go. */
  function dropOldest(entry, keepNewest) {
    var end = keepNewest ? entry.snaps.length - 1 : entry.snaps.length;
    for (var j = 0; j < end; j++) {
      var s = entry.snaps[j];
      if (protect[entry.docId + "\n" + s.id]) continue;
      entry.snaps.splice(j, 1);
      total -= s.size;
      deletes.push({ docId: entry.docId, id: s.id });
      return true;
    }
    return false;
  }
  if (older && older.expiresAt > 0 && now >= older.expiresAt) {
    while (dropOldest(older, false)) { /* the whole bucket */ }
  }
  list.forEach(function (e) {
    while (e.snaps.length > perDoc && dropOldest(e, true)) { /* newest perDoc stay */ }
  });
  if (older) {
    while (total > cap && dropOldest(older, false)) { /* Older before any document */ }
  }
  list.sort(function (a, b) {
    return (a.lastOpenedAt - b.lastOpenedAt) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0);
  });
  for (var i = 0; i < list.length && total > cap; i++) {
    while (total > cap && dropOldest(list[i], true)) { /* its newest stays */ }
  }
  return { deletes: deletes, totalBefore: totalBefore, totalAfter: total, overCap: total > cap };
}

/* Runs the plan and applies it: index first, then unlink, one bucket at a
   time. `protect` is the renderer's held snapshots (protectHistorySnapshot,
   03a) — a restore is READING one of these while its "Before restoring"
   backup is being written, and the Older bucket is the first thing eviction
   takes, so without this list a restore from Older under a full disk could
   delete the very snapshot it is restoring. Caller holds the queue. */
async function historyEvictLocked(capBytes, protect) {
  const docs = [...historyIndexes.entries()].map(([bucket, rec]) => ({
    docId: bucket,
    lastOpenedAt: rec.lastOpenedAt || 0,
    expiresAt: rec.expiresAt || 0,
    snapshots: rec.snapshots.map((m) => ({ id: m.id, atMs: m.atMs, sizeBytes: m.sizeBytes }))
  }));
  const plan = planHistoryEviction(docs, capBytes, Date.now(), {
    perDoc: HISTORY_PER_DOC,
    olderKey: HISTORY_OLDER_KEY,
    protect: historyAllHolds(protect)
  });
  if (historyReadOnly) {
    return { evicted: 0, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalBefore };
  }

  const byBucket = new Map();
  for (const d of plan.deletes) {
    if (!byBucket.has(d.docId)) byBucket.set(d.docId, new Set());
    byBucket.get(d.docId).add(d.id);
  }
  let evicted = 0;
  for (const [bucket, ids] of byBucket) {
    const rec = historyIndexes.get(bucket);
    if (!rec) continue;
    rec.snapshots = rec.snapshots.filter((m) => !ids.has(m.id));
    try {
      if (rec.snapshots.length) await writeHistoryIndex(bucket);
      else await historyDropBucket(bucket);
    } catch (err) {
      if (TEST_MODE) process.stderr.write(`[splitpage] history index write failed: ${err && err.stack || err}\n`);
    }
    for (const id of ids) {
      const file = historySnapFile(bucket, id);
      if (!file) continue;
      await fsp.unlink(file).catch(() => { /* already gone, or locked */ });
      evicted++;
    }
  }
  return { evicted, overCap: plan.overCap, totalBefore: plan.totalBefore, totalAfter: plan.totalAfter };
}

/* EVERY TAB'S held snapshots, not just the caller's. Eviction is process-wide
   — a put from any tab can delete any document's oldest snapshot, the Older
   bucket goes first, and historyCopyLocked and the expired-Older sweep evict
   with no caller at all — while a protect list only ever travelled with the
   one call that carried it. So tab B's save could delete the snapshot tab A
   was in the middle of restoring, which is the very thing override §2b's
   protect list exists to stop. Keyed by webContents id and dropped with the
   tab (forgetTab), so a closed or crashed tab cannot pin snapshots for the
   rest of the run. */
const historyHolds = new Map();   /* webContentsId -> [{docId, id}] */

function historyAllHolds(protect) {
  const out = historyProtectList(protect);
  const seen = new Set(out.map((p) => p.docId + "\n" + p.id));
  for (const held of historyHolds.values()) {
    for (const p of held) {
      const key = p.docId + "\n" + p.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/* The renderer's held-snapshot list, validated the same way every other id
   crossing this boundary is: a bucket that is neither a valid docId nor the
   Older key, or an id that is not a snapshot id, simply protects nothing. */
function historyProtectList(protect) {
  const out = [];
  if (!Array.isArray(protect)) return out;
  for (const p of protect.slice(0, 200)) {
    if (!p || typeof p !== "object") continue;
    const docId = typeof p.docId === "string" ? p.docId : "";
    const id = typeof p.id === "string" ? p.id : "";
    if (!historyIsBucket(docId) || !HISTORY_SNAP_ID_RE.test(id)) continue;
    out.push({ docId, id });
  }
  return out;
}

function historyTotalBytes() {
  let total = 0;
  for (const rec of historyIndexes.values()) total += rec.bytes || 0;
  return total;
}

/* ---- TEST_MODE faults ---- */

function historyFaultBeforeBodyWrite() {
  if (historyFaultArmed === "enospc-once") {
    historyFaultArmed = "";
    const err = new Error("Injected ENOSPC");
    err.code = "ENOSPC";
    throw err;
  }
  if (historyFaultArmed === "enospc-always") {
    const err = new Error("Injected ENOSPC");
    err.code = "ENOSPC";
    throw err;
  }
}

function historyFaultAfterBodyWrite() {
  if (historyFaultArmed !== "exit-after-body") return;
  /* A body on disk with no index entry, and the process gone without running
     will-quit — the exact state a power cut mid-snapshot leaves. SIGKILL, so
     nothing gets a chance to tidy up; the children have to go first or they
     are orphaned. */
  killDocumentServer();
  killTunnel();
  process.kill(process.pid, "SIGKILL");
}

/* ---- the operations (each one holds the queue) ---- */

async function historyPutLocked(docId, meta, stateJson, protect) {
  if (historyReadOnly) return { ok: false, code: "read-only" };
  const size = Buffer.byteLength(stateJson, "utf8");
  if (size > HISTORY_MAX_BODY_BYTES) return { ok: false, code: "too-large" };

  const rec = historyRecordFor(docId);
  const existing = rec.snapshots.find((m) => m.id === meta.id);
  /* Idempotent: the same snapshot id twice is the retry of a write whose
     answer was lost, never a second snapshot. */
  if (existing) {
    return { ok: true, sizeBytes: existing.sizeBytes, duplicate: true, evicted: 0, overCap: false };
  }

  const newest = rec.snapshots.length ? rec.snapshots[rec.snapshots.length - 1].atMs : null;
  const m = historyStampAfter(sanitizeHistoryMeta(meta), newest);
  m.sizeBytes = size;

  const file = historySnapFile(docId, m.id);
  if (!file) return { ok: false, code: "io" };
  const body = Buffer.from(historySnapText(m, stateJson), "utf8");
  m.diskBytes = body.length;

  const writeBody = async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    historyFaultBeforeBodyWrite();
    await atomicWrite(file, body);
    historyFaultAfterBodyWrite();
  };

  let evicted = 0;
  try {
    await writeBody();
    historyQuotaStuck = false;
  } catch (err) {
    if (!historyIsNoSpace(err)) {
      if (TEST_MODE) process.stderr.write(`[splitpage] history put failed: ${err && err.stack || err}\n`);
      return { ok: false, code: "io" };
    }
    if (historyQuotaStuck) return { ok: false, code: "enospc" };
    /* The retry's budget is the normal cap lowered by this snapshot's size:
       evicting under the normal cap alone frees nothing when the real disk,
       not our cap, is what refused the write. */
    const ev = await historyEvictLocked(Math.min(historyCapBytes(), Math.max(0, historyTotalBytes() - size)), protect)
      .catch(() => ({ evicted: 0 }));
    evicted = ev.evicted || 0;
    if (!evicted) {
      /* Nothing could be freed, so the retry cannot gain anything — say so
         now rather than delete more on the next capture (override §2b). */
      historyQuotaStuck = true;
      return { ok: false, code: "enospc" };
    }
    try {
      await writeBody();
      historyQuotaStuck = false;
    } catch (err2) {
      if (historyIsNoSpace(err2)) historyQuotaStuck = true;
      return { ok: false, code: historyErrorCode(err2), evicted };
    }
  }

  rec.snapshots.push(m);
  rec.snapshots.sort((a, b) => (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (m.title) rec.title = m.title;
  rec.lastOpenedAt = Date.now();
  try {
    await writeHistoryIndex(docId);
  } catch (err) {
    /* The body is on disk; the index is not. The next launch's fsck adopts
       it, so the snapshot is not lost — but this write did not complete, and
       saying so is what makes the renderer keep its own copy pending. */
    rec.snapshots = rec.snapshots.filter((s) => s.id !== m.id);
    await fsp.unlink(file).catch(() => {});
    return { ok: false, code: historyErrorCode(err), evicted };
  }

  /* Trim to 50 and, if we are over the cap, evict — the planner does both in
     one pass, and does the per-document trim whether or not the cap is hit. */
  const ev = await historyEvictLocked(historyCapBytes(), protect)
    .catch(() => ({ evicted: 0, overCap: false }));
  return {
    ok: true,
    sizeBytes: size,
    duplicate: false,
    evicted: evicted + (ev.evicted || 0),
    overCap: !!ev.overCap
  };
}

function historyListLocked(docId) {
  const out = { entries: [], older: [], olderExpiresAt: null };
  if (docId) {
    const rec = historyIndexes.get(docId);
    if (rec) out.entries = rec.snapshots.slice().reverse();
  }
  const older = historyIndexes.get(HISTORY_OLDER_KEY);
  if (older) {
    if (historyOlderExpired(older)) {
      /* A read must not write inside its own turn, and the panel has already
         stopped showing these: report empty now and queue the delete behind
         this job. The planner takes an expired bucket as a whole. */
      historyExclusive(() => historyEvictLocked(historyCapBytes(), [])).catch(() => {});
    } else {
      out.older = older.snapshots.slice().reverse();
      out.olderExpiresAt = older.expiresAt || null;
    }
  }
  return out;
}

async function historyCopyLocked(fromDocId, toDocId) {
  if (historyReadOnly) return { ok: false, copied: 0, code: "read-only" };
  const src = historyIndexes.get(fromDocId);
  const dstExisting = historyIndexes.get(toDocId);
  /* Nothing to copy and nothing already there: a copy of an empty history
     must not conjure a record for a document that has none. */
  if (!src && !dstExisting) return { ok: true, copied: 0 };

  const dst = historyRecordFor(toDocId);
  const have = new Set(dst.snapshots.map((m) => m.id));
  const toDir = historyBucketDir(toDocId);
  if (!toDir) return { ok: false, copied: 0, code: "io" };
  let copied = 0;
  try {
    await fsp.mkdir(toDir, { recursive: true });
    for (const m of (src ? src.snapshots : [])) {
      if (have.has(m.id)) continue;
      const fromFile = historySnapFile(fromDocId, m.id);
      const toFile = historySnapFile(toDocId, m.id);
      if (!fromFile || !toFile) continue;
      /* Same shape as atomicWrite's temp name, so the fsck's sweep catches
         one left behind by a crash between the copy and the rename. */
      const tmp = path.join(toDir, `.${path.basename(toFile)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
      try {
        await fsp.copyFile(fromFile, tmp);
        await fsp.rename(tmp, toFile);
      } catch (err) {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
      dst.snapshots.push(sanitizeHistoryMeta(m));   /* ids are kept: a second copy is a no-op */
      have.add(m.id);
      copied++;
    }
  } catch (err) {
    if (TEST_MODE) process.stderr.write(`[splitpage] history copy failed: ${err && err.stack || err}\n`);
    if (!dst.snapshots.length) historyIndexes.delete(toDocId);
    return { ok: false, copied, code: historyErrorCode(err) };
  }

  dst.snapshots.sort((a, b) => (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!dst.title && src && src.title) dst.title = src.title;
  dst.lastOpenedAt = Date.now();
  if (!dst.snapshots.length) { historyIndexes.delete(toDocId); return { ok: true, copied: 0 }; }
  try { await writeHistoryIndex(toDocId); }
  catch (err) { return { ok: false, copied, code: historyErrorCode(err) }; }
  /* The index is written first, so a trim that fails still leaves a correct
     (if over-long) history rather than bodies nothing points at. */
  await historyEvictLocked(historyCapBytes(), []).catch(() => {});
  return { ok: true, copied };
}

/* Never creates a record: opening a document that has no history yet must not
   leave an empty folder behind for every file ever opened. */
async function historyTouchLocked(docId, title) {
  if (historyReadOnly) return;
  const rec = historyIndexes.get(docId);
  if (!rec) return;
  rec.lastOpenedAt = Date.now();
  const t = historyClip(title, 300);
  if (t) rec.title = t;
  await writeHistoryIndex(docId).catch(() => { /* a touch is a courtesy */ });
}

/* Put-if-absent into the Older bucket. migratedAt/expiresAt are set only when
   the bucket is created, so re-running an interrupted migration never extends
   the 90 days. */
async function historyImportOlderLocked(entries) {
  if (historyReadOnly) return { ok: false, count: 0, added: 0, code: "read-only" };
  const existing = historyIndexes.get(HISTORY_OLDER_KEY);
  if (!existing && !entries.length) return { ok: true, count: 0, added: 0 };
  const rec = historyRecordFor(HISTORY_OLDER_KEY);
  if (!existing) {
    const now = Date.now();
    rec.migratedAt = now;
    rec.expiresAt = now + HISTORY_OLDER_TTL_MS;
  }
  const have = new Set(rec.snapshots.map((m) => m.id));
  const dir = historyBucketDir(HISTORY_OLDER_KEY);
  let added = 0;
  try {
    await fsp.mkdir(dir, { recursive: true });
    for (const e of entries) {
      const meta = sanitizeHistoryMeta(e && e.meta);
      if (!meta || have.has(meta.id) || typeof (e && e.stateJson) !== "string") continue;
      const file = historySnapFile(HISTORY_OLDER_KEY, meta.id);
      if (!file) continue;
      meta.sizeBytes = Buffer.byteLength(e.stateJson, "utf8");
      const body = Buffer.from(historySnapText(meta, e.stateJson), "utf8");
      meta.diskBytes = body.length;
      await atomicWrite(file, body);
      rec.snapshots.push(meta);
      have.add(meta.id);
      added++;
    }
  } catch (err) {
    if (TEST_MODE) process.stderr.write(`[splitpage] history import failed: ${err && err.stack || err}\n`);
    if (!rec.snapshots.length) historyIndexes.delete(HISTORY_OLDER_KEY);
    else await writeHistoryIndex(HISTORY_OLDER_KEY).catch(() => {});
    return { ok: false, count: rec.snapshots.length, added, code: historyErrorCode(err) };
  }
  if (!rec.snapshots.length) { historyIndexes.delete(HISTORY_OLDER_KEY); return { ok: true, count: 0, added: 0 }; }
  rec.snapshots.sort((a, b) => (a.atMs - b.atMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  try { await writeHistoryIndex(HISTORY_OLDER_KEY); }
  catch (err) { return { ok: false, count: rec.snapshots.length, added, code: historyErrorCode(err) }; }
  return { ok: true, count: rec.snapshots.length, added };
}

function historyUsageLocked() {
  const cap = historyCapBytes();
  let total = 0;
  let docCount = 0;
  for (const [bucket, rec] of historyIndexes) {
    total += rec.bytes || 0;
    if (bucket !== HISTORY_OLDER_KEY) docCount++;
  }
  return { totalBytes: total, capBytes: cap, overCap: total > cap, docCount, readOnly: historyReadOnly };
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
    const message = `Ports ${WANTED_PORT}-${WANTED_PORT + 20} are all busy. Try --port with something else.`;
    /* A test run must never put a modal on this machine's screen (invariant
       #33). TEST_MODE's stub for showErrorBox only redirects it to stderr;
       this case also has to STOP, because an automated --library/--host run
       that silently drops to local mode looks like a passing launch and then
       fails somewhere far away from the real cause. Exit non-zero instead,
       after killing anything already started. */
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
 * 9. Updates. The same "a file the page reads" design as start.mjs's
 *    update-status.json, just built in memory here instead of written to
 *    disk (there is no reason for a desktop build to keep a JSON file next
 *    to the app for this).
 *
 *    THE CHECK IS AUTOMATIC, THE DOWNLOAD AND INSTALL ARE NOT. Launch looks
 *    for a newer release; nothing is fetched or run until the person clicks
 *    Download in the update bar. That click downloads the installer for
 *    THIS platform and architecture in-app — there is deliberately no
 *    "here's a link, go and find the right file" step any more — and a
 *    second click runs it.
 *
 *    WHAT THE RENDERER MAY SAY ABOUT ANY OF IT: "start the download" and
 *    "run what was downloaded", and nothing else. It never supplies a URL,
 *    a filename or a path — every one of those is chosen here, from the
 *    release API's own answer (assets are release-controlled data, so their
 *    names are validated before one becomes a filename), and the page is
 *    only ever told progress and state. A renderer that could name the file
 *    to execute would be a code-execution route wearing a friendly label.
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

/* An asset name off the network becomes a filename on this disk, so it is
   untrusted input: "../../etc/cron.d/x" or a name with a shell character in
   it has no business reaching a path or a spawn. Only this shape does, and
   path.basename is applied on top so nothing can be assumed about it. */
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/* The installer extension per platform. An asset of any other kind is not
   something this app knows how to install, so it is never a candidate. */
const INSTALLER_EXT = { win32: ".exe", darwin: ".dmg", linux: ".appimage" };

const DEFAULT_UPDATE_API =
  "https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest";

function updateApiUrl() {
  return process.env.SPLITPAGE_UPDATE_API || DEFAULT_UPDATE_API;
}

/* Where a download may come from. The URL always comes from the release API
   rather than from the page, so this is a second line rather than the first —
   but it is what stops a mistyped or tampered release body from pointing the
   download (and therefore something this app will execute) at an arbitrary
   host.

   Two sources qualify, and nothing else: GitHub over HTTPS — where
   api.github.com redirects release assets — and the update API's OWN origin,
   whatever that is. The second is not a loophole but the point: update.mjs
   is overridable precisely so a fork is not stuck fetching someone else's
   releases and so this can be aimed at a test server, and an allowlist of
   only github.com would have quietly made every such build un-updatable.
   Whoever sets SPLITPAGE_UPDATE_API already chose which server to trust. */
function isAllowedDownloadHost(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { return false; }
  let api = null;
  try { api = new URL(updateApiUrl()); } catch { api = null; }
  if (api && parsed.origin === api.origin) return true;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "github.com"
    || host === "api.github.com"
    || host.endsWith(".githubusercontent.com");
}

/* The one asset of a release that installs it on THIS machine. Architecture
   is part of the answer, not a detail: 1.0.1 shipped an "x64" setup that was
   really an ARM64 binary, and handing an ARM64 machine the x64 installer (or
   the reverse) is the same failure with the blame moved to the updater. A
   name carrying this machine's arch wins; a single unambiguous candidate is
   accepted without one (a universal build, or a one-installer release); two
   or more that disagree are refused rather than guessed at. */
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

  const arch = process.arch; /* "x64" | "arm64" | ... */
  const other = ["x64", "arm64", "ia32", "armv7l"].filter((a) => a !== arch);
  const mentions = (name, token) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(name);

  const mine = candidates.filter((a) => mentions(a.name, arch));
  if (mine.length === 1) return describeAsset(mine[0]);
  if (mine.length > 1) return null; /* ambiguous — better to say nothing than to guess */

  /* No name names this arch. Anything naming a DIFFERENT one is not ours. */
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

/* Published checksums, when the release has them. Optional on purpose: a
   release without a SHA256SUMS asset still updates (HTTPS to GitHub is the
   floor), but when the file IS there a mismatch stops the install — which is
   the only way this app can tell a truncated or substituted download from a
   good one before running it. */
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
      /* "<hex>  <name>" — the sha256sum format, with the binary marker "*"
         the same tool writes for a binary-mode sum. */
      const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
      if (m && path.basename(m[2]) === assetName) return m[1].toLowerCase();
    }
  } catch { /* no checksums we can use — fall through to "none published" */ }
  return null;
}

/* `checking: true` from the start, because the window opens before the check
   can answer and the page cannot otherwise tell "no update" from "not looked
   yet". Every field the page reads lives here; nothing about it is on disk. */
let updateStatus = {
  version: readAppVersion(),
  checkedAt: null,
  checking: !SKIP_UPDATE_CHECK,
  latest: null,
  updateAvailable: false,
  pending: null,
  justUpdated: null,
  desktop: true,
  /* Whether this release has an installer this platform/arch can run. When
     it does the page offers Download; when it does not it falls back to the
     release page, which is the only honest thing left to offer. */
  canInstall: false,
  releaseUrl: null,
  download: { state: "idle", received: 0, total: 0, error: null }
};

/* Everything about the release the page must never see: where to download
   from, and what was downloaded. Kept out of updateStatus so that no future
   edit can widen the /update-status.json response into a list of URLs and
   absolute paths. */
let updateAsset = null;      /* {name, url, size} for this platform */
let updateAssets = [];       /* the release's full asset list, for checksums */
let updateFile = null;       /* absolute path of the verified installer */
let updateDownloadPromise = null;

function updateDir() {
  return path.join(app.getPath("userData"), "updates");
}

/* Every change the page could care about, pushed rather than polled: the
   check finishes after the page has already loaded and read the status once,
   so without this a fresh launch showed a stale verdict until the next one. */
function broadcastUpdateStatus() {
  for (const tab of tabs.values()) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    try { tab.view.webContents.send("splitpage:update-status", updateStatus); } catch { /* going away */ }
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
    /* Only for a release that is actually newer: picking an asset for the
       version already installed would offer a "download" that reinstalls it. */
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

/* Download the installer for this machine into userData/updates, verifying
   size and (when the release publishes one) sha256 before it counts as
   ready. Nothing is executed here — see runUpdateInstaller. */
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
    /* The whole folder, every time: a half-written file from an interrupted
       run, or the installer for a version that has since been superseded, is
       never what should be executed next. */
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    /* asset.name passed SAFE_ASSET_NAME and basename, but the path it
       produced is still confirmed to be inside the folder it must be in. */
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
      /* Streamed rather than buffered: an installer is tens of megabytes and
         holding it in memory to write it out again costs that twice for
         nothing. The hash is computed on the way past, so verification does
         not mean reading the file back either.

         getReader() rather than `for await (… of res.body)`: this Response
         comes from Chromium's network stack, and async iteration over a
         ReadableStream is a Node addition rather than part of the web stream
         API. The reader is what both implementations have. */
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        await handle.write(buf);
        received += buf.length;
        /* Throttled: a progress event per chunk is thousands of IPC messages
           and a page that spends the download re-rendering one line of text. */
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
    if (published && published !== digest) {
      throw new Error("the download does not match the checksum published for it");
    }

    updateFile = target;
    setDownloadState({ state: "ready", error: null, verified: !!published });
    return { ok: true, state: "ready" };
  })().catch(async (err) => {
    updateFile = null;
    /* A failed download must not be left on disk: it is the one file this app
       is willing to execute, and "ready" is the only state that lets it. */
    await fsp.rm(updateDir(), { recursive: true, force: true }).catch(() => {});
    setDownloadState({ state: "failed", error: err.message });
    return { ok: false, error: "download-failed", message: err.message };
  }).finally(() => { updateDownloadPromise = null; });

  return updateDownloadPromise;
}

/* THE INSTALLER STARTS ONLY IF THE QUIT ACTUALLY HAPPENS. A quit can be
   refused — unsaved work in any tab, or the stop-sharing prompt under --host
   (invariant #44) — and starting the installer first would leave it rewriting
   the files of an app the user just chose to keep using. So the order is:
   ask to quit, and spawn from 'will-quit', which Electron emits only once
   every window has really closed. If the quit is refused, nothing was
   started and the offer goes back up. */
let installOnQuit = false;
let installQuitWatcher = null;

/* The spawn itself. The path is this process's own record of a file it
   downloaded and verified — never anything the renderer said. */
function startInstallerNow() {
  try {
    if (process.platform === "win32") {
      /* Detached, with its own stdio: the installer outlives this process by
         design, and a child sharing our handles would be killed with us.
         An argument array with no arguments in it, so nothing is parsed. */
      const child = spawn(updateFile, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
    } else {
      /* macOS .dmg and Linux .AppImage cannot install themselves: hand the
         verified file to the OS, which mounts or opens it. Still no link and
         no manual download — the file is already here. */
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
  /* A test run must never install anything, and must never quit the machine's
     real app to do it (invariant #33). */
  if (TEST_MODE) return Promise.resolve({ ok: true, testMode: true });

  installOnQuit = true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    installQuitWatcher = done;
    app.quit();
    /* Still here? Then something refused the quit. Put the offer back rather
       than leaving the page on "Starting the installer…" forever. */
    setTimeout(() => {
      if (settled) return;
      installOnQuit = false;
      installQuitWatcher = null;
      setDownloadState({ state: "ready" });
      done({ ok: false, error: "quit-cancelled" });
    }, 3000);
  });
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

    /* --- splitpage://tabstrip/* : the tab strip's own origin (invariant
       #43). Chrome, not a document: three static files and nothing else.
       /api/* is not special-cased here, so it falls through to the 404
       below — the strip has no proxy to the document server, no bridge and
       no auto-granted permissions, which is the whole point of giving it a
       second origin rather than a page inside splitpage://app. */
    if (url.hostname === "tabstrip") {
      const stripEntry = TABSTRIP_ALLOWLIST[pathname === "/" ? "/index.html" : pathname];
      if (!stripEntry) return new Response("not found", { status: 404 });
      const stripPath = path.join(TABSTRIP_ROOT, stripEntry.file);
      /* Belt-and-suspenders containment check, as for APP_ROOT below: the
         file name is a fixed literal from the table, never request text. */
      if (!stripPath.startsWith(TABSTRIP_ROOT)) return new Response("not found", { status: 404 });
      try {
        const buf = await fsp.readFile(stripPath);
        return new Response(buf, { status: 200, headers: { "content-type": stripEntry.type } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    /* Any host other than 'app' (and the 'tabstrip' handled above) is not a
       thing this app serves. Answering 404 rather than falling through keeps
       a typo'd or forged host from reaching the /api proxy below. */
    if (url.hostname !== "app") return new Response("not found", { status: 404 });

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
    ? { color: "#16130F", symbolColor: "#E8E2D4", height: TITLEBAR_H }
    : { color: "#F6F4EC", symbolColor: "#2A2620", height: TITLEBAR_H };
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

/* ---- window creation -------------------------------------------------
 *
 * EVERY window the tab shell owns is built here, and only here (invariant
 * #42). One construction site is also what keeps a test run invisible: the
 * show:false / skipTaskbar / never-focus rules live in one place instead of
 * being re-derived at each call (invariant #33).
 *
 * `restoreSpec` is {windowId?, bounds?, maximized?} — from desktop-state v2
 * at launch, from a tear-off's drop point, or absent for a plain new window.
 */
function createTabWindow(restoreSpec) {
  const spec = restoreSpec || {};
  const saved = boundsIfVisible(normalizeBounds(spec.bounds)) || (windowsById.size ? null : savedBoundsIfVisible());
  const iconPath = app.isPackaged ? undefined : path.join(APP_ROOT, "installer", "icon.ico");

  const win = new BrowserWindow({
    width: saved ? saved.width : 1400,
    height: saved ? saved.height : 900,
    x: saved ? saved.x : (typeof spec.x === "number" ? spec.x : undefined),
    y: saved ? saved.y : (typeof spec.y === "number" ? spec.y : undefined),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: backgroundColorForTheme(),
    show: false,
    /* test runs stay invisible: see TEST_MODE */
    skipTaskbar: TEST_MODE,
    title: "Splitpage",
    icon: iconPath,
    /* The tab strip IS the title bar (TAB-IDENTITY). titleBarOverlay leaves
       the OS's own caption buttons drawn on top at the right; tabstrip.js
       asks navigator.windowControlsOverlay how much room they take so a tab
       is never drawn underneath them. */
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
  /* In TEST_MODE no window is ever shown, so 'focus' never fires and
     BrowserWindow.getFocusedWindow() is always null — the menu and every
     routing decision would have no window to target. Seeding this at
     creation gives them one without showing anything. */
  if (lastFocusedWindowId === null) lastFocusedWindowId = windowId;

  /* maximize() also SHOWS a hidden window, so it is skipped in test runs */
  if (rec.maximized && saved && !TEST_MODE) win.maximize();

  win.once("ready-to-show", () => { if (!TEST_MODE) win.show(); });

  win.loadURL("splitpage://tabstrip/index.html");

  /* The strip may not open windows or navigate anywhere at all: it is the
     one page in the app with no reason to leave its own three files. */
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

  /* --- unsaved changes: THE MAIN PROCESS IS THE SOLE AUTHORITY, not the
     page's own beforeunload handler (src/js/21-events.js). Chromium only
     honours a beforeunload block after the page has had USER ACTIVATION —
     a click, a keypress — in this session. A document that became dirty
     with no gesture at all (applyStashedWork merging a stash at load, a
     resumed/merged project, an OS-opened file the app marks dirty on open)
     never gets that activation, so relying on 'will-prevent-unload' meant
     such a window closed SILENTLY, with no prompt, losing the work. This
     handler asks the TabRecords instead, which splitpage:set-document-state
     keeps current on every markDirty()/clearDirty() (see setSaveButtons() in
     src/js/12-dirty-toast.js, invariant #20), before Chromium's own
     beforeunload negotiation ever runs.

     The dialog itself is scoped to THIS window's tabs (CLOSE-QUIT-LIFECYCLE):
     one 2-button question for a single unsaved tab, one 3-button
     Review/Close-without-saving/Cancel listing all of them for two or more.
     A quit that has already asked stands down here instead of asking again,
     and so does a Windows sign-out, which must never prompt. --- */
  win.on("close", (event) => {
    if (quitConfirmed || sessionEnding) {
      /* Decided elsewhere (before-quit, or the OS ending the session). Mark
         it confirmed so the beforeunload round trip that can follow does not
         ask its own question on the way out. */
      closeConfirmedWindows.add(win);
      return;
    }
    if (closeConfirmedWindows.has(win)) return; // already decided this attempt

    const isLastWindow = liveWindows().length <= 1;

    /* Order matters: hosting first, then unsaved. Someone who cancels the
       stop-sharing question never sees a second dialog about work they were
       not about to lose. */
    if (HOSTING && isLastWindow && !hostingConfirmed) {
      if (!askHostingPrompt(win)) { event.preventDefault(); return; }
    }

    const unsaved = unsavedTabsOf(rec.tabIds);
    if (unsaved.length) {
      const decision = buildUnsavedDialog(unsaved, "Close window", win);
      if (decision === "cancel") { event.preventDefault(); return; }
      if (decision === "review") { reviewFirstUnsaved(unsaved); event.preventDefault(); return; }
    }

    /* The close is going through. Drafts are settled BEFORE any view is
       destroyed, and the hosting question is now answered for this quit. */
    settleDraftsForClose(rec.tabIds, true, "close-without-saving");
    if (HOSTING && isLastWindow) hostingConfirmed = true;

    /* THE LAST WINDOW FREEZES THE SESSION FILE before its tabs are destroyed
       (invariant #44). Otherwise the 'closed' handler below would persist a
       shell with no windows in it and the next launch would restore nothing.
       A NON-last window deliberately does not freeze: removing exactly its
       tabs from v2 is the whole point of closing one window of several. */
    if (isLastWindow) sessionWritesFrozen = true;

    closeConfirmedWindows.add(win);
  });

  /* Windows is signing the user out or shutting down. There is no time for a
     dialog and no decision to record: nothing is prompted and NOTHING is
     discarded (invariant #40). Each tab is asked to flush whatever it has;
     the drafts are then the record of the session, and session.json says
     'session-end' so the next launch knows this was not a crash. */
  win.on("session-end", () => {
    if (sessionEnding) return;
    sessionEnding = true;
    sessionWritesFrozen = true;
    if (draftStore) { try { draftStore.markSessionEnd(); } catch { /* disk is going away too */ } }
    /* Every tab at once, each bounded by the same 1.5 s budget: they write in
       parallel, so the whole flush costs one budget rather than one per tab.
       Nothing is awaited on the way out — 'session-end' cannot be held open —
       the budget is what stops main from holding requests (and the pages'
       replies) forever if the OS takes the process down mid-write. */
    const flushes = [];
    for (const tab of tabs.values()) {
      if (tab.view.webContents.isDestroyed()) continue;
      flushes.push(requestDraftFlush(tab, DRAFT_FLUSH_BUDGET_MS));
    }
    Promise.all(flushes).then((results) => {
      if (!TEST_MODE) return;
      const ok = results.filter((r) => r && r.ok).length;
      process.stderr.write(`[splitpage] session-end flush: ${ok}/${results.length} tabs answered\n`);
    });
  });

  win.on("closed", () => {
    clearTimeout(rec.boundsSaveTimer);
    /* Its views go with it: a WebContentsView whose window is gone is not
       reachable any more, and leaving its tabId in the registries would let
       "already open" answer yes for a document nothing can show. */
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

/* --tunnel is the one window that is NOT a tab window: it shows another
   machine's server content over ssh, gets no bridge (preload.js refuses any
   origin but splitpage://app) and no auto-granted permissions, and holds no
   Splitpage document at all — so it has no tab identity, no strip and no
   place in desktop-state.json. */
function createTunnelWindow() {
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

/* ---- tabs ------------------------------------------------------------ */

function firstWindowRecord() {
  const it = windowsById.values().next();
  return it.done ? null : it.value;
}

function windowRecordFor(windowId) {
  return windowsById.get(windowId) || (lastFocusedWindowId ? windowsById.get(lastFocusedWindowId) : null) || firstWindowRecord();
}

/* Claims a routing key for a tab unless a DIFFERENT LIVE tab already holds
   it. "Is this already open?" (invariant #36) is answered by the FIRST tab to
   claim a path or a server document, and silently taking the key from a live
   tab is what made that answer wrong: the robbed tab kept editing a document
   routing no longer knew about, an OS-open of that file raised the thief
   instead, and closing the thief deleted the key outright — so the next open
   of a file that was never closed made a THIRD tab. A stale entry (the tab it
   names is gone) is simply taken over. Returns whether the key is now this
   tab's. */
function claimRoutingKey(map, key, tabId) {
  const owner = map.get(key);
  if (owner && owner !== tabId && tabs.has(owner)) return false;
  map.set(key, tabId);
  return true;
}

function indexTabSource(tab) {
  if (tab.source.kind === "file") claimRoutingKey(pathToTabId, pathKey(tab.source.absPath), tab.id);
  if (tab.source.kind === "server") claimRoutingKey(serverDocIdToTabId, tab.source.serverDocId, tab.id);
}

function unindexTabSource(tab) {
  for (const [key, id] of pathToTabId) if (id === tab.id) pathToTabId.delete(key);
  for (const [key, id] of serverDocIdToTabId) if (id === tab.id) serverDocIdToTabId.delete(key);
}

/* Sends the launch's one "could not restore" notice to `tab` and forgets it.
   Exactly once per launch, whichever tab ends up carrying it. */
function deliverRestoreNotice(tab) {
  if (!pendingRestoreNotice || !tab || tab.view.webContents.isDestroyed()) return;
  const notice = pendingRestoreNotice;
  pendingRestoreNotice = null;
  try { tab.view.webContents.send("splitpage:restore-notice", { skipped: notice.skipped }); }
  catch { /* the page went away between the decision and the send */ }
}

/* The notice is addressed to one tab, and that tab can be gone before its
   page ever reports ready: the window becomes interactive as soon as the
   lightweight strip page loads, which is well before a document page
   finishes booting, so its × is live and the strip is already populated from
   main's own state. Re-address the notice instead of letting it fall on the
   floor — it is the only time the user is told a remembered document could
   not be restored. A tab that is already ready gets it immediately; there is
   no second renderer-ready coming for it. */
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

/* Drops every trace of a tab from the registries. Does NOT touch the view:
   callers either already destroyed it (destroyTabView) or are handling a
   window that took its views down with it. */
function forgetTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  unindexTabSource(tab);
  webContentsIdToTabId.delete(tab.webContentsId);
  tabs.delete(tabId);
  const w = windowsById.get(tab.windowId);
  if (w) {
    const i = w.tabIds.indexOf(tabId);
    if (i !== -1) w.tabIds.splice(i, 1);
    /* The neighbour that took its place becomes active, or the one before it
       if it was the last. Math.max(0, …) covers the case where the tab was
       already out of the strip order — then "the first tab" is the only
       sensible answer, and tabIds[-1] would silently make activeTabId
       undefined instead. */
    if (w.activeTabId === tabId) {
      w.activeTabId = w.tabIds.length ? w.tabIds[Math.max(0, Math.min(i, w.tabIds.length - 1))] : null;
    }
  }
  /* After the neighbour has taken over, so the notice follows the tab the
     user is actually looking at. */
  historyHolds.delete(tab.webContentsId);
  retargetRestoreNotice(tabId, w);
}

/* opts: {source, launchIntent, tabId?, pendingPayload?, index?} */
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
      /* a view that is never shown would otherwise have its timers and rAF
         throttled like a background tab, and the tests drive it live */
      backgroundThrottling: !TEST_MODE
    }
  });

  const tab = {
    id: tabId,
    windowId,
    view,
    webContentsId: view.webContents.id,
    source: normalizeTabSource(o.source),
    fileId: null,
    title: "",
    dirty: false,
    /* Until the page reports otherwise a tab counts as pristine, which is
       what lets a file handed to us by the OS land in a brand-new blank tab
       instead of opening a second one next to it. The renderer starts
       reporting `pristine` for real in step F3; until then main only ever
       hears {title, dirty}, and "unknown" has to mean "as it was". */
    pristine: true,
    docId: null,
    serverKey: null,
    launchIntent: o.launchIntent || { type: "blank" },
    ready: false,
    pendingPayload: o.pendingPayload || null,
    /* Timestamps of the crash reloads this tab has been given, trimmed to
       the last CRASH_RELOAD_WINDOW_MS — the crash-loop guard. */
    reloadTimes: [],
    /* Set when a renderer died and was past the reload limit (or its window
       was already going). Such a tab has no page left: closing it neither
       prompts nor discards, and it never counts as unsaved. */
    crashedNotReloaded: false,
    /* Exactly one tab per process is the first one created (TAB-BOOT-SYNC);
       the renderer uses it to run once-per-launch work (the onboarding tour)
       in one page rather than in every tab that happens to open. */
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

/* The per-view handlers, identical in intent to the ones the single-window
   build put on its BrowserWindow's webContents. */
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

  /* The narrower safety net for reload/navigation, where no close event
     fires at all, and for the rare case a dirty report hasn't reached main
     yet. closeConfirmed* keeps it from asking a question already answered —
     and so do quitConfirmed/sessionEnding, which mean the one question this
     quit is allowed (invariant #44) has already been asked somewhere else. */
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

  /* A page that closes ITSELF (window.close()) destroys only its own
     WebContents now that a tab is a view rather than a window — the window
     and its other tabs are untouched, and nothing else would ever notice.
     This is the one place that hears about it. It is deliberately NOT
     guarded by a prompt: that matches the single-window build exactly (see
     HANDOFF §3.13, "Closing a window from inside the page is not a user
     close" — Chromium settles beforeunload itself with no activation and
     tears the page down without asking), and nothing in src/js calls
     window.close(). Keep it that way. */
  /* THE RENDERER DIED (a Chromium crash, an OOM kill, "Aw, Snap"). The work
     the page was holding is gone from memory; only its crash draft can bring
     it back, so the FIRST thing that happens is a hold — the draft on disk
     must not be rotated out by any later write until the reloaded page has
     restored it or the user has decided (invariant #40). A tab with NO draft
     has nothing to protect and must not be held: nothing would ever release
     it (only draft-restore-done does, and a page with no draft to restore
     never sends one), so the tab would count as unsaved — prompting on close
     and refusing every draft write as HELD — for the rest of the session.

     Then the tab is reloaded, at most CRASH_RELOAD_MAX times per
     CRASH_RELOAD_WINDOW_MS, so a page that crashes on the very content it is
     restoring cannot spin forever. The reload re-arms the pending payload
     from the tab's own source: launchIntentFor() answers 'restore-draft'
     while a draft exists, but once that draft is gone the next boot has to
     be told what document this tab is showing all over again. */
  contents.on("render-process-gone", (_event, details) => {
    if (details && details.reason === "clean-exit") return;
    if (!tabs.has(tabId)) return;
    if (draftStore && draftsHasDraft(tabId)) {
      try { draftStore.hold(tabId); } catch { /* store unusable */ }
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
    /* Armed, not necessarily delivered: flushPendingPayload holds it back
       while this tab still has a draft, so the reload restores the crash
       draft rather than overwriting it with the file on disk. */
    tab.pendingPayload = payloadForSource(tab.source);
    try { contents.reload(); } catch { tab.crashedNotReloaded = true; }
  });

  /* A navigation (the crash reload above, or a plain one) starts a brand-new
     page: its draft seq counter restarts at zero, and writes still queued
     from the page that is going away must not land on top of the new one's. */
  contents.on("did-navigate", () => {
    if (!tabs.has(tabId)) return;
    tab.ready = false;
    if (draftStore) { try { draftStore.resetSeq(tabId); } catch { /* store unusable */ } }
  });

  contents.on("destroyed", () => {
    if (!tabs.has(tabId)) return; // we tore it down ourselves; already forgotten
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

/* Takes the view down for good. The 'destroyed' handler above sees the tab
   is already forgotten and stays out of the way. */
function destroyTabView(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const w = windowsById.get(tab.windowId);
  forgetTab(tabId);
  closeConfirmedTabViews.add(tab.view);
  try {
    if (w && !w.win.isDestroyed()) w.win.contentView.removeChildView(tab.view);
  } catch { /* the window is already on its way out */ }
  try {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  } catch { /* already gone */ }
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
  /* Never focus() in a test run: focus is what would pull a window that is
     deliberately hidden onto this machine's screen (invariant #33). */
  if (!TEST_MODE) {
    try { tab.view.webContents.focus(); } catch { /* not attached yet */ }
  }
  pushShellState(w.id);
}

function applyWindowTitle(w) {
  if (!w || w.win.isDestroyed()) return;
  const tab = tabs.get(w.activeTabId);
  const title = (tab && tab.title) || "Untitled";
  /* A tab whose renderer died past the reload budget has no page left, and
     main itself has decided it never counts as unsaved (tabIsUnsaved,
     settleDraftsForClose): closing it neither prompts nor discards. Leaving
     the bullet — and setDocumentEdited — on the last dirty flag it reported
     would promise a confirmation that will not come. */
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
    /* a maximized window keeps the restored bounds it had before */
    if (!w.maximized) w.bounds = w.win.getBounds();
    persistShellState();
  }, 400);
}

/* ---- the strip's view of the shell (TABSTRIP-BRIDGE ShellState) ------- */

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
        /* The dirty dot means exactly one thing to a reader: "closing this
           will ask you first". A tab whose renderer died past the reload
           budget closes with no prompt at all (tabIsUnsaved excludes it), so
           its last reported dirty flag must not keep showing the dot — and
           `crashed` says what IS true about it instead of leaving it looking
           like any other clean tab. */
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
  try { w.win.webContents.send("splitpage:tabstrip-state", shellStateForWindow(windowId)); } catch { /* strip not loaded yet */ }
}

/* ---- routing: "is this already open, and where should it land?" ------- */

function deliverOpenFile(tab, absPath) {
  const id = registerPath(absPath);
  readFileEntry(id, absPath).then((entry) => {
    if (tab.view.webContents.isDestroyed()) return;
    tab.fileId = id;
    tab.view.webContents.send("splitpage:open-file", entry);
  }).catch(() => { /* file vanished between the decision and the read */ });
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

function routeOpenServerDoc(serverDocId, opts) {
  const o = opts || {};
  if (typeof serverDocId !== "string" || !serverDocId) return null;

  const existingId = serverDocIdToTabId.get(serverDocId);
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
    target.source = { kind: "server", serverDocId };
    indexTabSource(target);
    if (!target.view.webContents.isDestroyed()) {
      target.view.webContents.send("splitpage:open-server-doc", { serverDocId });
    }
    activateTab(target.id);
    persistShellState();
    return { where: "this-tab", tabId: target.id };
  }

  const created = createTab(w.id, {
    source: { kind: "server", serverDocId },
    launchIntent: { type: "open-server" },
    pendingPayload: { kind: "open-server", serverDocId }
  });
  return created ? { where: "new-tab", tabId: created.id } : null;
}

/* ---- tab moves: reorder, move between windows, tear off --------------- */

function reorderTab(tabId, index) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  const w = windowsById.get(tab.windowId);
  if (!w) return false;
  const from = w.tabIds.indexOf(tabId);
  if (from === -1) return false;
  w.tabIds.splice(from, 1);
  /* The caller's index is in the PRE-drop order, so a move to the right has
     to account for the tab it just removed from in front of the target. */
  const to = Math.max(0, Math.min(from < index ? index - 1 : index, w.tabIds.length));
  w.tabIds.splice(to, 0, tabId);
  pushShellState(w.id);
  persistShellState();
  return true;
}

/* Re-parents the VIEW — never re-creates it (invariant #42): the page keeps
   its undo history, its unsaved edits and its tabId. */
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

  try { from.win.contentView.removeChildView(tab.view); } catch { /* already detached */ }
  to.win.contentView.addChildView(tab.view);

  tab.windowId = to.id;
  const at = typeof index === "number" ? Math.max(0, Math.min(index, to.tabIds.length)) : to.tabIds.length;
  to.tabIds.splice(at, 0, tabId);

  if (!from.tabIds.length && !from.win.isDestroyed()) {
    /* An emptied source window has nothing left to ask about — its unsaved
       work moved with the view, it was not discarded. */
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
  if (from.tabIds.length <= 1) return false; // tearing off the only tab is a no-op
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

/* ---- close and quit (contract CLOSE-QUIT-LIFECYCLE) -------------------
 *
 * THE ONE RULE THIS SECTION EXISTS FOR: one close gesture asks at most one
 * unsaved-changes question, and a discard only ever happens because the
 * person said so (invariants #40 and #44). Windows close one at a time
 * during a quit, so without a single authority a five-tab quit would stack
 * five dialogs, and a Windows sign-out — which asks nothing and must destroy
 * nothing — would look exactly like a close.
 */

function liveWindows() {
  return [...windowsById.values()].filter((w) => w.win && !w.win.isDestroyed());
}

function unsavedTabsOf(tabIds) {
  const out = [];
  for (const id of tabIds) {
    const tab = tabs.get(id);
    if (tabIsUnsaved(tab)) out.push(tab);
  }
  return out;
}

/* Every tab in the app, in window-creation order then strip order — the
   order a quit's single dialog lists them in. */
function allTabsInOrder() {
  const out = [];
  for (const w of windowsById.values()) for (const id of w.tabIds) if (tabs.has(id)) out.push(id);
  return out;
}

/* A dirty tab names itself. A HELD tab may never have reported a title at
   all — its page crashed, or this launch has not restored it yet — so the
   title comes from the draft header on disk instead of showing "Untitled"
   for work the user would recognise by name. */
function unsavedTitles(list) {
  let listing = null;
  return list.map((tab) => {
    if (tab.title) return tab.title;
    if (!listing) listing = draftsList();
    const found = listing.find((d) => d.tabId === tab.id);
    return (found && found.title) || "Untitled";
  });
}

/* CLOSE-QUIT-LIFECYCLE's buildUnsavedDialog(tabs, verb) -> 'review' |
   'discard' | 'cancel'. verb is 'Close tab', 'Close window' or 'Quit'.
   SPLITPAGE_TEST_DIALOGS is consulted FIRST and shares one cursor with every
   other dialog in the process (see testDialogAnswers): 'confirm' = leave
   without saving, 'cancel' = stay, 'review' = show me the tabs.

   A SINGLE unsaved tab keeps the two-button dialog the app has always shown
   — Review means "take me to the tab", which is where you already are. Two
   or more get the three-button dialog listing all of them. */
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

/* Review = show me what I am about to lose: the first unsaved tab becomes
   active, and the close is cancelled so the person can look at it. */
function reviewFirstUnsaved(list) {
  const first = list[0];
  if (!first || !tabs.has(first.id)) return;
  activateTab(first.id);
  /* focusWindow() is a no-op in TEST_MODE by design — a review must not pull
     a deliberately hidden test window onto this machine's screen (#33). */
  focusWindow(first.windowId);
}

/* The stop-sharing prompt (main.js's original text). Asked at most once per
   quit: at before-quit, or at the close of the LAST remaining window,
   whichever runs first. Never for a non-last window — the other windows are
   still serving, so closing one stops nothing. */
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

/* Everything a decided close has to do to the draft store, in the order
   CLOSE-QUIT-LIFECYCLE requires: the discard runs BEFORE any view is
   destroyed or the quit proceeds, and a tab that had nothing unsaved has its
   draft cleaned up rather than left to be "recovered" next launch. */
function settleDraftsForClose(tabIds, discardUnsaved, reason) {
  const unsaved = [];
  const clean = [];
  for (const id of tabIds) {
    const tab = tabs.get(id);
    if (!tab) continue;
    if (tab.crashedNotReloaded) continue; // no page, no decision: the draft stays
    if (tabIsUnsaved(tab)) unsaved.push(id); else clean.push(id);
  }
  if (discardUnsaved && unsaved.length) draftsDiscardForUserDecision(unsaved, reason);
  for (const id of clean) draftsDiscardClean(id);
}

/* The Ctrl+W / strip-× / middle-click / __testRequestCloseTab path. */
function requestCloseTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const w = windowsById.get(tab.windowId);
  if (w && w.tabIds.length === 1) {
    /* The last tab of a window: closing it IS closing the window, so let
       the window's own close handler ask (once) rather than asking twice. */
    if (!w.win.isDestroyed()) w.win.close();
    return;
  }
  if (tabIsUnsaved(tab)) {
    const decision = buildUnsavedDialog([tab], "Close tab", w ? w.win : undefined);
    if (decision === "cancel") return;
    if (decision === "review") { reviewFirstUnsaved([tab]); return; }
  }
  settleDraftsForClose([tabId], true, "leave-without-saving");
  destroyTabView(tabId);
}

function cycleTab(windowId, delta) {
  const w = windowsById.get(windowId);
  if (!w || w.tabIds.length < 2) return;
  const i = w.tabIds.indexOf(w.activeTabId);
  const next = w.tabIds[((i === -1 ? 0 : i) + delta + w.tabIds.length) % w.tabIds.length];
  activateTab(next);
}

/* ---------------------------------------------------------------------
 * 12. Opening files the OS hands us.
 *
 *     There is no process-wide "pending files" queue any more: a file is
 *     routed to a tab the moment it arrives, and the per-tab pendingPayload
 *     holds it until that tab's renderer says it is ready.
 * --------------------------------------------------------------------- */

function focusWindow(windowId) {
  const w = windowsById.get(windowId);
  if (!w || w.win.isDestroyed()) return;
  lastFocusedWindowId = windowId;
  if (TEST_MODE) return; /* restore()/show()/focus() would surface a test window */
  if (w.win.isMinimized()) w.win.restore();
  w.win.show();
  w.win.focus();
}

/* What a tab of this source has to be handed to show its document again, or
   null for a blank one. One place, because three call sites need the same
   answer: a tab created at launch, a tab reloaded after its renderer died,
   and a draft tab whose restore reported it could not read the draft. */
function payloadForSource(source) {
  if (!source) return null;
  if (source.kind === "file") return { kind: "open-file", absPath: source.absPath };
  if (source.kind === "server") return { kind: "open-server", serverDocId: source.serverDocId };
  return null;
}

/* Hands a tab whatever it was created to open, once its renderer has
   registered its onOpenFile callback (splitpage:renderer-ready).

   opts.force skips the crash-draft gate below. Only the draft-restore-done
   handler passes it, and only for a restore that failed outright. */
function flushPendingPayload(tab, opts) {
  const payload = tab.pendingPayload;
  if (!payload) return;
  /* A TAB THAT IS STILL RESTORING A CRASH DRAFT IS NOT HANDED ITS DOCUMENT.
     Both paths adopt state, and the open-file — read fresh from disk — lands
     last: it replaced the recovered work with the last saved version of the
     file, and the now-"clean" tab then discarded the draft that held it
     (invariant #40). So the payload is KEPT, not delivered and not dropped,
     and splitpage:draft-restore-done decides: dropped once the restore
     adopted a document, flushed only when the restore reported 'failed' —
     the corrupt/unreadable draft, which is the one case where the tab would
     otherwise sit there empty over a file that reads perfectly well.
     draftsHasDraft is the same predicate launchIntentFor answers
     'restore-draft' from, so the two can never disagree about which boot
     this is. */
  if (!(opts && opts.force) && draftsHasDraft(tab.id)) return;
  tab.pendingPayload = null;
  if (payload.kind === "open-file") {
    deliverOpenFile(tab, payload.absPath);
  } else if (payload.kind === "open-server" && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.send("splitpage:open-server-doc", { serverDocId: payload.serverDocId });
  }
}

/* ---- restoring last session at launch --------------------------------
 *
 * The session is whatever desktop-state.json v2 says PLUS whatever the draft
 * store still holds, and the two disagree on purpose:
 *
 *   - v2 is written while the app runs, so it knows the windows, the strip
 *     order and which document each tab was showing;
 *   - the drafts are written by the tabs themselves, so after a crash they
 *     are the only record of work that was never saved to a file.
 *
 * A tab with a draft therefore ALWAYS comes back, held, whatever v2 thinks
 * its source was, and its file path is indexed before argv is routed so that
 * double-clicking that same file switches to the recovered tab instead of
 * opening a second copy of a document whose newest version is the draft.
 */

function draftSourceFromListing(listing) {
  const origin = (listing.header && listing.header.origin) || null;
  if (listing.filePath) return { kind: "file", absPath: listing.filePath };
  if (origin && origin.server && typeof origin.server.docId === "string" && origin.server.docId) {
    return { kind: "server", serverDocId: origin.server.docId };
  }
  return { kind: "blank" };
}

/* A held tab answers "is this file already open?" even though the file has
   not been read: its draft IS that document right now. */
function indexDraftPath(tabId, filePath) {
  if (typeof filePath !== "string" || !filePath || !path.isAbsolute(filePath)) return;
  /* Two drafts can name one file (the user had two copies of the same
     document open when the app died). First claim wins, same as every other
     source index — see claimRoutingKey. */
  claimRoutingKey(pathToTabId, pathKey(filePath), tabId);
}

function restoreSessionAtLaunch(draftInit) {
  /* Read BEFORE anything is written back, and read only once: the file on
     disk is still the previous session at this point, and hadPriorSession
     has to be answered from it (TAB-BOOT-SYNC). */
  const persisted = readDesktopStateV2();
  const drafts = (draftInit && Array.isArray(draftInit.drafts) ? draftInit.drafts : draftsList())
    .filter((d) => d && d.status !== "unsupported");
  const draftByTab = new Map(drafts.map((d) => [d.tabId, d]));
  hadPriorSession = persisted.windows.some((w) => w.tabs.some((t) => t.source.kind !== "blank"))
    || drafts.length > 0;

  /* Documents named in v2 that are no longer on disk. Reported once, to one
     tab, rather than as a dialog nobody asked for (invariant #33's spirit:
     a launch never puts a modal in front of anyone). */
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
          /* Unsaved work outranks everything: the tab comes back with its own
             id (which is the draft's folder name), boots as 'restore-draft'
             and is HELD so no later write can rotate the draft out before the
             page has restored it (invariant #40). The file is deliberately
             NOT opened here — step K's draft-take reads it, compares it with
             the draft's base and decides what the tab should show. */
          const source = pt.source.kind === "blank" ? draftSourceFromListing(listing) : pt.source;
          const tab = createTab(rec.id, {
            tabId: pt.tabId,
            source,
            launchIntent: { type: "restore-draft" },
            /* The fallback, held back by flushPendingPayload for as long as
               the draft exists and delivered only if the restore reports
               'failed'. Without it a draft that cannot be READ (a torn write,
               or an antivirus/sync client holding both generations open —
               listingFor says 'corrupt') brought the tab back as an empty
               untitled document: nothing ever opened its file, the renderer
               then reported no fileId, and set-document-state rewrote the
               source to blank, so the path was dropped from desktop-state.json
               and the document was gone from the session for good. */
            pendingPayload: payloadForSource(source)
          });
          if (!tab) continue;
          if (draftStore) { try { draftStore.hold(tab.id); } catch { /* store unusable */ } }
          indexDraftPath(tab.id, listing.filePath);
          placed.add(tab.id);
          continue;
        }

        if (pt.source.kind === "file") {
          let exists = false;
          try { exists = fs.statSync(pt.source.absPath).isFile(); } catch { exists = false; }
          if (!exists) {
            /* Renamed, deleted, or on a drive that is not mounted yet. There
               is nothing to restore and nothing was lost — the file is
               wherever the user put it — so the tab is dropped and named. */
            skipped.push({ name: path.basename(pt.source.absPath), reason: "missing" });
            continue;
          }
          const tab = createTab(rec.id, {
            tabId: pt.tabId,
            source: pt.source,
            launchIntent: { type: "open-file" },
            /* registerPath happens at flush, not now: an id handed out here
               would be live for a tab that may never ask for it. */
            pendingPayload: { kind: "open-file", absPath: pt.source.absPath }
          });
          if (tab) placed.add(tab.id);
          continue;
        }

        if (pt.source.kind === "server") {
          /* A server that is not reachable at relaunch is not probed here
             (the main process has no session and no PIN): the tab opens and
             its own renderer reports the failure through a toast. */
          const tab = createTab(rec.id, {
            tabId: pt.tabId,
            source: pt.source,
            launchIntent: { type: "open-server" },
            pendingPayload: { kind: "open-server", serverDocId: pt.source.serverDocId }
          });
          if (tab) placed.add(tab.id);
          continue;
        }

        /* A blank tab with no draft has nothing to restore: dropped. */
      }
    }

    /* Drafts whose tab is in no window of v2 — the session file was frozen
       before that tab reached it, or the crash beat the write. The header's
       placement says where it used to live; anything else goes to window 1. */
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
        /* Same fallback as the v2 draft tabs above, for the same reason. */
        pendingPayload: payloadForSource(orphanSource),
        index
      });
      if (!tab) continue;
      if (draftStore) { try { draftStore.hold(tab.id); } catch { /* store unusable */ } }
      indexDraftPath(tab.id, listing.filePath);
      placed.add(tab.id);
    }

    /* No windows at all (a fresh install, or every tab skipped and every
       window with it) still means one window with one blank document. */
    if (!windowsById.size) createTabWindow({});
    /* A window left with nothing — every tab blank, or every file gone —
       opens with one blank document, keeping the id of the blank tab it had
       so that a tabId is stable across a relaunch even for a never-saved
       tab (and so its draft folder, if it ever gets one, is the same). */
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

    /* The tab that was in front last time comes back in front. createTab
       activated each tab as it was added, so this is the correction. */
    for (const { rec, pw } of built) {
      if (!windowsById.has(rec.id) || !rec.tabIds.length) continue;
      activateTab(rec.tabIds.includes(pw.activeTabId) ? pw.activeTabId : rec.tabIds[0]);
    }
  } finally {
    sessionRestoreInProgress = false;
  }

  /* ONLY NOW is argv routed: every restored tab is in pathToTabId, so a file
     the OS handed us that is already open — including one that is only open
     as a recovered draft — switches to that tab instead of opening twice. */
  for (const f of argvFilesToOpen) routeLaunchFile(f);

  if (skipped.length) {
    const first = firstWindowRecord();
    if (first && first.activeTabId) pendingRestoreNotice = { tabId: first.activeTabId, skipped };
  }

  /* One write, publishing the whole restored session at once. */
  persistShellState();
}

/* A file named on the command line at launch. routeOpenPath's "reuse this
   tab" rule needs a tab whose renderer has already reported itself pristine
   and ready, which no tab is microseconds after it was created — so a
   brand-new blank tab is adopted directly here rather than left empty next
   to a second tab holding the file the user actually double-clicked. */
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

/* A menu command is always meant for the document the user is looking at,
   which is the ACTIVE TAB of the focused window — never the window's own
   webContents, which is the tab strip and has no document at all. In a test
   run nothing is ever focused, so lastFocusedWindowId (seeded when a window
   is created) is what keeps this working there. The tunnel window is not a
   tab window and gets menu commands directly; it is the only exception. */
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

/* The Tab menu's own commands, which act on the shell rather than on a
   document, so they never travel to a renderer at all. */
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
      {
        label: "New Tab",
        accelerator: "CmdOrCtrl+T",
        click: () => {
          const w = focusedWindowRecord();
          if (w) createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
        }
      },
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

  /* Real accelerators, not display-only ones: src/js has no keydown handler
     for T, W or Tab (21-events.js intercepts Ctrl/Cmd+F, and Tab only inside
     a tag-autocomplete cell, which is not a bare Ctrl+Tab), so nothing in
     the page loses a keystroke to these. */
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

/* The tab strip is a SECOND privileged origin (invariant #43), and its own
   trust check is deliberately separate from isTrustedSender above: neither
   origin can reach the other's handlers. The URL prefix alone is not enough
   — it also has to be a window's OWN primary webContents, so a strip page
   somehow loaded into a view or an iframe would still pass no shell command. */
function isTrustedTabStripSender(event) {
  const url = event.senderFrame && event.senderFrame.url;
  if (typeof url !== "string" || !url.startsWith("splitpage://tabstrip/")) return false;
  for (const w of windowsById.values()) {
    if (!w.win.isDestroyed() && w.win.webContents === event.sender) return true;
  }
  return false;
}

/* The strip's sender, as a WindowRecord. */
function tabStripWindowOf(event) {
  for (const w of windowsById.values()) {
    if (!w.win.isDestroyed() && w.win.webContents === event.sender) return w;
  }
  return null;
}

/* Every tab-page handler starts here: the page never names itself, main
   looks its sender up. A sender with no TabRecord (the tunnel window, a
   view already torn down) simply gets null and the handler does nothing. */
function tabOf(event) {
  const tabId = webContentsIdToTabId.get(event.sender.id);
  return tabId ? tabs.get(tabId) || null : null;
}

/* The BrowserWindow to parent a native dialog on. BrowserWindow.fromWebContents
   returns null for a WebContentsView's contents, so a tab has to be mapped
   back to its window through the registry instead. */
function dialogParentFor(event) {
  const tab = tabOf(event);
  if (tab) {
    const w = windowsById.get(tab.windowId);
    if (w && !w.win.isDestroyed()) return w.win;
  }
  return BrowserWindow.fromWebContents(event.sender) || undefined;
}

/* TAB-BOOT-SYNC. Recomputed on every call, never cached: a tab that was
   created to open a file has already had that payload flushed by the time a
   reload asks again, and must then boot as a blank page rather than wait for
   a file that is not coming. */
function launchIntentFor(tab) {
  if (draftsHasDraft(tab.id)) return { type: "restore-draft" };
  if (tab.source.kind === "file" && tab.pendingPayload) return { type: "open-file" };
  if (tab.source.kind === "server") return { type: "open-server" };
  return { type: "blank" };
}

function registerIpc() {
  ipcMain.handle("splitpage:open-file-dialog", async (event) => {
    requireTrusted(event);
    const answer = consumeTestDialogAnswer();
    let chosen;
    if (answer !== undefined) {
      chosen = answer; // absolute path string, or null for "cancelled"
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

  ipcMain.handle("splitpage:save-file-dialog", async (event, options) => {
    requireTrusted(event);
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
    /* Save As onto a file ANOTHER live tab is editing is refused here, before
       anything is written. Letting it through made two tabs live editors of
       one document: each save overwrote the other's, each wrote its own
       document id into the file so its version history forked, and DOC-CLAIMS
       could not help — those are two different documents that merely landed
       on one path, not a duplicated id. Main is the authority on what is open
       (invariant #42), so it is the side that has to say no. A refusal reads
       to the renderer exactly like a cancelled dialog, which is the one
       answer every caller of this channel already handles; the reason is said
       out loud in a native message box rather than swallowed. */
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
      } catch { /* no window to parent it on: the refusal still stands */ }
      return null;
    }
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

  /* splitpage:get-last-file / splitpage:set-last-file removed in F3: each
     tab now learns what to open through TAB-BOOT-SYNC at load (launchIntent),
     and a document source change reaches main through
     splitpage:set-document-state instead of a dedicated "remember this"
     call — one report, not two paths that can drift apart. */

  ipcMain.handle("splitpage:get-session-info", async (event) => {
    requireTrusted(event);
    return {
      library: LIBRARY,
      hosting: HOSTING,
      port: documentServerPort,
      lanUrls: HOSTING && documentServerPort
        ? lanAddresses().map((addr) => `http://${addr}:${documentServerPort}/`)
        : [],
      pin: JOIN_PIN || "",
      testDialogsSeen: TEST_MODE ? testDialogsSeen : undefined
    };
  });

  /* Synchronous: preload reads this once, at load time, to build the plain
     `appVersion` string property on window.splitpageDesktop (not a
     promise — see the bridge contract). */
  ipcMain.on("splitpage:get-app-version-sync", (event) => {
    event.returnValue = isTrustedSender(event) ? app.getVersion() : null;
  });

  /* TAB-BOOT-SYNC. Synchronous for the same reason appVersion is: preload
     reads it ONCE, at load time, and the renderer's boot sequence needs the
     answer before it decides what to do — well before any IPC round trip
     could return. It replaces splitpage:has-file-to-open-sync, which could
     only answer one process-wide question ("did argv name a file?") and had
     no way to say WHICH page that file was for.

     It carries no path and no server document id: the renderer is told what
     KIND of boot this is and nothing more, so a compromised page learns
     nothing about the file system from it (invariant #34). */
  ipcMain.on("splitpage:tab-boot-sync", (event) => {
    if (!isTrustedSender(event)) { event.returnValue = null; return; }
    const tab = tabOf(event);
    if (!tab) { event.returnValue = null; return; }
    const intent = launchIntentFor(tab);
    tab.launchIntent = intent;
    const hasDraftToRestore = intent.type === "restore-draft";
    /* Holding means "this tab's crash draft must not be rotated out until
       the page has restored it or the user has decided" (invariant #40).
       Nothing can hold until step F2 creates the store. */
    if (draftStore) {
      if (hasDraftToRestore) {
        try { draftStore.hold(tab.id); } catch { /* store not usable; F2 owns the reporting */ }
      } else if (draftsIsHeld(tab.id)) {
        /* Nothing to restore, so nothing to hold. A hold taken when this tab's
           renderer died, over a draft that has since gone (the tab was clean,
           or the user threw the draft away), would otherwise outlive the draft
           it was protecting: nothing sends draft-restore-done on a boot with
           no draft, so the tab would count as unsaved and refuse every draft
           write for the rest of the session. Guarded by isHeld rather than
           released unconditionally so a boot does not mint a store record for
           every tab that never had a draft. */
        try { draftStore.release(tab.id); } catch { /* store not usable */ }
      }
    }
    event.returnValue = {
      tabId: tab.id,
      windowId: tab.windowId,
      launchIntent: intent,
      hadPriorSession,
      firstTabOfLaunch: tab.firstTabOfLaunch === true,
      hasDraftToRestore
    };
  });

  ipcMain.on("splitpage:open-external", (event, url) => {
    if (!isTrustedSender(event)) return;
    if (typeof url === "string" && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });

  /* ---- updates -------------------------------------------------------
     Three calls, none of which takes an argument. That is the contract:
     the page can ask what the situation is, ask for the download to start,
     and ask for what was downloaded to be run — it cannot say WHAT to
     download or WHAT to run. See section 9. */

  ipcMain.handle("splitpage:update-status", async (event) => {
    requireTrusted(event);
    return updateStatus;
  });

  /* Re-run the check on demand, for the case the launch check found nothing
     because the machine was offline at the time. */
  ipcMain.handle("splitpage:update-check", async (event) => {
    requireTrusted(event);
    if (SKIP_UPDATE_CHECK) return updateStatus;
    setUpdateStatus({ checking: true });
    await checkForUpdate();
    return updateStatus;
  });

  ipcMain.handle("splitpage:update-download", async (event) => {
    requireTrusted(event);
    return downloadUpdate();
  });

  ipcMain.handle("splitpage:update-install", async (event) => {
    requireTrusted(event);
    return runUpdateInstaller();
  });

  /* The TabRecord is main's copy of what the page is showing, and it is the
     authority every close, routing and strip decision reads (invariant #42).
     It must be current the instant the page reports, which is why this is a
     send and not an invoke, and why nothing here returns early before the
     record is updated. */
  ipcMain.on("splitpage:set-document-state", (event, docState) => {
    if (!isTrustedSender(event)) return;
    const tab = tabOf(event);
    if (!tab) return;
    const s = docState || {};

    tab.title = typeof s.title === "string" && s.title ? s.title.slice(0, LAST_KNOWN_TITLE_MAX) : "Untitled";
    tab.dirty = !!s.dirty;
    /* `pristine` and `docId` are read as "absent means unchanged", never
       "false"/"null": a reported-as-false pristine would make every tab look
       like it already held a document and send the next OS-opened file to a
       new tab. 20f-desktop.js's notifyDesktopDocumentState (step F3) sends
       all five fields on every report, so in practice these are always
       present — the guard just means a partial report from anywhere else
       can never regress a field it didn't mean to touch. */
    if ("pristine" in s) tab.pristine = !!s.pristine;
    if ("docId" in s) tab.docId = typeof s.docId === "string" ? s.docId : null;

    /* fileId and serverKey follow the same "absent means unchanged" rule as
       pristine and docId, for the same reason. Reading an absent serverKey
       as null would tear down the source of a tab that IS showing a server
       document — dropping it out of serverDocIdToTabId and letting the same
       document open a second time.

       A fileId is an opaque registry key, never a path (invariant #34): main
       is the only side that can turn one back into a path. */
    const hasFileId = "fileId" in s;
    const hasServerKey = "serverKey" in s;
    const absPath = hasFileId && typeof s.fileId === "string" ? fileRegistry.get(s.fileId) || null : null;
    if (hasServerKey) tab.serverKey = typeof s.serverKey === "string" && s.serverKey ? s.serverKey : null;
    if (hasFileId) tab.fileId = absPath ? s.fileId : null;
    if (hasFileId || hasServerKey) {
      unindexTabSource(tab);
      if (tab.serverKey) tab.source = { kind: "server", serverDocId: tab.serverKey };
      else if (absPath) tab.source = { kind: "file", absPath };
      /* Both reported and both empty is the one honest "this tab holds no
         document any more" (New document, or a server document closed). */
      else if (hasFileId && hasServerKey) tab.source = { kind: "blank" };
      indexTabSource(tab);
    }

    const w = windowsById.get(tab.windowId);
    if (w) {
      /* Only the ACTIVE tab names the OS window: a background tab going
         dirty must not rewrite the title of the document on screen. */
      if (w.activeTabId === tab.id) applyWindowTitle(w);
      pushShellState(w.id);
    }
    persistShellState();
    /* The duplicate-document-id claim (DOC-CLAIMS) runs from here, in its own
       try/catch, so a claim failure can never cost the title update above.
       It runs LAST rather than next to `tab.dirty` because it reads the docId,
       the fileId and the serverKey this handler has just reconciled — from the
       TabRecord, which is main's authority, never from the raw payload. */
    try { recordDocClaim(event.sender, tab); }
    catch (err) { if (TEST_MODE) console.error("[splitpage-test] doc claim failed", err); }
  });

  ipcMain.on("splitpage:renderer-ready", (event) => {
    if (!isTrustedSender(event)) return;
    const tab = tabOf(event);
    if (!tab) return;
    tab.ready = true;
    flushPendingPayload(tab);
    /* The launch's one restore notice, delivered as soon as there is a page
       listening for it — sending it any earlier would simply be dropped. */
    if (pendingRestoreNotice && pendingRestoreNotice.tabId === tab.id) deliverRestoreNotice(tab);
  });

  /* DOCUMENT-STATE-AND-ROUTING-IPC. The renderer asks "open this", main
     decides WHERE — this tab, a tab that already has it, or a new one — and
     answers with which of the three happened so the page can tell the user. */
  ipcMain.handle("splitpage:route-open", async (event, payload) => {
    requireTrusted(event);
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
      const result = routeOpenServerDoc(String(p.serverDocId || ""), { fromWindowId: tab.windowId, fromTabId: tab.id });
      if (!result) throw new Error("could not route that server document");
      return { where: result.where };
    }
    throw new Error("route-open: unknown kind");
  });

  /* ---- crash drafts (DRAFT-IPC-AND-SHAPES) ---------------------------

     The tab a call belongs to is looked up from the sender, never named by
     the payload: a page can only ever write, discard or take ITS OWN draft,
     and a sender with no TabRecord gets NO_TAB.

     These answer with a value rather than rejecting. A draft write is a
     background safety net: the renderer's job on a refusal is to back off and
     tell the user crash recovery is paused, which it can only do if it gets a
     code back (WriteResult in DRAFT-STORE). An exception would reach it as an
     opaque rejection with no code to act on. */

  /* The store missing entirely (an unwritable userData at launch) is reported
     as EIO — a disk-side failure the renderer already knows how to back off
     from — rather than inventing a code no contract lists. */
  const DRAFT_STORE_DOWN = { ok: false, code: "EIO" };

  ipcMain.handle("splitpage:draft-write", async (event, payload) => {
    requireTrusted(event);
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
    /* The header is BUILT here, from validated scalars only — see the
       allowlist in section 4b. Nothing of the payload reaches disk unread. */
    return await draftStore.write(tab.id, buildDraftHeader(tab, p), p.stateJson, baseJson, seq);
  });

  /* "This tab is clean at seq N": the crash draft has nothing left to protect.
     The store refuses while the tab is held, which is right — a held tab's
     "clean" may only mean its draft has not been loaded yet (invariant #40). */
  ipcMain.handle("splitpage:draft-discard", async (event, payload) => {
    requireTrusted(event);
    const tab = tabOf(event);
    if (!tab) return { ok: false, code: "NO_TAB" };
    if (!draftStore) return DRAFT_STORE_DOWN;
    const seq = draftFiniteNumber(payload && payload.seq);
    if (seq === null) return { ok: false, code: "BAD_PAYLOAD" };
    return await draftStore.discardClean(tab.id, seq);
  });

  /* The restore side. take() never deletes anything: the draft stays on disk
     until the page reports what it did with it (draft-restore-done) or the
     user throws it away, so a restore that dies halfway can start again at
     the next launch (invariant #40). */
  ipcMain.handle("splitpage:draft-take", async (event) => {
    requireTrusted(event);
    const tab = tabOf(event);
    if (!tab || !draftStore) return null;
    const taken = await draftStore.take(tab.id);
    if (!taken || taken.corrupt || taken.unsupported) return taken || null;

    /* The file the draft was taken from is read HERE, from the path in the
       header main itself wrote — the renderer never sees that path, it gets
       the same FileEntry any other open produces. Reading it is what lets the
       restore compare the draft's base against what is on disk NOW, which is
       the whole of invariant #41: content decides, never mtime. */
    const origin = (taken.header && taken.header.origin) || null;
    const filePath = origin && origin.kind === "file" && typeof origin.filePath === "string" ? origin.filePath : "";
    taken.file = null;
    taken.fileProblem = null;
    if (filePath) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
          /* Something is there but it is not a document (a folder took the
             name, a device node): not "gone", not readable either. */
          taken.fileProblem = "unreadable";
        } else {
          const id = registerPath(filePath);
          taken.file = await readFileEntry(id, filePath);
          /* The tab is now known to hold this file: the id it can use to
             write back, the source the strip and routing read, and the path
             index that stops a second copy of the same document opening. */
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
    /* ageMs and previousSession come from the store (take() stamps both);
       fill previousSession in from this launch's own answer if an older
       store ever stops doing so, so the renderer's "was this a crash?"
       question always has an answer. */
    if (typeof taken.previousSession !== "string") taken.previousSession = draftsPreviousSession;
    if (!("ageMs" in taken)) taken.ageMs = null;
    return taken;
  });

  /* The page has finished with the draft it took. Anything but 'failed'
     releases the hold and lets writes rotate the draft again; 'failed' keeps
     it, so every later write of this tab is refused as HELD and the
     unrestored work survives to the next launch (DRAFT-STORE). */
  ipcMain.on("splitpage:draft-restore-done", (event, payload) => {
    if (!isTrustedSender(event)) return;
    const tab = tabOf(event);
    if (!tab || !draftStore) return;
    const outcome = payload && typeof payload.outcome === "string" ? payload.outcome : "";
    if (outcome === "failed") {
      /* Nothing was adopted — the draft could not be read. The hold stays
         (the unrestored work has to survive to the next launch), but the tab
         must not be left as an empty page over a file that is perfectly
         readable: this is the one outcome that gets the document payload
         restoreSessionAtLaunch armed for exactly this moment. */
      flushPendingPayload(tab, { force: true });
      return;
    }
    try { draftStore.release(tab.id); } catch { /* store unusable */ }
    /* The restore adopted a document. The payload held back for it is now
       not merely unnecessary but dangerous: delivering the file at this point
       would replace the recovered work with the last saved version, and the
       tab would then read as clean and discard the draft. */
    tab.pendingPayload = null;
  });

  /* The reply to splitpage:draft-flush. Matched by reqId: a reply whose
     request has already been given up on resolves nothing at all. */
  ipcMain.on("splitpage:draft-flushed", (event, reqId, result) => {
    if (!isTrustedSender(event)) return;
    const resolve = pendingDraftFlushes.get(reqId);
    if (!resolve) return;
    pendingDraftFlushes.delete(reqId);
    resolve(result && typeof result === "object" ? result : { ok: false });
  });

  /* ---- version history (HISTORY-IPC) ---------------------------------

     Every channel is requireTrusted, so only splitpage://app — a document
     page — reaches them; the tab strip, on its own origin, gets nothing.

     An invalid docId, snapshot id or body REJECTS the invoke rather than
     answering {ok:false}: those are not conditions the renderer can recover
     from by retrying, they mean the call itself was malformed, and the
     desktop backend in 03a-history-store.js turns a rejection into code
     'invalid' so the entry is dropped instead of being kept pending in RAM
     for the life of the page. Everything that a retry COULD fix — a full
     disk, an I/O error, a read-only folder, a body over the limit — comes
     back as a value. */

  const historyDocIdArg = (v) => {
    if (typeof v !== "string" || !DOC_ID_RE.test(v)) throw new Error("history: invalid document id");
    return v;
  };

  ipcMain.handle("splitpage:history-put", async (event, docId, meta, stateJson, protect) => {
    requireTrusted(event);
    historyDocIdArg(docId);
    const clean = sanitizeHistoryMeta(meta);
    if (!clean) throw new Error("history: invalid snapshot meta");
    if (typeof stateJson !== "string") throw new Error("history: invalid snapshot body");
    /* `protect` is not in HISTORY-IPC's original argument list; orchestrator
       override §2b adds it. Without it a desktop restore from Older can evict
       the very snapshot it is restoring, because the "Before restoring"
       backup's own write is what triggers the eviction.

       The list is REMEMBERED for this sender, not just used for this call:
       the eviction that deletes tab A's snapshot is far more likely to be
       triggered by tab B's save, a history-copy or the expired-Older sweep
       than by A's own put. Each report replaces the last, which is what
       protectHistorySnapshot's release() is: the page sends its current holds
       with every put. */
    const held = historyProtectList(protect);
    historyHolds.set(event.sender.id, held);
    return historyExclusive(() => historyPutLocked(docId, clean, stateJson, held));
  });

  ipcMain.handle("splitpage:history-list", async (event, docId) => {
    requireTrusted(event);
    /* null is "just the Older bucket, please" — the panel asks for it on a
       document that has no id yet. Anything else must be a real docId. */
    const id = docId == null ? null : historyDocIdArg(docId);
    return historyExclusive(() => historyListLocked(id));
  });

  ipcMain.handle("splitpage:history-get", async (event, query, snapshotId) => {
    requireTrusted(event);
    const q = query || {};
    /* The Older bucket is reachable ONLY through older:true. A file claiming
       docId "_older" fails DOC_ID_RE and never gets near it (invariant #38). */
    const bucket = q.older === true ? HISTORY_OLDER_KEY : historyDocIdArg(q.docId);
    if (typeof snapshotId !== "string" || !HISTORY_SNAP_ID_RE.test(snapshotId)) {
      throw new Error("history: invalid snapshot id");
    }
    /* A restore takes its hold and READS first; the "Before restoring" backup
       that carries the same list on splitpage:history-put comes afterwards.
       Recording the holds here is what protects the snapshot in between —
       the window in which another tab's save, a copy or the expired-Older
       sweep could evict it. The register is replaced by each report and
       dropped with the tab, so a page that stops reporting over-protects one
       snapshot at worst. */
    if (Array.isArray(q.protect)) historyHolds.set(event.sender.id, historyProtectList(q.protect));
    return historyExclusive(() => readHistorySnapshotFile(bucket, snapshotId));
  });

  ipcMain.handle("splitpage:history-copy", async (event, fromDocId, toDocId) => {
    requireTrusted(event);
    historyDocIdArg(fromDocId);
    historyDocIdArg(toDocId);
    if (fromDocId === toDocId) return { ok: true, copied: 0 };
    return historyExclusive(() => historyCopyLocked(fromDocId, toDocId));
  });

  ipcMain.handle("splitpage:history-touch", async (event, docId, title) => {
    requireTrusted(event);
    historyDocIdArg(docId);
    await historyExclusive(() => historyTouchLocked(docId, title));
  });

  ipcMain.handle("splitpage:history-import-older", async (event, entries) => {
    requireTrusted(event);
    if (!Array.isArray(entries)) throw new Error("history: invalid import");
    return historyExclusive(() => historyImportOlderLocked(entries));
  });

  ipcMain.handle("splitpage:history-usage", async (event) => {
    requireTrusted(event);
    return historyExclusive(() => historyUsageLocked());
  });

  /* ---- the tab strip's channels (TABSTRIP-BRIDGE) --------------------
     A separate origin with its own trust check, and deliberately nothing
     else: no file, draft or history handler accepts a strip sender, and
     isTrustedSender (splitpage://app/ only) is what keeps it that way. */

  ipcMain.on("splitpage:tabstrip-window-id-sync", (event) => {
    const w = isTrustedTabStripSender(event) ? tabStripWindowOf(event) : null;
    event.returnValue = w ? w.id : null;
  });

  ipcMain.handle("splitpage:tabstrip-get-state", async (event) => {
    if (!isTrustedTabStripSender(event)) throw new Error("untrusted sender");
    const w = tabStripWindowOf(event);
    return w ? shellStateForWindow(w.id) : null;
  });

  /* Every strip command validates its tabId as 32 hex AND as a tab that
     actually exists — a strip page can otherwise name any string it likes. */
  const stripTab = (event, tabId) => {
    if (!isTrustedTabStripSender(event)) return null;
    if (typeof tabId !== "string" || !TAB_OR_WINDOW_ID_RE.test(tabId)) return null;
    return tabs.get(tabId) || null;
  };

  ipcMain.on("splitpage:tabstrip-new-tab", (event) => {
    const w = isTrustedTabStripSender(event) ? tabStripWindowOf(event) : null;
    if (w) createTab(w.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
  });

  ipcMain.on("splitpage:tabstrip-activate", (event, tabId) => {
    const tab = stripTab(event, tabId);
    if (tab) activateTab(tab.id);
  });

  ipcMain.on("splitpage:tabstrip-close", (event, tabId) => {
    const tab = stripTab(event, tabId);
    if (tab) requestCloseTab(tab.id);
  });

  ipcMain.on("splitpage:tabstrip-reorder", (event, tabId, index) => {
    const tab = stripTab(event, tabId);
    if (tab && Number.isInteger(index)) reorderTab(tab.id, index);
  });

  ipcMain.on("splitpage:tabstrip-move-here", (event, tabId, dropIndex) => {
    const tab = stripTab(event, tabId);
    const w = tab ? tabStripWindowOf(event) : null;
    if (tab && w) moveTabToWindow(tab.id, w.id, Number.isInteger(dropIndex) ? dropIndex : undefined);
  });

  ipcMain.on("splitpage:tabstrip-tear-off", (event, tabId, screenX, screenY) => {
    const tab = stripTab(event, tabId);
    if (tab) tearOffToNewWindow(tab.id, Number(screenX), Number(screenY));
  });

  /* Synchronous, same pattern as get-app-version-sync/tab-boot-sync above:
     preload reads this once, at load time, to decide whether to
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
      const tab = tabOf(event);
      const w = tab ? windowsById.get(tab.windowId) : null;
      const win = w ? w.win : BrowserWindow.fromWebContents(event.sender);
      if (win && !win.isDestroyed()) win.close();
    });

    /* The Ctrl+W path for the calling tab, so a test can close ONE tab of a
       window without going near the window itself. */
    ipcMain.on("splitpage:test-request-close-tab", (event) => {
      if (!isTrustedSender(event)) return;
      const tab = tabOf(event);
      if (tab) requestCloseTab(tab.id);
    });

    /* The File > Exit path (role: "quit" below calls this same app.quit()).
       Quitting with a dirty window still has to prompt — app.quit() asks
       every open BrowserWindow to close first, which fires the same
       win.on('close') this whole fix is about. */
    ipcMain.on("splitpage:test-request-quit", (event) => {
      if (!isTrustedSender(event)) return;
      app.quit();
    });

    /* What the draft store thinks of a tab, for desktop/test/smoke.mjs: a
       smoke case can prove a write landed, a hold is in force or a discard
       left a tombstone without reading the folder out from under the process
       that owns it. The optional tabId argument (contract: none) lets a case
       ask about ANOTHER tab of the same run — the driving page cannot be the
       crashed one it wants to look at — and can name only a tab that exists.
       TEST_MODE only, like every hook in this block. */
    ipcMain.handle("splitpage:test-draft-status", async (event, tabId) => {
      requireTrusted(event);
      const named = typeof tabId === "string" && TAB_OR_WINDOW_ID_RE.test(tabId) ? tabs.get(tabId) : null;
      const tab = named || tabOf(event);
      const id = tab ? tab.id : null;
      if (draftStore && id) {
        try { return draftStore.status(id); } catch { /* fall through to the blank answer */ }
      }
      return {
        tabId: id, hasDraft: false, held: false, lastSeq: null, tombstoned: false,
        previousSession: draftsPreviousSession, writes: 0, failures: 0
      };
    });

    /* Kills this tab's renderer the way a real crash does (no 'clean-exit'
       reason), so a smoke case can drive main's render-process-gone path —
       the hold, the reload, the crash-loop guard — instead of describing it.
       The page dies without unloading, which is exactly the point: whatever
       it had not written is gone, and only its draft can bring it back. */
    ipcMain.on("splitpage:test-crash-renderer", (event) => {
      if (!isTrustedSender(event)) return;
      event.sender.forcefullyCrashRenderer();
    });

    /* The eviction planner, straight through, on a fixture the test supplies
       — no disk, no folder, no state of this process at all. It exists so
       caseHistoryPlannerTwin can prove main's line-for-line copy of
       planHistoryEviction still answers exactly what the renderer's original
       does: two copies of a policy stay honest only if something compares
       them. TEST_MODE only, like every hook in this block. */
    ipcMain.handle("splitpage:test-history-plan", async (event, fixture) => {
      requireTrusted(event);
      const f = fixture || {};
      return planHistoryEviction(f.docs, f.capBytes, f.nowMs, f.opts);
    });

    /* chooseDuplicateLoser over two claims the test invents, answering 'a',
       'b' or null. Same shape of hook as the planner above, for the same
       reason: caseAtomicSaveKeepsBirthtime measures what this filesystem
       does to a saved file's birthtime, and then has to ask the real
       function whether it would have been fooled by it. Asking the function
       is the assertion — reading DUP_TRUST_BIRTHTIME out of the source would
       only prove a constant's spelling. */
    ipcMain.handle("splitpage:test-dup-loser", async (event, a, b) => {
      requireTrusted(event);
      const claim = (c) => ({
        docId: String((c && c.docId) || ""),
        homeKey: String((c && c.homeKey) || ""),
        seq: Number((c && c.seq) || 0),
        birthtimeMs: Number((c && c.birthtimeMs) || 0)
      });
      const ca = claim(a), cb = claim(b);
      const loser = chooseDuplicateLoser(ca, cb);
      return loser === ca ? "a" : loser === cb ? "b" : null;
    });

    /* The shell driver for desktop/test/smoke.mjs (SMOKE-HARNESS shell()).
       Tabs are created, moved and closed here through exactly the same
       functions the menu, the strip and drag-and-drop use, so a smoke case
       exercises the real paths rather than a test-only imitation of them —
       and it does it without a single real click, which is what keeps a run
       on this machine invisible (invariant #33). */
    ipcMain.handle("splitpage:test-shell", async (event, op, args) => {
      requireTrusted(event);
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
              path: t.source.kind === "file" ? t.source.absPath : null
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
        default:
          throw new Error("test-shell: unknown op " + op);
      }
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
  for (const f of files) routeOpenPath(f, { fromWindowId: lastFocusedWindowId });
  focusWindow(lastFocusedWindowId);
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    argvFilesToOpen.push(filePath); // startup 'open-file' arrives before whenReady on macOS
    return;
  }
  routeOpenPath(filePath, { fromWindowId: lastFocusedWindowId });
  focusWindow(lastFocusedWindowId);
});

app.setAppUserModelId("com.retrogorilla.splitpage");

app.whenReady().then(async () => {
  sweepDesktopStateTempFiles();
  /* Before any window exists: the first tab's boot sync asks hasDraft() as
     soon as its page loads, and init() is also what reads last session's
     state and finishes any discard whose delete did not complete. */
  const draftInit = initDraftStore();
  registerProtocol();
  registerIpc();
  buildMenu();

  /* Every window, not just one: the title-bar overlay draws the OS caption
     buttons itself, so a theme change has to repaint each window's overlay
     colours as well as its background or the buttons stay in the old theme. */
  nativeTheme.on("updated", () => {
    const overlay = titleBarOverlayColors();
    for (const w of windowsById.values()) {
      if (w.win.isDestroyed()) continue;
      w.win.setBackgroundColor(backgroundColorForTheme());
      try { w.win.setTitleBarOverlay(overlay); } catch { /* not a custom title bar on this platform */ }
    }
    if (tunnelWindow && !tunnelWindow.isDestroyed()) tunnelWindow.setBackgroundColor(backgroundColorForTheme());
  });

  /* Registered ONCE on the shared session rather than per window: with many
     windows and many views the per-window registration would add a listener
     for every one of them and fire the same handler that many times.
     The renderer routes every export through the bridge's saveFileDialog/
     writeFile; this only catches a stray download Electron itself decides to
     start (e.g. a data: URL it treats as a download instead of navigation),
     and just lets its native save dialog handle it rather than doing nothing. */
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
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

  if (TUNNEL_TARGET) {
    tunnelWindow = createTunnelWindow();
    return; // no tabs, no strip, no session persistence in tunnel mode
  }

  restoreSessionAtLaunch(draftInit);

  app.on("activate", () => {
    // macOS convention: closing the last window doesn't quit; re-create on dock click.
    if (BrowserWindow.getAllWindows().length === 0) {
      const fresh = createTabWindow({});
      createTab(fresh.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
    }
  });
});

/* THE ONE QUESTION A QUIT IS ALLOWED (invariant #44). Electron emits
   before-quit BEFORE it asks any window to close, which is the only moment
   at which every tab in the app is still alive and can be listed in a single
   dialog. Once this handler says yes, every window and tab close handler
   stands down (quitConfirmed) and the session file stops being written
   (sessionWritesFrozen) so that windows closing one by one cannot erase the
   set of windows the next launch is supposed to restore. */
app.on("before-quit", (event) => {
  if (sessionEnding) return;   // the OS is ending the session: never prompt
  if (quitConfirmed) return;   // already answered for this quit

  if (HOSTING && !hostingConfirmed) {
    const w = windowsById.get(lastFocusedWindowId) || firstWindowRecord();
    if (!askHostingPrompt(w && !w.win.isDestroyed() ? w.win : undefined)) {
      event.preventDefault();
      return;
    }
  }

  const tabIds = allTabsInOrder();
  const unsaved = unsavedTabsOf(tabIds);
  if (unsaved.length) {
    const w = windowsById.get(unsaved[0].windowId);
    const decision = buildUnsavedDialog(unsaved, "Quit", w && !w.win.isDestroyed() ? w.win : undefined);
    if (decision === "cancel" || decision === "review") {
      if (decision === "review") reviewFirstUnsaved(unsaved);
      /* Nothing was decided, so nothing stays decided: a later quit asks
         again, and the session file keeps recording changes in the meantime. */
      quitConfirmed = false;
      hostingConfirmed = false;
      sessionWritesFrozen = false;
      event.preventDefault();
      return;
    }
  }

  settleDraftsForClose(tabIds, true, "quit-without-saving");
  if (HOSTING) hostingConfirmed = true;
  quitConfirmed = true;
  sessionWritesFrozen = true;
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
  /* The quit was not refused, so a pending update install goes ahead now —
     see runUpdateInstaller. First thing in the handler: the whole point is
     that this app is really going, and the installer needs to be started
     before this process stops being able to start anything. */
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
  /* The app is really going, in one piece. Recording that is what lets the
     next launch tell "you quit" from "you were killed": a session.json still
     saying 'running' at startup means the previous run died, and its drafts
     are crash work rather than leftovers. It NEVER discards anything —
     quitting is not a decision to throw work away (invariant #40). */
  if (draftStore) { try { draftStore.markCleanExit(); } catch { /* nothing left to do about it */ } }
});

} // end single-instance-lock guard
