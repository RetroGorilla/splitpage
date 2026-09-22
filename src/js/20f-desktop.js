import { S } from "./_state.js";
import { home, serverHomeId } from "./_home.js";
import { escapeHtml } from "./02-state.js";
import { normalizeDocId, reassignDocId } from "./02b-doc-id.js";
import {
  HISTORY_OLDER_KEY,
  HISTORY_OLDER_TTL_MS,
  HISTORY_PER_DOC,
  HISTORY_SNAP_ID_RE,
  historyStampAfter,
  historyUtf8Length,
  isPristineSeedDocument,
  sanitizeHistoryMeta
} from "./03a-history-store.js";
import { cssAttr } from "./04-richtext.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { openServerDoc, serverToken } from "./13-hosted.js";
import { concatBytes, strBytes } from "./14-export.js";
import { mimeForFilename, openProjectFile } from "./18-local-files.js";
import { openServersDialog } from "./20e-connect.js";
import { draftRestorePending, flushDraftNow } from "./20g-drafts.js";

/* ================= desktop glue (Electron shell) =================

   Everything here is gated on DESKTOP (00-prelude.js) being non-null,
   which only happens on a document served from splitpage://app by the
   desktop shell's main process — see desktop/preload.js for the other
   half of that guarantee. When DESKTOP is null (the whole web build,
   including every suite in tests/) nothing in this file runs anything;
   every function below either returns immediately or is never called.

   The design goal throughout is "no second copy of the app's own logic":
   opening a file goes through openProjectFile() exactly the way File ▸
   Open already does; every native menu command reaches the SAME element
   the in-page File menu or header button would, by finding it and
   clicking it — real DOM clicks run every capture-phase listener several
   other fragments have already wired onto #file-menu (20c-help.js,
   20e-connect.js, 20b-onboarding.js), so this file needs no branch for
   "help" or "servers" or "setup" of its own. */

/* ---- a FileSystemFileHandle-shaped wrapper over the bridge ----

   openProjectFile(), saveDoc() and deliverFile() all already know how to
   drive a real FileSystemFileHandle (getFile/createWritable, see
   18-local-files.js and 14-export.js) — this is the same shape, built
   over DESKTOP.readFile/writeFile instead of the File System Access API,
   so none of that calling code needs to know which one it has. `entry`
   is either a full FileEntry (from openFileDialog/onOpenFile — carries
   bytes already, which getFile() below ignores in favor of a
   fresh read, so a handle is never stale the moment it's minted) or the
   smaller {id, name} a fresh saveFileDialog() pick returns before
   anything has been written to disk yet. */
export function makeDesktopHandle(entry) {
  var id = entry.id;
  var name = entry.name;
  var handle = {
    kind: "file",
    name: name,
    /* Not part of the FileSystemFileHandle shape — rememberLastFileHandle()
       (00-prelude.js) and isSameEntry() below read it directly, since the
       id IS the durable thing here, the way a real handle's own internal
       identity is for the browser API. */
    _desktopId: id,
    getFile: function () {
      return S.DESKTOP.readFile(id).then(function (fresh) {
        name = fresh.name || name;
        handle.name = name;
        var bytes = fresh.bytes instanceof Uint8Array ? fresh.bytes : new Uint8Array(fresh.bytes || []);
        return new File([bytes], name, { lastModified: fresh.lastModified, type: mimeForFilename(name) });
      });
    },
    /* write() buffers every chunk in order and does exactly one
       DESKTOP.writeFile() on close() — the bridge contract's write is
       whole-file and atomic (temp file + rename), so there is nothing to
       gain from streaming chunks across the IPC boundary one at a time,
       and buffering keeps this the same shape as a real
       FileSystemWritableFileStream from the caller's point of view. */
    createWritable: function () {
      var chunks = [];
      return Promise.resolve({
        write: function (chunk) {
          if (typeof chunk === "string") { chunks.push(strBytes(chunk)); return Promise.resolve(); }
          if (chunk instanceof Blob) {
            return chunk.arrayBuffer().then(function (buf) { chunks.push(new Uint8Array(buf)); });
          }
          if (chunk instanceof ArrayBuffer) { chunks.push(new Uint8Array(chunk)); return Promise.resolve(); }
          if (ArrayBuffer.isView(chunk)) {
            chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            return Promise.resolve();
          }
          chunks.push(strBytes(String(chunk)));
          return Promise.resolve();
        },
        close: function () {
          return S.DESKTOP.writeFile(id, concatBytes(chunks)).then(function () {});
        }
      });
    },
    queryPermission: function () { return Promise.resolve("granted"); },
    requestPermission: function () { return Promise.resolve("granted"); },
    isSameEntry: function (other) { return !!other && other._desktopId === id; }
  };
  return handle;
}

/* ---- window title / dirty-dot ----
   Called from setSaveButtons() (12-dirty-toast.js), the one place
   markDirty() and clearDirty() both funnel through (invariant #20).

   draftRestorePending is a step-K (20g-drafts.js) variable that does not
   exist yet — guarded with typeof so this file runs unchanged before that
   step lands. Once it does, a tab with a crash draft still being restored
   must never report itself dirty=false/pristine=true: main would treat it
   as a document with nothing to protect. */
