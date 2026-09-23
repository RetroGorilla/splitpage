import { S } from "./_state.js";
import { conn, fileHome, home, homeConn, serverHomeId, setHome } from "./_home.js";
import { escapeHtml } from "./02-state.js";
import { normalizeDocId, reassignDocId } from "./02b-doc-id.js";
import { setBackend as setBlobBackend } from "./02c-blobs.js";
import {
  HISTORY_OLDER_KEY,
  HISTORY_SNAP_ID_RE,
  historyUtf8Length,
  isPristineSeedDocument,
  sanitizeHistoryMeta
} from "./03a-history-store.js";
import { hashText as historyHashText } from "./03c-history-idb.js";
import { createHistoryStore, createMemoryHistoryBackend } from "../../shared/history-store.js";
import { cssAttr } from "./04-richtext.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { detectServer, normalizeServerBase, openServerDoc, pointTabAt } from "./13-hosted.js";
import { concatBytes, saveDoc, strBytes } from "./14-export.js";
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
/* A tab main created to open a document — launchIntent 'open-file' or
   'open-server', which is every restored tab and every routed open — boots
   the starter document FIRST and is handed its real one afterwards. Until
   that arrives the starter is not this tab's document, so nothing about it
   is reported. Main's own record is the truth in that window (invariant
   #42): a report of the starter carries no fileId and no serverKey, which
   main reads — correctly, for any other report — as "this tab holds no
   document any more", and it wiped the file or server the tab was created
   for. Quit in that window and desktop-state.json saved the tab blank, so
   the file did not come back next launch; CI's fast runner caught it every
   time in DOC-CLAIMS' restore check, while this container, eight times
   slower, never once did. handedDocumentSettled() ends the wait whether the
   document opened or failed to — a file that will not open is then
   honestly reported as no document. */
var awaitingHandedDocument = false;

export function handedDocumentSettled() {
  if (!awaitingHandedDocument) return;
  awaitingHandedDocument = false;
  notifyDesktopDocumentState();
}

export function notifyDesktopDocumentState() {
  if (!S.DESKTOP || !S.state) return;
  if (awaitingHandedDocument) return;
  var restoring = typeof draftRestorePending !== "undefined" && draftRestorePending;
  /* Where a server document lives is part of which document it is (#11):
     the same id on two servers is two documents, and a restored tab has to
     come back on the server its document is on, not on whichever server
     another tab picked last. Server, tunnel and role only — the token never
     rides on this report, which fires on every edit; main is only ever
     handed one through routeOpen, to open a new tab without asking again. */
  var c = homeConn();
  S.DESKTOP.setDocumentState({
    title: S.state.title || "Untitled Script",
    dirty: !!S.dirty || restoring,
    pristine: (typeof isPristineSeedDocument === "function" && isPristineSeedDocument()) && !restoring,
    docId: S.state.docId || null,
    fileId: (home.kind === "file" && home.handle && home.handle._desktopId) || null,
    serverKey: serverHomeId(),
    serverUrl: c ? c.serverUrl : null,
    tunnel: c ? c.tunnel : null,
    role: c ? c.role : null
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
  /* View ▸ Present in Browser ("prompter-open-in-browser") needs nothing of
     its own here: it is File ▸ This document ▸ Present in browser's button
     (#menu-present-browser), clicked like any other item below. It had no
     in-page twin at first, which left it unreachable on Windows — the
     title bar is the tab strip, so there is no menu bar to open (#86). */
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

/* ---- the teleprompter in the browser (issue #86) ----

   Web Speech fails inside Electron and works in Chrome and Edge, so File ▸
   Present in browser and View ▸ Present in Browser (which clicks that File
   item) hand the script to the default browser — and so does the
   teleprompter's voice button where this desktop cannot listen for itself
   (no Windows recogniser, below). The bridge call
   takes NO argument (invariant #28, desktop/main.js section 9b): this page
   never says which file, which server or which URL — main reads all of
   that off this tab's own record and opens the browser itself. What this
   page owns is the one thing main cannot do: making sure what is on disk
   (or on the server) is what is on screen, because that is what the
   browser will read.

   UNSAVED WORK. Saved first, silently, when the save needs no question —
   the document already has a file of its own on disk, or lives on this
   app's server — because that is exactly the write autosave would make
   anyway. When it WOULD need a question (a script never saved, an import,
   an old .html that must be re-saved as .md), nothing is saved: the person
   is told to press Save first. A native Save dialog springing up because
   someone clicked a teleprompter button is a surprise, and a dialog they
   cancel leaves nothing for the browser to read anyway. */
var prompterBrowserBusy = false;

export function canOpenPrompterInBrowser() {
  return !!(S.DESKTOP && typeof S.DESKTOP.openPrompterInBrowser === "function");
}

var PROMPTER_BROWSER_MESSAGES = {
  NOT_SAVED: "Save this script first (Ctrl+S), then try again — the browser reads the saved copy.",
  SAVE_FAILED: "The save didn't go through, so the browser would show an older version. Save, then try again.",
  UNSAVED_CHANGES: "The save didn't go through, so the browser would show an older version. Save, then try again.",
  NOT_A_PROJECT: "Only a Splitpage script (.md or .splitpage) can be opened in the browser. Save it as one first.",
  READ_FAILED: "Couldn't read the saved file — it may have moved. Save it again, then try again.",
  TOO_LARGE: "This script is too large to hand to the browser.",
  NO_SERVER: "The server this script lives on isn't running here any more.",
  REMOTE_SERVER: "This script is on another server — use Share to get its link, then open that in Chrome or Edge.",
  SERVE_FAILED: "Couldn't open the script in your browser.",
  OPEN_FAILED: "Couldn't open your browser.",
  NO_TAB: "Couldn't open the script in your browser."
};

function prompterBrowserResult(ok, message, kind) {
  showToast(message, kind || (ok ? "ok" : "warn"), !ok);
  return { ok: ok, message: message };
}

/* A hosted document on a server somebody else runs (File ▸ Servers…): main
   has no document server of its own to point the browser at, and must not
   be handed a URL by this page. The link is this page's to give out,
   exactly as Share already does, so it goes to the clipboard instead. */
async function copyPrompterLinkForRemoteServer(id) {
  var link;
  try { link = new URL("?doc=" + encodeURIComponent(id) + "&teleprompter=1", homeConn().serverUrl).href; }
  catch (e) { return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NO_SERVER); }
  var copied;
  try { await navigator.clipboard.writeText(link); copied = true; } catch (e) { copied = false; }
  return prompterBrowserResult(copied, copied
    ? "This script is on another server — link copied. Paste it into Chrome or Edge to read it with Follow My Voice."
    : "This script is on another server. Open this in Chrome or Edge to read it with Follow My Voice: " + link,
    copied ? "ok" : "warn");
}

export async function openPrompterInBrowser() {
  if (!canOpenPrompterInBrowser()) return { ok: false, message: "" };
  if (prompterBrowserBusy) return { ok: false, message: "" };
  prompterBrowserBusy = true;
  try {
    if (!S.state) return prompterBrowserResult(false, "Still loading…");
    var serverId = serverHomeId();
    var hc = homeConn();
    if (serverId && hc && hc.serverUrl) return await copyPrompterLinkForRemoteServer(serverId);
    var fh = fileHome();
    var onDisk = !!(fh && fh.handle && fh.handle._desktopId);
    if (!onDisk && !serverId) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
    if (S.dirty) {
      /* A legacy .html's first Save is a Save As (14-export.js) — a dialog. */
      if (onDisk && fh.format === "html") return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
      await saveDoc();
      if (S.dirty) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.SAVE_FAILED);
    }
    var answer;
    try { answer = await S.DESKTOP.openPrompterInBrowser(); }
    catch (e) { answer = { ok: false, code: "OPEN_FAILED" }; }
    if (answer && answer.ok) {
      return prompterBrowserResult(true,
        "Opened in your browser. Follow My Voice needs Chrome or Edge — this window stays open for editing.");
    }
    var code = answer && answer.code;
    return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES[code] || PROMPTER_BROWSER_MESSAGES.OPEN_FAILED);
  } finally {
    prompterBrowserBusy = false;
  }
}

