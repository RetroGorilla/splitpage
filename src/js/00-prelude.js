(function () {
  "use strict";

  /* The pristine served page, captured as literally the first thing this
     script does — before any render() call or state mutation touches the
     DOM. An inline classic <script> pauses the HTML parser while it runs,
     so at this exact moment document.documentElement.outerHTML reflects
     exactly what the server sent (everything up to and including this
     script tag has been parsed; nothing after it has run yet to change
     anything). This is what a save republishes from — see
     buildPublishHtml() — so saving never needs to fetch this page's own
     URL back (which even fails outright under file:// during testing) and
     never risks the "serialize the live DOM" trap the platform warns
     about, because this copy is taken before the DOM is live at all. */
  var PAGE_SHELL = "<!doctype html>" + document.documentElement.outerHTML;

  var state = null;
  var SCHEMA_VERSION = 2;
  var editSeq = 0;
  var dirty = false;
  var suppressUnloadWarning = false;
  /* The project file this document lives in: a File System Access API
     handle, once the user has picked or created one via Save, plus which
     format it is — "md" | "splitpage" | "html". The handle lets subsequent
     saves write in place instead of prompting again; the kind decides which
     serializer runs (14-export.js). `handle` stays null (and Save falls back
     to a plain download) in browsers without the API, e.g. Firefox.
     "html" only ever arrives by OPENING a legacy file — nothing writes it. */
  var docFileHandle = { handle: null, kind: null };
  var deleteArmId = null;
  var deleteArmTimer = null;

  /* ---- remembering the last project across launches ----
     A FileSystemFileHandle can be structured-cloned straight into IndexedDB
     (localStorage can't hold one) — that's what lets the app reopen the same
     file on its own next time, not just re-show whatever was typed. Purely a
     nicety: every call here is wrapped so a browser without IndexedDB, or one
     that refuses it (some file:// contexts), just silently gets none of this. */
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

  async function rememberLastFileHandle(handle) {
    if (!handle) return;
    try {
      var db = await openHandleDb();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(LAST_FILE_STORE, "readwrite");
        tx.objectStore(LAST_FILE_STORE).put(handle, LAST_FILE_KEY);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    } catch (e) { /* not fatal — remembering is a nicety, not a requirement */ }
  }

  async function loadLastFileHandle() {
    try {
      var db = await openHandleDb();
      return await new Promise(function (resolve, reject) {
        var req = db.transaction(LAST_FILE_STORE, "readonly").objectStore(LAST_FILE_STORE).get(LAST_FILE_KEY);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    } catch (e) { return null; }
  }
  var pendingImageRowId = null;
  var savedRange = null;
  var savedRangeCell = null;
  var HIGHLIGHT_COLOR = "#FCE38A";

  var prompterOpen = false;
  var prompterPlaying = false;
  var prompterSpeed = 42;
  var prompterRAF = null;
  var prompterLastTs = null;
  var prompterSkipShot = false;

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var recognition = null;
  var voiceFollowActive = false;
  var voiceStarting = false;
  var promptWords = [];
  var wordCursor = -1;
  /* Matching runs over the *speakable* words only. promptWords holds every
     token on screen, including ones that normalise to nothing — an em-dash
     between two clauses, a lone ellipsis. Those are never said out loud, so
     leaving them in the sequence being matched breaks the run of consecutive
     hits right where a speaker crosses one, and the prompter stalls. These
     two arrays are the same list with those tokens dropped: speakable[i] is
     the promptWords index of the i-th speakable word. */
  var speakable = [];
  var speakNorms = [];
  var speakCursor = -1;
  var voiceRestarts = 0;
  /* Bumped every time a listening session starts or stops. A queued restart
     from a session that has since been stopped must not fire against the
     recognizer belonging to the next one — that call would throw
     InvalidStateError (it is already running) and kill a session the user
     had only just restarted. */
  var voiceSession = 0;
  /* One microphone stream, held open for as long as Follow My Voice is on.
     Chrome ends a continuous recognition session by itself about once a
     minute, and every restart after that is a fresh request for the
     microphone — which re-prompts unless the page is already holding it.
     Keeping this stream alive is what makes those restarts invisible. */
  var voiceStream = null;
  var finalTranscript = "";
  var interimTranscript = "";