export function notifyDesktopDocumentState() {
  if (!S.DESKTOP || !S.state) return;
  var restoring = typeof draftRestorePending !== "undefined" && draftRestorePending;
  S.DESKTOP.setDocumentState({
    title: S.state.title || "Untitled Script",
    dirty: !!S.dirty || restoring,
    pristine: (typeof isPristineSeedDocument === "function" && isPristineSeedDocument()) && !restoring,
    docId: S.state.docId || null,
    fileId: (home.kind === "file" && home.handle && home.handle._desktopId) || null,
    serverKey: serverHomeId()
  });
}

/* ---- the native menu / header-button dispatcher ----

   Every data-file-action the desktop menu can send maps to the actual
   <button data-file-action="..."> living inside #file-menu — clicking it
   for real runs the exact chain a mouse click would: the capture-phase
   listeners 20c-help.js/20e-connect.js/20b-onboarding.js each add to
   #file-menu for "help"/"tour"/"servers"/"setup" see it FIRST (exactly as
   they do for a real click) and, for everything else, it bubbles to
   18-local-files.js's handleFileMenuAction(). Nothing here duplicates
   that dispatch or needs updating when a new File-menu action is added —
   add the button to page.html with the right data-file-action and this
   keeps working. The header buttons (save/production/gear/comments/
   write/present) have no data attribute to key off, so those five are a
   small fixed map to their own ids instead. */
var DESKTOP_HEADER_BUTTONS = {
  "save": "btn-save",
  "toggle-production": "btn-production",
  "toggle-gear": "btn-gear",
  "toggle-comments": "btn-comments",
  "write": "btn-write",
  "present": "btn-present"
};

function runDesktopMenuCommand(cmd) {
  var btnId = DESKTOP_HEADER_BUTTONS[cmd];
  if (btnId) {
    var btn = document.getElementById(btnId);
    if (btn && !btn.disabled) btn.click();
    return;
  }
  var item = document.querySelector('#file-menu [data-file-action="' + cssAttr(cmd) + '"]');
  /* A disabled menu item (Save to file with nothing opened yet, etc.)
     staying inert here matches what a real click on it would do — the
     button itself refuses the click, not this dispatcher deciding for it. */
  if (item && !item.disabled) item.click();
  /* An unrecognized command from the native menu has nothing to run —
     the menu and this map are meant to agree, and a mismatch here (an
     older build's menu, say) should never take the app down over it. */
}

/* ---- Servers dialog: "you are sharing this session" ----

   What start.mjs used to print to the console window that launched it —
   the desktop app has no console, so this is that information's other
   home. Shown automatically once at boot when hosting (initDesktop()
   below) and reachable again any time from File ▸ Servers… (the one
   extra line in openServersDialog(), 20e-connect.js). Nothing here ever
   touches state, localStorage or anything the server hands out — the PIN
   lives only in this element's rendered text, for as long as it's on
   screen (invariant #29). */
export async function renderDesktopShareInfo() {
  var el = document.getElementById("desktop-share-info");
  if (!el || !S.DESKTOP) return;
  var info;
  try { info = await S.DESKTOP.getSessionInfo(); } catch (e) { info = null; }
  if (!info || !info.hosting) { el.hidden = true; el.innerHTML = ""; return; }
  var lanUrls = info.lanUrls || [];
  var addrs = lanUrls.length
    ? lanUrls.map(function (u) { return '<div class="connect-share-url">' + escapeHtml(u) + "</div>"; }).join("")
    : '<div class="modal-hint">No network address found yet — check this computer is on a network.</div>';
  var pinHtml;
  if (info.pin) {
    pinHtml = '<div class="connect-share-pin">Join PIN:<strong>' + escapeHtml(info.pin) + "</strong></div>" +
      '<p class="modal-hint">This code travels in the clear over plain HTTP — fine on your own ' +
      "network, not on a public one.</p>";
  } else {
    /* No PIN means server.js is running with authRequired:false — anyone
       who can reach one of the addresses above gets full read/write
       access with nothing to type in. Silently omitting this section
       (the old behavior) let that pass for "sharing", full stop, when it
       is actually the more dangerous of the two modes this dialog can be
       showing. Say so plainly rather than just leaving the PIN block out. */
    pinHtml = '<p class="modal-hint connect-share-nopin">No PIN — anyone who can reach one of ' +
      "these addresses can open and edit this document.</p>";
  }
  /* The read-and-comment-only half of the same session (issue #30). Shown
     only when this launch was given a review credential; the link carries
     this launch's key in its fragment, the code is for reading out. */
  var reviewHtml = "";
  if (info.reviewPin || (info.reviewUrls || []).length) {
    var reviewAddrs = (info.reviewUrls || []).map(function (u) {
      return '<div class="connect-share-url">' + escapeHtml(u) + "</div>";
    }).join("");
    reviewHtml = '<div class="connect-add-title">To read and comment only</div>' +
      '<p class="modal-hint">Send one of these instead — the server refuses every change ' +
      "but a comment, whatever their copy of Splitpage lets them click.</p>" + reviewAddrs +
      (info.reviewPin
        ? '<div class="connect-share-pin">Review PIN:<strong>' + escapeHtml(info.reviewPin) + "</strong></div>"
        : "");
  }
  el.innerHTML = '<div class="connect-add-title">Sharing this session</div>' +
    '<p class="modal-hint">Others on your network can open:</p>' + addrs + pinHtml + reviewHtml +
    '<p class="modal-hint">Closing Splitpage stops sharing.</p>';
  el.hidden = false;
}