/* ---- Follow My Voice on desktop (issue #8) ----

   The Web Speech API fails inside Electron, so on Windows the main process
   runs a listener of its own (Windows' built-in recogniser, desktop/voice/
   listen.ps1, main.js section 9d) and forwards what it hears to this tab.
   createDesktopRecognition() wraps that in the same shape as a Web Speech
   recognizer — start(), stop(), onstart/onresult/onerror/onend — so the
   teleprompter's following code (20-teleprompter.js) runs unchanged on top
   of either one.

   The bridge calls take no argument (invariant #45). Every event carries
   the session number main gave voiceStart's answer; an event from any
   other session (a stopped one still shutting down, one another tab took
   over) is dropped here. */
var desktopVoice = null;        /* null until asked; then {available} */
var desktopVoiceAsking = null;
var activeDesktopRecognition = null;
var voiceEventBridge = null;    /* the bridge onVoiceEvent was registered on */

export function desktopVoiceKnown() {
  return desktopVoice !== null;
}

export function desktopVoiceAvailable() {
  return !!(desktopVoice && desktopVoice.available);
}

/* Asks main once whether this machine can listen; resolves when known. A
   bridge without the voice calls (an older shell, a fake backend without
   them) is "not available", and the teleprompter keeps Present in Browser. */
export function loadDesktopVoice() {
  if (desktopVoice) return Promise.resolve(desktopVoice);
  if (desktopVoiceAsking) return desktopVoiceAsking;
  var bridge = S.DESKTOP;
  if (!bridge || typeof bridge.voiceStatus !== "function" || typeof bridge.voiceStart !== "function") {
    desktopVoice = { available: false };
    return Promise.resolve(desktopVoice);
  }
  desktopVoiceAsking = Promise.resolve()
    .then(function () { return bridge.voiceStatus(); })
    .then(function (answer) { return { available: !!(answer && answer.available) }; },
          function () { return { available: false }; })
    .then(function (known) {
      desktopVoiceAsking = null;
      if (S.DESKTOP === bridge) desktopVoice = known;
      return known;
    });
  return desktopVoiceAsking;
}

