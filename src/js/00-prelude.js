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

  /* The Google Fonts stylesheet ships as media="print" so a slow or
     unreachable fonts.googleapis.com cannot stop this script from running
     (see the comment on the <link> in page.html). Promoting it to the real
     stylesheet once it has arrived used to be an inline onload= attribute;
     the CSP (#65) blocks inline event handlers, so it happens here, from
     the one script that policy trusts. Immediately after PAGE_SHELL is
     captured, so the promotion never lands in a saved copy of the page —
     the shell has to be the page as it was served. */
  (function promoteFontCss() {
    var link = document.getElementById("font-css");
    if (!link) return;
    /* `sheet` is set once the stylesheet has parsed, whatever its media. A
       cached font stylesheet can be there already by the time this runs. */
    if (link.sheet) { link.media = "all"; return; }
    link.addEventListener("load", function () { link.media = "all"; });
  })();

  /* The Electron bridge, when this page is running inside the desktop shell.
     desktop/preload.js (a sibling project, not part of this build) defines
     window.splitpageDesktop ONLY on documents loaded from the privileged
     splitpage://app origin — never on a tunnelled remote page — so its mere
     presence here is already the security check, not just a feature test.
     Captured once, into a plain var rather than read from window each time,
     so every gate in src/js reads the same snapshot and a test hook
     (20f-desktop.js's window.__desktopTest) can swap it for a fake backend
     without touching window.splitpageDesktop itself. Everything gated on
     DESKTOP falls through to the exact same code the browser build always
     ran when it is null — that is the whole contract this branch exists to
     keep (see desktop/main.js and desktop/preload.js for the other half). */
  var DESKTOP = window.splitpageDesktop || null;

  var state = null;
  /* Resolves once the boot state load in init() (21-events.js) has settled
     `state` for the first time — the desktop-only race this exists for:
     DESKTOP.onOpenFile() (20f-desktop.js) can fire as soon as it's
     registered, which is well before loadInitialState()'s fetch resolves
     when the app was launched by double-clicking a project file, and
     without this, adoptProjectState() setting `state` to that file would
     just get clobbered a moment later when the boot load finally resolves
     and assigns the default/seed state over it. Stays null in the browser
     build, where nothing reads it. */
  var initialStateReady = null;
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
     "html" only ever arrives by OPENING a legacy file — nothing writes it.
     `lastModified` is the file's own timestamp as of the last time we read
     or wrote it — the same on-disk-conflict guard the import re-save path
     has always had (openedFile.lastModified, 18-local-files.js), applied
     here to project saves too (checkFileConflict). */
  var docFileHandle = { handle: null, kind: null, lastModified: null };
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
    /* Desktop persists what's open itself — the main process writes each
       tab's document source into desktop-state.json on every source change
       (splitpage:set-document-state) and restores whole sessions from it at
       launch (TAB-BOOT-SYNC/DESKTOP-STATE-V2). There is nothing left for
       this per-page, per-origin IndexedDB store to remember on desktop, and
       (unlike splitpage://app, which is stable) it would be remembering the
       wrong thing anyway: this file's real identity there is a path in
       main's own registry, which this page is never handed (invariant #34). */
    if (DESKTOP) return;
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