/* Main has spotted that this document's identity is also claimed by a
   document open in another tab — two copies of one file, opened side by
   side — and has picked this tab as the one to re-id (DOC-CLAIMS). The
   typeof guard is for the fake backends the browser suites build: a bridge
   without this member simply never re-ids, which is what the browser build
   does anyway. reassignDocId validates all three fields again and refuses a
   message that no longer fits what is on screen.

   It is its own function, rather than four lines inside initDesktop, only
   because __desktopTest.setBackend has to be able to re-run it: initDesktop
   itself returns immediately in a browser suite (there is no bridge at
   boot), so swapping a fake in afterwards is the only moment this
   registration can happen there. */
function wireReassignDocId() {
  if (!S.DESKTOP || typeof S.DESKTOP.onReassignDocId !== "function") return;
  S.DESKTOP.onReassignDocId(function (msg) {
    if (!msg) return;
    /* REPORT THE NEW ID BACK. reassignDocId deliberately does not dirty the
       document or save it (override §1), and nothing else on that path
       reaches notifyDesktopDocumentState — so main's claim table went on
       saying this tab still held the OLD id until the user next dirtied or
       cleaned the document, which for a tab opened only to read is never.
       A stale claim is not inert: reopening the ORIGINAL file later
       compares it against that stale duplicate and re-ids the original, so
       the wrong file ends up carrying "this file is a copy of …" and its
       history forks. With the claim current the two ids simply differ and
       no duplicate is found at all. */
    if (reassignDocId(msg.toId, msg)) notifyDesktopDocumentState();
  });
}

/* ---- boot wiring ----
   Called once from init() (21-events.js), after every other listener in
   this build is already wired up. */
export function initDesktop() {
  if (!S.DESKTOP) return;

  /* Google Drive needs a real http/https origin for Google's own sign-in
     to redirect back to (Google Cloud Console has no "custom scheme"
     option for Authorized JavaScript origins) — splitpage://app cannot
     ever satisfy that, so the entry is hidden rather than left to open a
     modal whose Sign in button can only fail. openDriveModal()
     (13-hosted.js) carries the same guard defensively, in case something
     still reaches it directly. Google Doc import is different — it needs
     no OAuth at all (11-import.js's confirmGdocImport() explains why) and
     stays enabled, routed through DESKTOP.openExternal() instead of
     window.open(). */
  var driveItem = document.getElementById("menu-drive-open");
  if (driveItem) driveItem.hidden = true;

  /* App data (X1/X2, 20h-appdata.js) now travels both ways on desktop:
     DESKTOP.historyListDocs() lets exportHistoryAll() enumerate the
     on-disk history store the same way it walks IndexedDB in the browser,
     so Export app data… no longer needs to stay hidden here. Import stays
     visible too — the two sit side by side, same as the browser build. */
  var exportAppItem = document.getElementById("menu-export-app-data");
  if (exportAppItem) exportAppItem.hidden = false;
  var importAppItem = document.getElementById("menu-import-app-data");
  if (importAppItem) importAppItem.hidden = false;

  /* Files the OS hands us — argv at launch, a second instance, macOS
     "open-file" — open exactly the way File ▸ Open does: through
     openProjectFile(), with the same snapshot/dirty safety as any other
     open. The main process queues these until this callback is
     registered, then flushes them, so nothing launched before this line
     ran is lost. */
  S.DESKTOP.onOpenFile(function (entry) {
    function proceed() {
      var handle = makeDesktopHandle(entry);
      handle.getFile().then(function (file) {
        return openProjectFile(file, handle);
      }).catch(function () {
        showToast("Could not open " + ((entry && entry.name) || "that file") + ".", "error");
      });
    }
    /* The main process queues an open-file event until this callback is
       registered, then flushes it — which can mean it fires the instant
       the line above runs, well before init()'s own boot load
       (loadInitialState(), 21-events.js) has finished setting `state` for
       the first time. Opening straight away in that case would just get
       overwritten a moment later when the boot load resolves and assigns
       the seed/default state over it — wait for it first (00-prelude.js's
       initialStateReady) exactly like a launch double-clicking a project
       file should behave: the file wins, not whatever the app opens to
       by default. */
    if (S.state) proceed();
    else if (S.initialStateReady) S.initialStateReady.then(proceed);
    else proceed();
  });

  /* main routed an open into THIS tab (splitpage:route-open said
     'this-tab' or 'new-tab', or this tab is opening straight into a
     server document at launch — TAB-BOOT-SYNC's launchIntent 'open-
     server'). Same initialStateReady wait as onOpenFile above, so this
     never races the boot load's own assignment to `state`. */
  S.DESKTOP.onOpenServerDoc(function (payload) {
    var serverDocId = payload && payload.serverDocId;
    if (!serverDocId) return;
    function proceed() { openPendingServerDocForTab(serverDocId); }
    if (S.state) proceed();
    else if (S.initialStateReady) S.initialStateReady.then(proceed);
    else proceed();
  });

  /* A launch that skipped one or more remembered tabs (a missing file, an
     unreadable one, a server document whose server never answered) tells
     the user once, in the first window's active tab, rather than failing
     silently or interrupting every tab that was NOT affected. */
  S.DESKTOP.onRestoreNotice(function (notice) {
    var skipped = (notice && notice.skipped) || [];
    if (!skipped.length) return;
    var reasonWord = { missing: "missing", unreadable: "unreadable", "server-unreachable": "server unreachable" };
    var lines = skipped.map(function (s) {
      return (s.name || "a document") + " (" + (reasonWord[s.reason] || s.reason || "unknown") + ")";
    });
    showToast("Could not restore: " + lines.join(", ") + ".", "warn", true);
  });

  wireReassignDocId();

  S.DESKTOP.onMenuCommand(runDesktopMenuCommand);

  /* The main process asks for a crash draft to be brought up to date before
     it does anything that could end this page — a close, a quit, a tab
     moving to another window. flushDraftNow() (20g-drafts.js) answers with
     the write's own result, so main learns whether the work is safely on
     disk rather than assuming it. Guarded: the bridge member arrives with
     the draft IPC, and an older preload (or the browser build's fake
     backend before a test arms it) simply has no flush to register. */
  if (typeof S.DESKTOP.onDraftFlush === "function") S.DESKTOP.onDraftFlush(flushDraftNow);

  /* A fresh load never calls markDirty()/clearDirty() until a resume path
     runs or the reader types something — push the starting title now
     rather than leaving the window's default title showing indefinitely
     on an empty document. init()'s own loadInitialState().then() callback
     does the same once `state` exists on first load; this covers
     initDesktop() running before that promise resolves. */
  notifyDesktopDocumentState();

  /* Nobody printed the sharing address to a console the user can see —
     there isn't one — so the first time this launch is actually hosting
     anyone, say so once, unprompted. Reusing openServersDialog() means
     there is exactly one place that renders this information, not a
     second copy that could drift from what File ▸ Servers… shows. */
  S.DESKTOP.getSessionInfo().then(function (info) {
    if (info && info.hosting && typeof openServersDialog === "function") openServersDialog();
  }).catch(function () {});
}