function forgetDesktopVoice() {
  desktopVoice = null;
  desktopVoiceAsking = null;
  activeDesktopRecognition = null;
}

function dispatchVoiceEvent(event) {
  var rec = activeDesktopRecognition;
  if (!rec || !event || typeof event !== "object") return;
  if (rec._session === null) { rec._early.push(event); return; }
  if (event.session === rec._session) rec._handle(event);
}

function wireVoiceEvents(bridge) {
  if (voiceEventBridge === bridge || typeof bridge.onVoiceEvent !== "function") return;
  bridge.onVoiceEvent(dispatchVoiceEvent);
  voiceEventBridge = bridge;
}

/* What main's refusals mean to the teleprompter's onerror. */
var VOICE_START_ERRORS = { UNAVAILABLE: "unavailable", SPAWN_FAILED: "helper-failed", NO_TAB: "helper-failed" };

export function createDesktopRecognition() {
  var bridge = S.DESKTOP;
  wireVoiceEvents(bridge);
  var rec = {
    continuous: true,
    interimResults: true,
    lang: "",
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    onwarning: null,
    _running: false,
    _session: null,
    _early: [],
    _fire: function (name, arg) {
      var fn = rec[name];
      if (typeof fn === "function") fn.call(rec, arg);
    },
    _finish: function () {
      if (!rec._running) return;
      rec._running = false;
      rec._session = null;
      if (activeDesktopRecognition === rec) activeDesktopRecognition = null;
      rec._fire("onend");
    },
    _handle: function (event) {
      if (!rec._running) return;
      if (event.type === "start") {
        rec._fire("onstart");
      } else if (event.type === "interim" || event.type === "final") {
        if (typeof event.text !== "string") return;
        var result = { isFinal: event.type === "final", length: 1, 0: { transcript: event.text } };
        rec._fire("onresult", { resultIndex: 0, results: [result] });
      } else if (event.type === "warning") {
        rec._fire("onwarning", { warning: event.code });
      } else if (event.type === "error") {
        rec._fire("onerror", { error: event.code });
      } else if (event.type === "end") {
        /* Another tab started listening: this one is not coming back, and
           restarting would only take the microphone back from it. */
        if (event.reason === "taken") rec._fire("onerror", { error: "taken" });
        rec._finish();
      }
    },
    start: function () {
      if (rec._running) throw new Error("recognition has already started");
      rec._running = true;
      rec._session = null;
      rec._early = [];
      activeDesktopRecognition = rec;
      Promise.resolve()
        .then(function () { return bridge.voiceStart(); })
        .catch(function () { return { ok: false, code: "SPAWN_FAILED" }; })
        .then(function (answer) {
          if (!rec._running || activeDesktopRecognition !== rec) {
            /* stopped while main was starting it */
            if (answer && answer.ok) bridge.voiceStop();
            return;
          }
          if (!answer || !answer.ok || typeof answer.session !== "number") {
            rec._fire("onerror", { error: VOICE_START_ERRORS[answer && answer.code] || "helper-failed" });
            rec._finish();
            return;
          }
          rec._session = answer.session;
          var early = rec._early;
          rec._early = [];
          early.forEach(function (event) { if (event.session === answer.session) rec._handle(event); });
        });
    },
    stop: function () {
      if (!rec._running) return;
      Promise.resolve().then(function () { return bridge.voiceStop(); }).catch(function () {});
      rec._finish();
    }
  };
  rec.abort = rec.stop;
  return rec;
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

  /* Images (#82): the registry's store is the main process's blob folder.
     Normally already done by __init() below; repeated here for a bridge
     swapped in after it, and harmless when it is the same one. */
  wireDesktopBlobs(S.DESKTOP);

  /* Google Drive (issue #10). The web build's sign-in (Google Identity
     Services) needs an http/https origin and splitpage://app can never be
     one, so on desktop the MAIN process signs in through a loopback
     redirect and makes every Drive request (desktop/google-drive.js); the
     modal talks to it through the bridge's drive* calls. The entry shows
     whenever the bridge has them — even with no Google client configured
     yet, because then the modal is where the person finds out how to set
     one up. A bridge without them (a fake backend in a browser suite) keeps
     it hidden, and openDriveModal() (13-hosted.js) carries the same guard.
     Google Doc import is different — it needs no OAuth at all
     (11-import.js's confirmGdocImport() explains why) and stays enabled,
     routed through DESKTOP.openExternal() instead of window.open(). */
  var driveItem = document.getElementById("menu-drive-open");
  if (driveItem) driveItem.hidden = typeof S.DESKTOP.driveStatus !== "function";

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
  var intent = S.DESKTOP.launchIntent && S.DESKTOP.launchIntent.type;
  awaitingHandedDocument = intent === "open-file" || intent === "open-server";

  S.DESKTOP.onOpenFile(function (entry) {
    function proceed() {
      var handle = makeDesktopHandle(entry);
      handle.getFile().then(function (file) {
        return openProjectFile(file, handle);
      }).catch(function () {
        showToast("Could not open " + ((entry && entry.name) || "that file") + ".", "error");
      }).then(handedDocumentSettled);
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
    function proceed() {
      adoptPayloadServer(payload);
      openPendingServerDocForTab(serverDocId);
    }
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
   so this polls serverMode and conn.token instead of being called back;
   step K (13-hosted.js) can wire the direct call later without this
   function needing to change shape. */
/* The payload names the server its document is on (#11). A tab main made
   for it already booted onto that server (TAB-BOOT-SYNC's connection), and
   a this-tab route is this tab asking about its own server, so this is
   normally a no-op. Should the two ever disagree, the document wins: the
   tab is pointed at the payload's server before anything is asked for,
   because asking the wrong server for this id would open a stranger's
   document or none. */
function adoptPayloadServer(payload) {
  if (typeof payload.serverUrl !== "string") return;
  var url = normalizeServerBase(payload.serverUrl);
  if (url === conn.serverUrl) return;
  if (home.kind === "server") setHome("none");
  S.serverMode = { available: false, readOnly: false, checked: false, authRequired: false,
                   reviewAvailable: false, version: null };
  try {
    pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "", tunnel: payload.tunnel || null });
  } catch (e) {
    pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "" });
  }
  detectServer();
}

