import { S } from "./_state.js";

export var PAGE_SHELL;
export var SpeechRecognitionCtor;

S.state = null;
// Resolves after boot load; desktop onOpenFile can race it
S.initialStateReady = null;
export var SCHEMA_VERSION = 2;
S.editSeq = 0;
S.dirty = false;
export var suppressUnloadWarning = false;
S.deleteArmId = null;
S.deleteArmTimer = null;

var LAST_FILE_DB = "splitpage-files", LAST_FILE_STORE = "handles", LAST_FILE_KEY = "last";

function openHandleDb() {
  return new Promise(function (resolve, reject) {
    if (!("indexedDB" in window)) { reject(new Error("no-indexeddb")); return; }
    var req = indexedDB.open(LAST_FILE_DB, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(LAST_FILE_STORE); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

export async function rememberLastFileHandle(handle) {
  if (!handle) return;
  // Desktop main process persists open docs; skip page store
  if (S.DESKTOP) return;
  try {
    var db = await openHandleDb();
    await new Promise(function (resolve, reject) {
      var tx = db.transaction(LAST_FILE_STORE, "readwrite");
      tx.objectStore(LAST_FILE_STORE).put(handle, LAST_FILE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  } catch (e) { }
}

export async function loadLastFileHandle() {
  try {
    var db = await openHandleDb();
    return await new Promise(function (resolve, reject) {
      var req = db.transaction(LAST_FILE_STORE, "readonly").objectStore(LAST_FILE_STORE).get(LAST_FILE_KEY);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  } catch (e) { return null; }
}
S.pendingImageRowId = null;
S.savedRange = null;
S.savedRangeCell = null;

S.prompterOpen = false;
S.prompterPlaying = false;
S.prompterSpeed = 42;
S.prompterRAF = null;
S.prompterLastTs = null;
S.prompterSkipShot = false;
S.recognition = null;
S.voiceFollowActive = false;
S.voiceStarting = false;
S.promptWords = [];
S.wordCursor = -1;
// Speakable words only; unspoken tokens break match runs
S.speakable = [];
S.speakNorms = [];
S.speakCursor = -1;
S.voiceRestarts = 0;
// Stale queued restarts must not fire on next session
S.voiceSession = 0;
// Held open so Chrome's auto-restarts don't re-prompt mic
S.voiceStream = null;
S.finalTranscript = "";
S.interimTranscript = "";

export function __init() {
  // Must run before any render; captures pristine served HTML
  PAGE_SHELL = "<!doctype html>" + document.documentElement.outerHTML;

  // CSP blocks inline onload; media=print keeps fonts non-blocking
  (function promoteFontCss() {
    var link = document.getElementById("font-css");
    if (!link) return;
    if (link.sheet) { link.media = "all"; return; }
    link.addEventListener("load", function () { link.media = "all"; });
  })();

  // Bridge only exists on privileged origin; presence is the check
  S.DESKTOP = window.splitpageDesktop || null;

  SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