/* ---- opening a server document routed to this tab at boot ----

   Main names a server document by id only (invariant #34) — this tab has
   to run the browser's own server-detection handshake (13-hosted.js)
   before openServerDoc() can mean anything: the server has to be probed
   and, if it asks for a PIN, that PIN has to actually be entered by the
   reader before the document exists to open.

   The natural hook would be a one-shot call FROM 13-hosted.js's own
   finishServerDetect() the moment auth succeeds — a typeof-guarded
   `if (typeof openPendingServerDocForTab === "function") …` there would
   cost nothing when this id is DESKTOP.only and nothing is pending. That
   one line lives in 13-hosted.js, which is not one of this step's files,
   so this polls serverMode/serverToken instead of being called back;
   step K (13-hosted.js) can wire the direct call later without this
   function needing to change shape. */
function openPendingServerDocForTab(serverDocId) {
  var CHECK_TIMEOUT_MS = 15000;
  var AUTH_TIMEOUT_MS = 10 * 60 * 1000;
  var POLL_MS = 500;
  var checkStart = Date.now();

  function isChecked() { return typeof S.serverMode !== "undefined" && S.serverMode && S.serverMode.checked; }
  function needsAuth() {
    return typeof S.serverMode !== "undefined" && S.serverMode && S.serverMode.authRequired &&
      !(typeof serverToken !== "undefined" && serverToken);
  }
  function openIt() {
    if (typeof openServerDoc === "function") openServerDoc(serverDocId);
  }

  (function waitForDetect() {
    if (isChecked() || Date.now() - checkStart > CHECK_TIMEOUT_MS) { afterDetect(); return; }
    setTimeout(waitForDetect, POLL_MS);
  })();

  function afterDetect() {
    if (!needsAuth()) { openIt(); return; }
    var authStart = Date.now();
    (function waitForAuth() {
      if (!needsAuth() || Date.now() - authStart > AUTH_TIMEOUT_MS) { openIt(); return; }
      setTimeout(waitForAuth, POLL_MS);
    })();
  }
}

/* ---- test hook ----
   There is no pre-load hook in the harness that can inject a real
   window.splitpageDesktop before this script runs — DESKTOP is captured
   once, at the top of 00-prelude.js, before any fragment's own top-level
   code (including this one) executes. Rather than teach the driver a new
   trick, tests/21-desktop-shim.txt swaps DESKTOP itself for an in-memory
   fake through setBackend()/restoreBackend() and drives the real code
   paths (saveDoc, deliverFile, openLocalFile, makeDesktopHandle) against
   it directly. Exists in both modes but does nothing unless a test calls
   it — same trick window.__splitpageFormats (20d-formats.js) plays. */