function openPendingServerDocForTab(serverDocId) {
  var CHECK_TIMEOUT_MS = 15000;
  var AUTH_TIMEOUT_MS = 10 * 60 * 1000;
  var POLL_MS = 500;
  var checkStart = Date.now();

  function isChecked() { return typeof S.serverMode !== "undefined" && S.serverMode && S.serverMode.checked; }
  function needsAuth() {
    return typeof S.serverMode !== "undefined" && S.serverMode && S.serverMode.authRequired && !conn.token;
  }
  var retried = false;
  function openIt() {
    if (typeof openServerDoc !== "function") { handedDocumentSettled(); return; }
    Promise.resolve(openServerDoc(serverDocId)).then(function (ok) {
      /* A token that looked fine and was not — remembered for this server
         before it restarted, so a new session no longer takes it — is only
         found out by this request: handleApiError() has dropped it and put
         the PIN dialog up. Wait for the PIN once more rather than leave a
         restored tab empty after the reader typed it. */
      if (ok === false && !retried && needsAuth()) { retried = true; afterDetect(); return; }
      handedDocumentSettled();
    }, handedDocumentSettled);
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

/* ---- the desktop blob backend (issue #82) ----

   The page's blob registry (02c-blobs.js) keeps image bytes by SHA-256 and
   asks a backend to hold them durably: IndexedDB in the browser, and on the
   desktop the main process's <userData>/blobs folder through the bridge
   (desktop/blob-store.js, main.js section 8c). This is that desktop
   backend, in the registry's interface:

     get(sha)              -> Promise<{bytes: Uint8Array, mime} | null>
     put(sha, bytes, mime) -> Promise<{stored}>, rejecting on refusal with
                              err.code (HASH_MISMATCH, NOT_AN_IMAGE,
                              TOO_LARGE, ENOSPC, READ_ONLY, UNAVAILABLE ...)
     missing(shas)         -> Promise<string[]>

   `mime` is accepted and not sent: main sniffs the bytes itself and serves
   only PNG, JPEG, GIF and WebP, so a caller's label is never trusted.
   Nothing names a path (invariant #28) — a sha is all that crosses.

   get() never rejects: a blob that is not here, or a call main refused, is
   null, and the registry then tries the next source (the server, or a
   placeholder). missing() asks in slices of 2000, the most one
   splitpage:blob-missing takes.

   wireDesktopBlobs() below installs it as the registry's backend — at
   module init, before anything can ask the registry for a store, so on
   desktop no image ever lands in the renderer's IndexedDB instead. */
var DESKTOP_BLOB_MISSING_SLICE = 2000;

/* The bridge whose blob backend the registry is using, if any. */
var wiredBlobBridge = null;

/* Points the registry (02c-blobs.js) at `bridge`'s blob folder. A bridge
   without the blob calls changes nothing, unless the registry is still on
   an earlier bridge's — then it goes back to choosing its own store. */
export function wireDesktopBlobs(bridge) {
  if (bridge && bridge === wiredBlobBridge) return;
  var backend = makeDesktopBlobBackend(bridge);
  if (!backend && !wiredBlobBridge) return;
  wiredBlobBridge = backend ? bridge : null;
  setBlobBackend(backend);
}

export function makeDesktopBlobBackend(bridge) {
  var b = bridge;
  if (!b || typeof b.blobPut !== "function" || typeof b.blobGet !== "function" || typeof b.blobMissing !== "function") {
    return null;
  }
  return {
    /* name/persistent are what 02c-blobs.js's backend interface reads;
       `kind` is kept for anything that already asked for it. */
    name: "desktop",
    kind: "desktop",
    persistent: true,
    get: function (sha) {
      return Promise.resolve()
        .then(function () { return b.blobGet(sha); })
        .then(function (got) {
          if (!got || !got.bytes || typeof got.mime !== "string") return null;
          var bytes = got.bytes instanceof Uint8Array ? got.bytes : new Uint8Array(got.bytes);
          return { bytes: bytes, mime: got.mime };
        }, function () { return null; });
    },
    /* put(sha, bytes, mime): the third argument is the interface's and is
       deliberately not read (see above). */
    put: function (sha, bytes) {
      return Promise.resolve()
        .then(function () { return b.blobPut(sha, bytes); })
        .then(function (res) {
          if (res && res.ok === true) return { stored: res.stored === true };
          var code = (res && typeof res.code === "string" && res.code) || "FAILED";
          var err = new Error("blob-put refused: " + code);
          err.code = code;
          throw err;
        });
    },
    missing: function (shas) {
      var list = Array.isArray(shas) ? shas : [];
      var slices = [];
      for (var i = 0; i < list.length; i += DESKTOP_BLOB_MISSING_SLICE) {
        slices.push(list.slice(i, i + DESKTOP_BLOB_MISSING_SLICE));
      }
      return slices.reduce(function (acc, slice) {
        return acc.then(function (out) {
          return Promise.resolve(b.blobMissing(slice)).then(function (m) {
            return out.concat(Array.isArray(m) ? m : slice);
          });
        });
      }, Promise.resolve([]));
    }
  };
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
/* opts.blobs === true adds the three blob-bridge members (issue #82) —
   see addFakeDesktopBlobs below.
   opts.history === true gives the fake the eight HISTORY-IPC methods over
   the real shared/history-store.js on a memory backend (#83), validating
   with the SAME regexes the real main process uses (normalizeDocId and
   HISTORY_SNAP_ID_RE, both from 03a-history-store.js). That is enough for
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
      /* What the page asked for, for a suite to read back — a server route
         carries the connection since #11. */
      this._lastRoute = p ? JSON.parse(JSON.stringify(p)) : null;
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
    /* The teleprompter's Open in browser (issue #86). Argument-free, like
       the real bridge; records what this page had told main about itself
       at the moment it asked (the real handler reads exactly that), and
       answers whatever a test armed in _prompterAnswer. */
    openPrompterInBrowser: function () {
      this._prompterCalls = (this._prompterCalls || 0) + 1;
      this._prompterDocState = this._lastDocState || null;
      return Promise.resolve(this._prompterAnswer || { ok: true, kind: "file" });
    },

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
    /* Stands in for main's splitpage:restore-notice — the {skipped:[{name,
       reason}]} a launch sends when it could not bring back one or more
       remembered tabs, answered by initDesktop()'s onRestoreNotice. */
    _fireRestoreNotice: function (notice) { if (restoreNoticeHandler) restoreNoticeHandler(notice); },
    /* Stands in for main's duplicate-id verdict (DOC-CLAIMS): a suite can
       hand the page the exact {fromId, toId, otherTitle} message a real
       main process would send, without two Electron tabs. */
    _fireReassignDocId: function (msg) { if (reassignDocIdHandler) reassignDocIdHandler(msg); }
  };
  if (opts && opts.history) addFakeDesktopHistory(backend);
  if (opts && opts.drive) addFakeDesktopDrive(backend);
  if (opts && opts.blobs) addFakeDesktopBlobs(backend, opts);
  if (opts && opts.voice) addFakeDesktopVoice(backend);
  return backend;
}

/* The blob bridge (issue #82), faked in memory: blobPut/blobGet/blobMissing
   with the real bridge's arities, answer shapes and refusals — a sha that is
   not 64 lowercase hex REJECTS (the IPC table refuses it before main's
   handler runs), a string or non-image body, an empty one or one over
   16 MiB answers {ok:false, code}, and a missing list over 2000 rejects.
   The fake cannot hash on its own without pulling a SHA-256 into this
   module, so opts.blobHash (bytes -> hex, e.g. 02b-doc-id.js's byte hasher)
   turns on the HASH_MISMATCH check; without it the fake trusts the sha.
   _blobs is the store (sha -> {bytes, mime}), _blobCalls every call, and
   _blobFailNext = {code} makes the next put answer that code. */
/* Follow My Voice (issue #8), opt-in: makeFakeBackend({voice:true}). Stands
   in for main's listener (main.js section 9d) without a microphone.
   voiceStart answers a fresh session, or _voiceStartAnswer if a test armed
   one; _voiceEmit(event) plays an event into this page the way main would,
   with the current session filled in unless the event names one;
   _voiceCalls counts what the page asked for. _voiceAvailable (default
   true) is what voiceStatus reports. */
function addFakeDesktopVoice(backend) {
  var handler = null;
  backend._voiceCalls = { status: 0, start: 0, stop: 0 };
  backend._voiceAvailable = true;
  backend._voiceSession = 0;
  backend._voiceRunning = false;
  backend.voiceStatus = function () {
    backend._voiceCalls.status++;
    return Promise.resolve({ available: backend._voiceAvailable });
  };
  backend.voiceStart = function () {
    backend._voiceCalls.start++;
    if (backend._voiceStartAnswer) return Promise.resolve(backend._voiceStartAnswer);
    backend._voiceSession++;
    backend._voiceRunning = true;
    return Promise.resolve({ ok: true, session: backend._voiceSession });
  };
  backend.voiceStop = function () {
    backend._voiceCalls.stop++;
    backend._voiceRunning = false;
    return Promise.resolve({ ok: true });
  };
  backend.onVoiceEvent = function (cb) { handler = cb; };
  backend._voiceEmit = function (event) {
    var e = Object.assign({ session: backend._voiceSession }, event);
    if (handler) handler(e);
  };
}

function addFakeDesktopBlobs(backend, opts) {
  var SHA_RE = /^[0-9a-f]{64}$/;
  var MAX = 16 * 1024 * 1024;
  var hash = typeof opts.blobHash === "function" ? opts.blobHash : null;
  var store = {};
  var calls = [];
  function sniff(u) {
    if (u.length >= 8 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "image/png";
    if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
    if (u.length >= 6 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) return "image/gif";
    if (u.length >= 12 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 &&
        u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return "image/webp";
    return null;
  }
  function badSha() { return Promise.reject(new Error("splitpage:blob: argument 1 is not sha256")); }
  backend.blobPut = function (sha, bytes) {
    calls.push({ op: "put", sha: sha });
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return badSha();
    if (typeof bytes === "string") return Promise.resolve({ ok: false, code: "BAD_BYTES" });
    var u = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
    if (!u) return Promise.reject(new Error("splitpage:blob-put: argument 2 is not bytes"));
    if (!u.length) return Promise.resolve({ ok: false, code: "EMPTY" });
    if (u.length > MAX) return Promise.resolve({ ok: false, code: "TOO_LARGE" });
    var mime = sniff(u);
    if (!mime) return Promise.resolve({ ok: false, code: "NOT_AN_IMAGE" });
    if (backend._blobFailNext) { var f = backend._blobFailNext; backend._blobFailNext = null; return Promise.resolve({ ok: false, code: f.code }); }
    if (hash && hash(u) !== sha) return Promise.resolve({ ok: false, code: "HASH_MISMATCH" });
    if (store[sha]) return Promise.resolve({ ok: true, stored: false });
    store[sha] = { bytes: new Uint8Array(u), mime: mime };
    return Promise.resolve({ ok: true, stored: true });
  };
  backend.blobGet = function (sha) {
    calls.push({ op: "get", sha: sha });
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return badSha();
    var e = store[sha];
    return Promise.resolve(e ? { bytes: new Uint8Array(e.bytes), mime: e.mime } : null);
  };
  backend.blobMissing = function (shas) {
    calls.push({ op: "missing", count: Array.isArray(shas) ? shas.length : -1 });
    if (!Array.isArray(shas)) return Promise.reject(new Error("splitpage:blob-missing: argument 1 is not array"));
    if (shas.length > 2000) return Promise.reject(new Error("blob-missing: at most 2000 shas per call"));
    if (!shas.every(function (x) { return typeof x === "string" && SHA_RE.test(x); })) {
      return Promise.reject(new Error("blob-missing: every entry must be a sha256"));
    }
    var seen = {};
    return Promise.resolve(shas.filter(function (x) {
      if (seen[x] || store[x]) return false;
      seen[x] = true;
      return true;
    }));
  };
  backend._blobs = store;
  backend._blobCalls = calls;
  backend._blobFailNext = null;
}

/* The Google Drive bridge (issue #10), faked in memory: the six calls with
   the real bridge's arities and answer SHAPES (desktop/google-drive.js) —
   {ok, ...status} from the account calls, {ok, folder, files} /
   {ok, file, bytes} / {ok, file} from the Drive ones, {ok:false, code}
   otherwise — and the same Drive id rule main applies. What it cannot
   fake is the OAuth flow itself, which is desktop/test/smoke.mjs's
   (against a fake Google) and desktop/test/google-drive.test.mjs's.
   _driveCalls records every call with its arguments, so a suite can prove
   the page never passes a URL or a token; _drive exposes the switches. */
function addFakeDesktopDrive(backend) {
  var ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
  var FOLDER = "application/vnd.google-apps.folder";
  var nextFile = 1;
  var drive = {
    configured: true,
    signedIn: false,
    persisted: true,
    email: "writer@example.com",
    signInAnswer: null,     /* e.g. {ok:false, code:'DENIED'} for the next sign-in */
    failNext: null,         /* e.g. {code:'SIGNED_OUT'} for the next Drive call */
    files: {
      root: { id: "root", name: "My Drive", mimeType: FOLDER, parent: null },
      scriptsFolder01: { id: "scriptsFolder01", name: "Scripts", mimeType: FOLDER, parent: "root" },
      pilotFile01: { id: "pilotFile01", name: "Pilot.fountain", mimeType: "text/plain", parent: "scriptsFolder01", text: "INT. KITCHEN - DAY\n" },
      gdoc01: { id: "gdoc01", name: "Notes", mimeType: "application/vnd.google-apps.document", parent: "scriptsFolder01", text: "Notes as text.\n" },
      sheet01: { id: "sheet01", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", parent: "scriptsFolder01" }
    }
  };
  var calls = [];
  function status() {
    return {
      ok: true, configured: drive.configured, signedIn: drive.configured && drive.signedIn,
      persisted: drive.signedIn && drive.persisted, canPersist: drive.persisted, signingIn: false,
      email: drive.signedIn ? drive.email : "", name: "",
      clientFilePath: "/fake/userData/google-oauth-client.json",
      envVars: ["SPLITPAGE_GOOGLE_CLIENT_ID", "SPLITPAGE_GOOGLE_CLIENT_SECRET"]
    };
  }
  function entry(f) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, size: f.text != null ? strBytes(f.text).length : null, modifiedTime: "2026-09-01T10:00:00.000Z" };
  }
  function gate() {
    if (drive.failNext) { var f = drive.failNext; drive.failNext = null; if (f.code === "SIGNED_OUT") drive.signedIn = false; return { ok: false, code: f.code }; }
    if (!drive.signedIn) return { ok: false, code: "SIGNED_OUT" };
    return null;
  }
  function bytesOf(v) {
    if (typeof v === "string") return strBytes(v);
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  }
  backend.driveStatus = function () { calls.push({ op: "status", args: [].slice.call(arguments) }); return Promise.resolve(status()); };
  backend.driveSignIn = function () {
    calls.push({ op: "signIn", args: [].slice.call(arguments) });
    if (!drive.configured) return Promise.resolve({ ok: false, code: "NOT_CONFIGURED" });
    if (drive.signInAnswer) { var a = drive.signInAnswer; drive.signInAnswer = null; return Promise.resolve(a); }
    drive.signedIn = true;
    return Promise.resolve(status());
  };
  backend.driveSignOut = function () {
    calls.push({ op: "signOut", args: [].slice.call(arguments) });
    drive.signedIn = false;
    return Promise.resolve({ ok: true, status: status() });
  };
  backend.driveList = function (folderId) {
    calls.push({ op: "list", args: [].slice.call(arguments) });
    var g = gate(); if (g) return Promise.resolve(g);
    if (typeof folderId !== "string" || !ID_RE.test(folderId)) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var folder = drive.files[folderId];
    if (!folder) return Promise.resolve({ ok: false, code: "NOT_FOUND" });
    if (folder.mimeType !== FOLDER) return Promise.resolve({ ok: false, code: "NOT_A_FOLDER" });
    var kids = Object.keys(drive.files).map(function (k) { return drive.files[k]; })
      .filter(function (f) { return f.parent === folderId; })
      .sort(function (a, b) { return ((b.mimeType === FOLDER) - (a.mimeType === FOLDER)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return Promise.resolve({ ok: true, folder: entry(folder), files: kids.map(entry) });
  };
  backend.driveDownload = function (fileId) {
    calls.push({ op: "download", args: [].slice.call(arguments) });
    var g = gate(); if (g) return Promise.resolve(g);
    if (typeof fileId !== "string" || !ID_RE.test(fileId)) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var f = drive.files[fileId];
    if (!f) return Promise.resolve({ ok: false, code: "NOT_FOUND" });
    if (f.mimeType === FOLDER) return Promise.resolve({ ok: false, code: "IS_A_FOLDER" });
    if (f.text == null) return Promise.resolve({ ok: false, code: "UNSUPPORTED" });
    return Promise.resolve({ ok: true, file: entry(f), bytes: strBytes(f.text) });
  };
  backend.driveUpload = function (req) {
    calls.push({ op: "upload", args: [].slice.call(arguments) });
    var g = gate(); if (g) return Promise.resolve(g);
    var bytes = req && bytesOf(req.bytes);
    if (!req || !bytes) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var text = new TextDecoder().decode(bytes);
    if (req.fileId !== undefined) {
      var f = drive.files[req.fileId];
      if (!f) return Promise.resolve({ ok: false, code: "NOT_FOUND" });
      f.text = text;
      f.revisions = (f.revisions || 1) + 1;
      return Promise.resolve({ ok: true, file: entry(f) });
    }
    if (!ID_RE.test(String(req.parentId)) || typeof req.name !== "string" || !req.name) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var id = "upload" + (nextFile++);
    drive.files[id] = { id: id, name: req.name, mimeType: req.mimeType || "application/octet-stream", parent: req.parentId, text: text };
    return Promise.resolve({ ok: true, file: entry(drive.files[id]) });
  };
  backend._drive = drive;
  backend._driveCalls = calls;
}

/* The HISTORY-IPC surface, faked in memory — and since #83 over the REAL
   store: shared/history-store.js on the shared memory backend, the same
   store desktop/main.js runs over its folder backend. What is fake is only
   the IPC edge, and it keeps main's SHAPES ({ok:true, sizeBytes,
   duplicate?, evicted, overCap} and friends), because the code under test
   is the translator in 03a-history-store.js's desktopHistoryBackend — a fake
   that answered a tidier shape would prove nothing about it. Invalid
   arguments REJECT, the way main's handlers do, so the 'invalid' path is
   reachable too. The held snapshots a put or a get carries are remembered
   per bridge, as main remembers them per tab, and unioned into every
   eviction. No cap: main's is the disk's, and no suite fills one here. */
function addFakeDesktopHistory(backend) {
  var mem = createMemoryHistoryBackend({ name: "desktop-fake", persistent: true });
  var held = [];
  var store = createHistoryStore({
    backend: mem,
    now: Date.now,
    hashText: historyHashText,
    holds: function () { return held; }
  });

  function bucketOf(query) {
    if (query && query.older === true) return HISTORY_OLDER_KEY;
    return normalizeDocId(query && query.docId) || null;
  }
  function invalid(what) { return Promise.reject(new Error("history: " + what)); }

  /* main's history-put: (docId | null, meta, stateJson, {protect?,
     older?}). {older:true} — literally true — writes into Older and then
     the docId must be null; without it the docId must be real. */
  backend.historyPut = function (docId, meta, stateJson, opts) {
    var o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
    var older = o.older === true;
    var id = older ? (docId === null ? HISTORY_OLDER_KEY : null) : normalizeDocId(docId);
    var m = sanitizeHistoryMeta(meta);
    if (!id || !m || typeof stateJson !== "string") return invalid("invalid put");
    if (Array.isArray(o.protect)) held = o.protect.slice();
    return (older ? store.put(null, m, stateJson, { older: true }) : store.put(id, m, stateJson)).then(function (r) {
      if (!r.stored) return { ok: false, code: r.code };
      return { ok: true, sizeBytes: historyUtf8Length(stateJson), duplicate: !!r.duplicate, evicted: r.evicted || 0, overCap: !!r.overCap };
    });
  };

  backend.historyList = function (docId) {
    var id = docId == null ? null : normalizeDocId(docId);
    if (docId != null && !id) return invalid("invalid document id");
    return store.list(id).then(function (r) {
      return store.usage().then(null, function () { return null; }).then(function (usage) {
        /* main's metas carry no document id: on its side the bucket is the
           document, and the renderer stamps it back on. The usage rides on
           the list's answer, as main's does. */
        return { entries: r.entries.map(sanitizeHistoryMeta), older: r.older.map(sanitizeHistoryMeta), olderExpiresAt: r.olderExpiresAt, usage: usage };
      });
    });
  };

  backend.historyGet = function (query, snapshotId) {
    var bucket = bucketOf(query);
    if (!bucket) return invalid("invalid document id");
    if (typeof snapshotId !== "string" || !HISTORY_SNAP_ID_RE.test(snapshotId)) return invalid("invalid snapshot id");
    if (query && Array.isArray(query.protect)) held = query.protect.slice();
    return store.get(bucket, snapshotId).then(function (hit) {
      return hit ? { meta: sanitizeHistoryMeta(hit.meta), stateJson: hit.stateJson } : null;
    });
  };

  backend.historyCopy = function (fromDocId, toDocId) {
    var from = normalizeDocId(fromDocId), to = normalizeDocId(toDocId);
    if (!from || !to) return invalid("invalid document id");
    return store.copy(from, to);
  };

  backend.historyTouch = function (docId, title) {
    var id = normalizeDocId(docId);
    if (!id) return invalid("invalid document id");
    return store.touch(id, title);
  };

  /* main's splitpage:history-list-docs: every document the store has a
     record for, Older excluded — what desktopHistoryBackend.rawDocIds()/
     rawDoc() (03a-history-store.js) read, which is what lets
     exportHistoryAll() run against this fake the way it runs against the
     real desktop store. */
  backend.historyListDocs = function () { return store.listDocs(); };

  /* The whole store, synchronously: bucket -> [{meta, stateJson}], oldest
     first (bodies looked up by sha). */
  backend._historyDump = function () {
    var raw = mem.inspect(), out = {};
    Object.keys(raw.index).forEach(function (bucket) {
      out[bucket] = (raw.index[bucket].snapshots || []).map(function (s) {
        return { meta: sanitizeHistoryMeta(s), stateJson: raw.bodies[s.sha] };
      });
    });
    return out;
  };
  /* the store and its memory backend, for a suite that needs more */
  backend._historyStore = store;
  backend._historyBackend = mem;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* As early as the bridge is known (00-prelude.js sets S.DESKTOP): the
     registry picks its store on its first async call, and on desktop that
     must be the blob folder, never this renderer's IndexedDB. */
  if (S.DESKTOP) wireDesktopBlobs(S.DESKTOP);
  window.__desktopTest = {
    makeHandle: makeDesktopHandle,
    runMenuCommand: runDesktopMenuCommand,
    makeFakeBackend: makeFakeDesktopBackend,
    /* The desktop blob backend over whatever bridge a suite hands it —
       usually makeFakeBackend({blobs:true}) — for 02c-blobs.js's suites. */
    makeBlobBackend: makeDesktopBlobBackend,
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
      /* Whether this machine can listen (issue #8) is the bridge's answer,
         so a new bridge is asked again. */
      forgetDesktopVoice();
      /* A fake with the blob calls (makeFakeBackend({blobs:true})) becomes
         the registry's store too, the way the real bridge is at boot; one
         without them leaves the registry where it was. */
      if (fake && typeof fake.blobPut === "function") wireDesktopBlobs(fake);
      /* initDesktop() ran at boot against the REAL bridge, which in a browser
         suite is null — so no DESKTOP callback was ever registered there.
         Swapping a fake in has to re-do the duplicate-id registration, or
         _fireReassignDocId would fire into nothing and "prove" the glue
         works when nothing is listening to it. */
      wireReassignDocId();
    },
    restoreBackend: function () {
      S.DESKTOP = window.splitpageDesktop || null;
      forgetDesktopVoice();
      wireDesktopBlobs(S.DESKTOP);
    },
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
