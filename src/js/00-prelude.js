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
  /* The recently-edited list lives in the same database, one store along
     (see "the recents list" below). Version 2 is what adds it; a profile
     that already has version 1 keeps its remembered handle and simply gains
     the new store, which is why the upgrade below creates each store only
     if it is missing rather than assuming a fresh database. */
  var RECENTS_STORE = "recents";
  var HANDLE_DB_VERSION = 2;

  function openHandleDb() {
    return new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) { reject(new Error("no-indexeddb")); return; }
      var req = indexedDB.open(LAST_FILE_DB, HANDLE_DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(LAST_FILE_STORE)) db.createObjectStore(LAST_FILE_STORE);
        if (!db.objectStoreNames.contains(RECENTS_STORE)) db.createObjectStore(RECENTS_STORE, { keyPath: "key" });
      };
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
  /* ---- the recently-edited list (browser half) ----

     What the New Tab page's third column reads (20j-newtab.js). Same
     database as the single remembered handle above and the same bargain: a
     structured-cloned FileSystemFileHandle is the only thing that can
     reopen a file without a picker, so the list holds handles, and every
     call is wrapped so a browser without IndexedDB just gets an empty list.

     DESKTOP does not come here at all. A desktop file's real identity is a
     path in the main process's registry that this page is never handed
     (invariant #34), so an entry written here could name a file but never
     reopen one; desktop keeps its own list in desktop-state.json and hands
     it over as opaque ids (RECENTS-IPC, desktop/main.js).

     PRIVACY: this is a record of what someone has been working on, so it
     stays out of the app-data export (§5 #48) and out of anything a shared
     session can read. Nothing in 20h-appdata.js walks this store, and the
     only way to it is the four functions below.

     Entries are {key, handle, name, title, at}. `key` is a random id rather
     than the file's name: two projects in different folders can share a
     name, and a handle has no path to key on. Identity is the handle's own
     isSameEntry(), which is why recording is a read-compare-write rather
     than a put. */
  var RECENTS_CAP = 12;
  /* Autosave writes every pause in the typing. Rewriting the list on each
     one would be an IndexedDB transaction per pause to change a timestamp
     nothing displays to the second, so an entry refreshes at most this
     often (a title change always writes). */
  var RECENTS_REFRESH_MS = 60000;

  function recentsTx(mode) {
    return openHandleDb().then(function (db) {
      return db.transaction(RECENTS_STORE, mode).objectStore(RECENTS_STORE);
    });
  }

  function recentsRequest(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /* → [{key, handle, name, title, at}], newest first, capped. */
  async function listRecentFiles() {
    if (DESKTOP) return [];
    try {
      var store = await recentsTx("readonly");
      var all = await recentsRequest(store.getAll());
      if (!Array.isArray(all)) return [];
      return all
        .filter(function (e) { return e && e.handle && e.key; })
        .sort(function (a, b) { return (b.at || 0) - (a.at || 0); })
        .slice(0, RECENTS_CAP);
    } catch (e) { return []; }
  }

  /* Records (or refreshes) one file. `info` carries what the column shows:
     {name, title}. Never throws — a list that failed to record is a nicety
     lost, not a save lost, and every caller is on a save or open path that
     must not fail because of it. */
  async function rememberRecentFile(handle, info) {
    if (DESKTOP || !handle) return;
    info = info || {};
    try {
      var existing = await listRecentFiles();
      var now = Date.now();
      var match = null;
      for (var i = 0; i < existing.length; i++) {
        var same = false;
        try { same = await existing[i].handle.isSameEntry(handle); } catch (e) { same = false; }
        if (same) { match = existing[i]; break; }
      }
      var title = typeof info.title === "string" ? info.title.slice(0, 300) : "";
      var name = (info.name || handle.name || "").slice(0, 300);
      if (match && match.title === title && now - (match.at || 0) < RECENTS_REFRESH_MS) return;
      var entry = {
        key: match ? match.key : "rc" + Math.random().toString(36).slice(2, 9) + now.toString(36),
        handle: handle,
        name: name,
        title: title,
        at: now
      };
      var store = await recentsTx("readwrite");
      store.put(entry);
      /* The cap is applied on write rather than on read so the store cannot
         grow without bound in a profile nobody ever opens the page in. */
      var keep = existing.filter(function (e) { return e.key !== entry.key; });
      for (var j = RECENTS_CAP - 1; j < keep.length; j++) store.delete(keep[j].key);
    } catch (e) { /* remembering is a nicety, not a requirement */ }
  }

  async function forgetRecentFile(key) {
    if (!key) return;
    try {
      var store = await recentsTx("readwrite");
      store.delete(key);
    } catch (e) {}
  }

  async function clearRecentFiles() {
    try {
      var store = await recentsTx("readwrite");
      store.clear();
    } catch (e) {}
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