/* opts.history === true gives the fake the seven HISTORY-IPC methods, kept
   in memory, validating with the SAME regexes the real main process uses
   (normalizeDocId and HISTORY_SNAP_ID_RE, both from 03a-history-store.js)
   and applying the same "50 newest per document" trim. That is enough for
   a browser suite to prove the desktop path is taken — a capture lands in
   the desktop store, never in IndexedDB and never in localStorage — without
   a real Electron shell. _historyDump() hands the whole store back for
   assertions. */
function makeFakeDesktopBackend(opts) {
  var files = {};
  var recents = [];
  var nextId = 1;
  var openHandler = null;
  var menuHandler = null;
  var openServerDocHandler = null;
  /* Write-only, and deliberately kept. Every other registration slot in this
     fake backend has a _fire* twin below that a browser suite calls;
     onRestoreNotice is the one that does not, so nothing reads this back yet.
     Removing the variable would mean removing onRestoreNotice() itself, and
     20g-drafts.js calls that at boot against the real bridge — the fake has
     to answer it. The gap belongs to the suites, not to this file. */
  /* eslint-disable-next-line no-unused-vars -- holds the renderer's callback
     until a _fireRestoreNotice() exists to call it; see above. */
  var restoreNoticeHandler = null;
  var reassignDocIdHandler = null;
  function newId() { return "fake" + (nextId++); }

  /* ---- the crash-draft store, in memory (FAKE-DESKTOP-BACKEND) ----
     Faithful about the three things the renderer's writer actually has to
     cope with, and nothing more: seq is a floor (a stale write is refused),
     a write with no base is refused with NEED_BASE until one has been sent,
     and each write rotates one generation. desktop/drafts.js is the real
     thing and has its own Node test suite; this exists so the browser suite
     can drive 20g-drafts.js without Electron. */
  var draftStore = { floor: -Infinity, current: null, previous: null, base: null, writes: 0, failures: 0 };
  var draftLog = [];
  var draftTaken = null;
  var flushHandler = null;
  var draftFailNext = null;
  function draftFail(code) {
    /* HELD is not a disk failure — the same rule the real store follows
       (DRAFT-STORE), and what status().failures means on both sides. */
    if (code !== "HELD" && code !== "NEED_BASE" && code !== "STALE_SEQ" && code !== "DISCARDED") draftStore.failures++;
    draftStore.base = null;
    return Promise.resolve({ ok: false, code: code });
  }

  var backend = {
    isDesktop: true,
    platform: "test",
    appVersion: "0.0.0-test",

    /* TAB-BOOT-SYNC's fields, fixed at the FAKE-DESKTOP-BACKEND contract's
       values — a single blank, first, no-prior-session tab. The draft
       members are below; the seven history ones are opt-in (opts.history). */
    tabId: "f".repeat(32),
    windowId: "w".repeat(32),
    launchIntent: { type: "blank" },
    hadPriorSession: false,
    firstTabOfLaunch: true,
    hasDraftToRestore: false,

    openFileDialog: function () { return Promise.resolve(null); },
    saveFileDialog: function (opts) {
      if (this._cancelNextSave) { this._cancelNextSave = false; return Promise.resolve(null); }
      var id = newId();
      files[id] = { name: (opts && opts.suggestedName) || "untitled", bytes: new Uint8Array(0), lastModified: Date.now() + nextId };
      return Promise.resolve({ id: id, name: files[id].name });
    },
    readFile: function (id) {
      var f = files[id];
      if (!f) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
    },
    writeFile: function (id, data) {
      var f = files[id];
      if (!f) return Promise.reject(new Error("ENOENT"));
      var bytes = data instanceof Uint8Array ? data
        : (data instanceof ArrayBuffer ? new Uint8Array(data)
        : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(0)));
      f.bytes = bytes;
      f.lastModified = Date.now() + (nextId++);
      return Promise.resolve({ lastModified: f.lastModified, size: bytes.length });
    },
    statFile: function (id) {
      var f = files[id];
      return Promise.resolve(f ? { lastModified: f.lastModified, size: f.bytes.length } : null);
    },
    /* Always resolves {where:'this-tab'} unless a test points
       _routeAnswer at something else first — the single-tab shape every
       existing caller (openLocalFile, the server picker) already expects. */
    routeOpen: function (p) {
      /* A file id main no longer knows is the "moved or deleted since"
         case the recents column has to cope with (issue #15) — the real
         handler throws ENOENT for it, so the fake does too. */
      if (p && p.kind === "file" && this._routeMissing) return Promise.reject(new Error("ENOENT: file is not readable"));
      return Promise.resolve(this._routeAnswer || { where: "this-tab" });
    },

    /* ---- recent documents (DESKTOP-RECENTS) ----
       The real list lives in the main process's desktop-state.json; this
       is the same three calls over an in-memory array, so a browser suite
       can drive the New Tab page's third column. Each entry is
       {fileId, name, title, at} — never a path, exactly as the bridge
       hands them over. */
    listRecents: function () { return Promise.resolve(recents.map(function (r) { return { fileId: r.fileId, name: r.name, title: r.title, at: r.at }; })); },
    removeRecent: function (fileId) {
      recents = recents.filter(function (r) { return r.fileId !== fileId; });
      return this.listRecents();
    },
    clearRecents: function () { recents = []; return this.listRecents(); },
    _addRecent: function (fileId, name, title, at) {
      recents = recents.filter(function (r) { return r.fileId !== fileId; });
      recents.unshift({ fileId: fileId, name: name, title: title || "", at: at || Date.now() });
      return fileId;
    },
    onOpenFile: function (cb) { openHandler = cb; },
    onOpenServerDoc: function (cb) { openServerDocHandler = cb; },
    onRestoreNotice: function (cb) { restoreNoticeHandler = cb; },
    onReassignDocId: function (cb) { reassignDocIdHandler = cb; },
    onMenuCommand: function (cb) { menuHandler = cb; },
    /* WHY this stores rather than discards: FAKE-DESKTOP-BACKEND says
       "setDocumentState(s) stores this._lastDocState" — a test needs to see
       what notifyDesktopDocumentState() (20f-desktop.js) last told the
       bridge, e.g. that a tab still mid crash-draft-restore reports itself
       dirty (26-desktop-drafts.txt). Nothing in src/js reads this back. */
    setDocumentState: function (s) { this._lastDocState = s; },
    getSessionInfo: function () {
      return Promise.resolve({ library: false, hosting: false, port: null, lanUrls: [], pin: "" });
    },
    openExternal: function () {},

    /* ---- crash drafts (DRAFT-IPC-AND-SHAPES bridge members) ---- */
    writeDraft: function (payload) {
      draftLog.push({ op: "write", seq: payload && payload.seq, editSeq: payload && payload.editSeq,
                      originKind: payload && payload.originKind, hasBase: !!(payload && payload.baseJson) });
      if (draftFailNext && draftFailNext.count > 0) {
        draftFailNext.count--;
        return draftFail(draftFailNext.code);
      }
      if (!payload || typeof payload.stateJson !== "string" || typeof payload.seq !== "number") return draftFail("BAD_PAYLOAD");
      if (!(payload.seq > draftStore.floor)) return draftFail("STALE_SEQ");
      if (payload.baseJson == null && draftStore.base == null) return draftFail("NEED_BASE");
      if (payload.baseJson != null) draftStore.base = payload.baseJson;
      draftStore.previous = draftStore.current;
      draftStore.current = { header: payload, stateJson: payload.stateJson };
      draftStore.floor = payload.seq;
      draftStore.writes++;
      return Promise.resolve({ ok: true, seq: payload.seq, bytes: payload.stateJson.length });
    },
    discardDraft: function (seq) {
      draftLog.push({ op: "discard", seq: seq });
      if (typeof seq === "number") {
        if (seq < draftStore.floor) return Promise.resolve({ ok: false, code: "STALE_SEQ" });
        draftStore.floor = seq;
      }
      draftStore.current = null;
      draftStore.previous = null;
      draftStore.base = null;
      return Promise.resolve({ ok: true });
    },
    takeDraft: function () {
      draftLog.push({ op: "take" });
      return Promise.resolve(draftTaken);
    },
    draftRestoreDone: function (outcome) { draftLog.push({ op: "restore-done", outcome: outcome }); },
    onDraftFlush: function (cb) { flushHandler = cb; },

    /* test-only extras below this line — nothing in src/js ever calls these */
    _drafts: draftStore,
    _draftLog: draftLog,
    /* Arms what takeDraft() hands back: a TakenDraft, {corrupt:true},
       {unsupported:true} or null. */
    _setDraft: function (taken) { draftTaken = taken; },
    _failNextDraftWrites: function (code, count) {
      draftFailNext = code ? { code: code, count: count == null ? 1 : count } : null;
    },
    /* Stands in for main's splitpage:draft-flush message. */
    _fireDraftFlush: function () { return flushHandler ? flushHandler() : null; },
    _addFile: function (name, text) {
      var id = newId();
      files[id] = { name: name, bytes: strBytes(text), lastModified: Date.now() + nextId };
      return id;
    },
    _text: function (id) { return new TextDecoder().decode(files[id].bytes); },
    _touch: function (id) { if (files[id]) files[id].lastModified = Date.now() + (nextId++); },
    /* WHY this exists: a real sync client can rewrite a file's bytes and
       happen to leave its mtime alone (or restore it), which is exactly
       the case the content-based "unchanged on disk" decision (invariant
       #41, overrides.md) has to see through — draft restore never reads
       mtime at all. writeFile() above always bumps lastModified, same as
       a real write would, so there is no other way to construct "content
       changed, mtime did not" from outside this file. Nothing in src/js
       calls this. */
    _setBytesKeepMtime: function (id, text) { if (files[id]) files[id].bytes = strBytes(text); },
    _fireOpenFile: function (id) {
      var f = files[id];
      if (openHandler && f) openHandler({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
    },
    _fireMenuCommand: function (cmd) { if (menuHandler) menuHandler(cmd); },
    _fireOpenServerDoc: function (payload) { if (openServerDocHandler) openServerDocHandler(payload); },
    /* Stands in for main's duplicate-id verdict (DOC-CLAIMS): a suite can
       hand the page the exact {fromId, toId, otherTitle} message a real
       main process would send, without two Electron tabs. */
    _fireReassignDocId: function (msg) { if (reassignDocIdHandler) reassignDocIdHandler(msg); }
  };
  if (opts && opts.history) addFakeDesktopHistory(backend);
  return backend;
}

/* The HISTORY-IPC surface, faked in memory. Deliberately the same SHAPES
   desktop/main.js answers with ({ok:true, sizeBytes, duplicate?, evicted,
   overCap} and friends), because the code under test is the translator in
   03a-history-store.js's desktopHistoryBackend — a fake that answered a
   tidier shape would prove nothing about it. Invalid arguments REJECT, the
   way main's handlers do, so the 'invalid' path is reachable too. */
function addFakeDesktopHistory(backend) {
  var buckets = {};   /* bucket -> [{meta, stateJson}], oldest first */
  var records = {};   /* bucket -> {title, lastOpenedAt, migratedAt, expiresAt} */

  function listOf(bucket) { return buckets[bucket] || (buckets[bucket] = []); }
  function recordOf(bucket) { return records[bucket] || (records[bucket] = { title: "", lastOpenedAt: 0 }); }
  function bytesOf(bucket) {
    return listOf(bucket).reduce(function (n, e) { return n + (e.meta.sizeBytes || 0); }, 0);
  }
  function findIn(bucket, id) {
    var list = buckets[bucket] || [];
    for (var i = 0; i < list.length; i++) if (list[i].meta.id === id) return list[i];
    return null;
  }
  function metasNewestFirst(bucket) {
    return (buckets[bucket] || []).slice().reverse().map(function (e) { return sanitizeHistoryMeta(e.meta); });
  }
  function trim(bucket) {
    /* A document keeps its 50 newest; the Older bucket is only ever emptied
       as a whole, so it is never trimmed. */
    if (bucket === HISTORY_OLDER_KEY) return 0;
    var list = listOf(bucket), dropped = 0;
    while (list.length > HISTORY_PER_DOC) { list.shift(); dropped++; }
    return dropped;
  }
  function bucketOf(query) {
    if (query && query.older === true) return HISTORY_OLDER_KEY;
    return normalizeDocId(query && query.docId) || null;
  }

  backend.historyPut = function (docId, meta, stateJson) {
    var id = normalizeDocId(docId);
    var m = sanitizeHistoryMeta(meta);
    if (!id || !m || typeof stateJson !== "string") return Promise.reject(new Error("history: invalid put"));
    var existing = findIn(id, m.id);
    if (existing) return Promise.resolve({ ok: true, sizeBytes: existing.meta.sizeBytes, duplicate: true, evicted: 0, overCap: false });
    var list = listOf(id), rec = recordOf(id);
    m.sizeBytes = historyUtf8Length(stateJson);
    historyStampAfter(m, list.length ? list[list.length - 1].meta.atMs : null);
    list.push({ meta: m, stateJson: stateJson });
    if (m.title) rec.title = m.title;
    rec.lastOpenedAt = Date.now();
    return Promise.resolve({ ok: true, sizeBytes: m.sizeBytes, duplicate: false, evicted: trim(id), overCap: false });
  };

  backend.historyList = function (docId) {
    var id = docId == null ? null : normalizeDocId(docId);
    if (docId != null && !id) return Promise.reject(new Error("history: invalid document id"));
    var older = records[HISTORY_OLDER_KEY];
    return Promise.resolve({
      entries: id ? metasNewestFirst(id) : [],
      older: metasNewestFirst(HISTORY_OLDER_KEY),
      olderExpiresAt: older && older.expiresAt != null ? older.expiresAt : null
    });
  };

  backend.historyGet = function (query, snapshotId) {
    var bucket = bucketOf(query);
    if (!bucket) return Promise.reject(new Error("history: invalid document id"));
    if (typeof snapshotId !== "string" || !HISTORY_SNAP_ID_RE.test(snapshotId)) {
      return Promise.reject(new Error("history: invalid snapshot id"));
    }
    var hit = findIn(bucket, snapshotId);
    return Promise.resolve(hit ? { meta: sanitizeHistoryMeta(hit.meta), stateJson: hit.stateJson } : null);
  };

  backend.historyCopy = function (fromDocId, toDocId) {
    var from = normalizeDocId(fromDocId), to = normalizeDocId(toDocId);
    if (!from || !to) return Promise.reject(new Error("history: invalid document id"));
    if (from === to) return Promise.resolve({ ok: true, copied: 0 });
    if (!buckets[from] && !buckets[to]) return Promise.resolve({ ok: true, copied: 0 });
    var dst = listOf(to), copied = 0;
    (buckets[from] || []).forEach(function (e) {
      if (findIn(to, e.meta.id)) return;      /* ids are kept: a second copy is a no-op */
      dst.push({ meta: sanitizeHistoryMeta(e.meta), stateJson: e.stateJson });
      copied++;
    });
    dst.sort(function (a, b) { return (a.meta.atMs - b.meta.atMs) || (a.meta.id < b.meta.id ? -1 : 1); });
    recordOf(to).lastOpenedAt = Date.now();
    trim(to);
    return Promise.resolve({ ok: true, copied: copied });
  };

  backend.historyTouch = function (docId, title) {
    var id = normalizeDocId(docId);
    if (!id) return Promise.reject(new Error("history: invalid document id"));
    /* Never creates a record, same as the real store. */
    if (buckets[id] && buckets[id].length) {
      var rec = recordOf(id);
      rec.lastOpenedAt = Date.now();
      var t = String(title == null ? "" : title).slice(0, 300);
      if (t) rec.title = t;
    }
    return Promise.resolve();
  };

  backend.historyImportOlder = function (entries) {
    if (!Array.isArray(entries)) return Promise.reject(new Error("history: invalid import"));
    var fresh = !records[HISTORY_OLDER_KEY];
    var list = listOf(HISTORY_OLDER_KEY), rec = recordOf(HISTORY_OLDER_KEY), added = 0;
    if (fresh) {
      /* migratedAt/expiresAt only on creation: re-running an interrupted
         migration must never extend the 90 days. */
      rec.migratedAt = Date.now();
      rec.expiresAt = rec.migratedAt + HISTORY_OLDER_TTL_MS;
    }
    entries.forEach(function (e) {
      var m = sanitizeHistoryMeta(e && e.meta);
      if (!m || typeof (e && e.stateJson) !== "string" || findIn(HISTORY_OLDER_KEY, m.id)) return;
      m.sizeBytes = historyUtf8Length(e.stateJson);
      list.push({ meta: m, stateJson: e.stateJson });
      added++;
    });
    return Promise.resolve({ ok: true, count: list.length, added: added });
  };

  backend.historyUsage = function () {
    var total = 0, docCount = 0;
    Object.keys(buckets).forEach(function (k) {
      total += bytesOf(k);
      if (k !== HISTORY_OLDER_KEY) docCount++;
    });
    return Promise.resolve({ totalBytes: total, capBytes: Infinity, overCap: false, docCount: docCount, readOnly: false });
  };

  /* The real bridge's splitpage:history-list-docs twin (desktop/main.js) —
     every bucket that has ever had a put/touch against it, Older excluded,
     exactly the documents historyPut()/historyTouch() above created a
     record for. Backs desktopHistoryBackend.rawDocIds()/rawDoc()
     (03a-history-store.js), which is what lets exportHistoryAll() run
     against this fake the same way it runs against the real desktop store. */
  backend.historyListDocs = function () {
    var out = [];
    Object.keys(records).forEach(function (bucket) {
      if (bucket === HISTORY_OLDER_KEY) return;
      var rec = records[bucket];
      out.push({ docId: bucket, title: rec.title || "", lastOpenedAt: rec.lastOpenedAt || 0 });
    });
    return Promise.resolve(out);
  };

  /* The whole store: bucket -> [{meta, stateJson}], oldest first. */
  backend._historyDump = function () {
    var out = {};
    Object.keys(buckets).forEach(function (k) {
      out[k] = buckets[k].map(function (e) {
        return { meta: sanitizeHistoryMeta(e.meta), stateJson: e.stateJson };
      });
    });
    return out;
  };
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  window.__desktopTest = {
    makeHandle: makeDesktopHandle,
    runMenuCommand: runDesktopMenuCommand,
    makeFakeBackend: makeFakeDesktopBackend,
    /* The real boot-time wiring (init(), 21-events.js) only calls this
       against whatever DESKTOP already is at load — null in every browser
       suite. Exposed so a test can re-run it AFTER setBackend() swaps a fake
       in, which is the only way to exercise its menu-visibility toggling
       (34-desktop-app-data-export.txt) headless. Safe to call more than
       once: every DESKTOP.on*() registration just replaces the last handler
       pointer, and the hidden-attribute writes are idempotent. */
    initDesktop: initDesktop,
    setBackend: function (fake) {
      S.DESKTOP = fake;
      /* initDesktop() ran at boot against the REAL bridge, which in a browser
         suite is null — so no DESKTOP callback was ever registered there.
         Swapping a fake in has to re-do the duplicate-id registration, or
         _fireReassignDocId would fire into nothing and "prove" the glue
         works when nothing is listening to it. */
      wireReassignDocId();
    },
    restoreBackend: function () { S.DESKTOP = window.splitpageDesktop || null; },
    /* Lets desktop/test/smoke.mjs (SMOKE-HARNESS's tabIdOfTarget/shell) read
       which tab a given page is, over CDP, without any DOM UI to click on. */
    get tabId() { return S.DESKTOP && S.DESKTOP.tabId; },
    /* Lets desktop/test/smoke.mjs dirty the document with NO DOM
       interaction at all — no click, no synthetic event dispatch — which is
       exactly the "no user activation this session" scenario the
       close-relies-on-beforeunload-activation fix (main.js's 'close'
       handler) exists for. A real click, even a JS-dispatched one, risks
       looking like user activation to Chromium; calling markDirty()
       directly never does. */
    markDirtyForTest: function () { markDirty(); }
  };
}
