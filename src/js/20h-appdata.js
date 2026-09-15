  /* ================= export/import: the whole app's browser data =================

     File ▸ Export app data… (X1, this file) lets someone moving from the
     browser build to the desktop app take their version history, server
     bookmarks and preferences with them — none of which live in a document,
     so opening a file never carries them. File ▸ Import app data… (X2, a
     follow-up step) is the desktop-side merge; the stub at the bottom exists
     only so today's File-menu wiring has something to call.

     Export is deliberately browser-only for now (the desktop history store
     cannot enumerate its own documents without new main-process IPC —
     exportHistoryAll() answers that with a rejection, not an empty bundle,
     and buildAppDataBundle() below lets that section fail on its own without
     failing the whole export).

     WHAT NEVER LEAVES: a server sign-in token, a Drive API key or client id,
     the last-used Drive folder, a launch token, a conflict stash, or the
     server base URL a session happened to be pointed at. None of those keys
     are ever read by buildAppDataBundle(); assertNoSecrets() is the
     independent second check (invariant #48) that catches it anyway if one
     of them — or anything that merely LOOKS like a credential — ever gets
     added into this bundle by a future edit. */

  var APPDATA_FORMAT = "splitpage-app-data";
  var APPDATA_VERSION = 1;
  /* Same shape as 03a-history-store.js's own key-danger regex (invariant
     #48) — deliberately broad. A bookmark's "ssh":{"userHost":...} does not
     match any of these; if a future field ever does, that is exactly the bug
     this check exists to catch before the file is written. */
  var APPDATA_SECRET_RE = /token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i;

  function appDataReadRaw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function appDataReadJson(key, fallback) {
    var raw = appDataReadRaw(key);
    if (raw == null) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === undefined ? fallback : parsed;
    } catch (e) { return fallback; }
  }

  /* The version this page itself was built as (readEmbeddedVersion, from
     20a-update.js) when there is no desktop bridge to ask. */
  function appDataVersionString() {
    if (DESKTOP && typeof DESKTOP.appVersion === "string" && DESKTOP.appVersion) return DESKTOP.appVersion;
    var embedded = typeof readEmbeddedVersion === "function" ? readEmbeddedVersion() : null;
    return embedded || "";
  }

  /* → the AppDataBundle (X1). Every section is read in its own try/catch:
     one bad localStorage key (corrupt JSON, storage blocked) must not lose
     every other section, and a desktop backend's history rejection must not
     stop bookmarks or prefs from exporting. A section that failed comes back
     null/empty rather than throwing past this function — assertNoSecrets and
     any caller only ever see a complete, if partial, bundle. */
  async function buildAppDataBundle() {
    var bundle = {
      format: APPDATA_FORMAT,
      version: APPDATA_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: appDataVersionString()
    };

    try {
      bundle.snapshots = appDataReadJson(SNAPSHOT_KEY, null);
    } catch (e) {
      bundle.snapshots = null;
    }

    try {
      bundle.history = await exportHistoryAll();
    } catch (e) {
      bundle.history = null;
    }

    try {
      bundle.bookmarks = appDataReadJson(SERVER_BOOKMARKS_KEY, []);
      if (!Array.isArray(bundle.bookmarks)) bundle.bookmarks = [];
    } catch (e) {
      bundle.bookmarks = [];
    }

    try {
      bundle.prefs = {
        onboarding: appDataReadJson(ONBOARD_KEY, null),
        tourDone: appDataReadRaw(TOUR_DONE_KEY),
        commentAuthor: appDataReadRaw(COMMENT_NAME_KEY),
        commentsSort: appDataReadRaw(COMMENTS_SORT_KEY),
        writerSize: appDataReadRaw(WRITER_SIZE_KEY),
        taggingHelpDismissed: appDataReadRaw(TAGGING_HELP_KEY)
      };
    } catch (e) {
      bundle.prefs = {};
    }

    return bundle;
  }

  /* Invariant #48: walks every OWN key at every depth of the bundle (never
     the string VALUES — a document's own text or a snapshot's stateJson is
     free to contain the word "password" without tripping this) and throws
     the moment one looks like a credential. Called before a single byte is
     written; a throw here means nothing is saved and the caller shows the
     error toast instead. */
  function assertNoSecrets(value) {
    (function walk(v) {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) walk(v[i]);
        return;
      }
      var keys = Object.keys(v);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (APPDATA_SECRET_RE.test(key)) {
          var e = new Error("Export cancelled — the bundle contained something that looks like a " +
            "credential (" + key + "). This is a bug; please report it.");
          e.code = "secret";
          e.secretKey = key;
          throw e;
        }
        walk(v[key]);
      }
    })(value);
  }

  function appDataFilename() {
    var d = new Date();
    function pad(n) { return n < 10 ? "0" + n : String(n); }
    return "splitpage-app-data-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".json";
  }

  /* File ▸ Export app data… (browser only — 20f-desktop.js's initDesktop
     hides this entry and unhides "import-app-data" instead, X2). Gathers,
     asserts, then hands off to deliverFile() the same way every export in
     18-local-files.js already does (browser download, or the desktop native
     Save dialog on the rare case this ever runs there too). */
  async function exportAppData() {
    showToast("Gathering your Splitpage data…");
    /* Let the toast actually paint before the (possibly large) history read
       below runs on this same thread. */
    await new Promise(function (resolve) { setTimeout(resolve, 0); });

    var bundle;
    try {
      bundle = await buildAppDataBundle();
      assertNoSecrets(bundle);
    } catch (e) {
      showToast((e && e.message) || "Export cancelled — something went wrong building your app data.", "error");
      return;
    }

    var json;
    try {
      json = JSON.stringify(bundle, null, 2);
    } catch (e) {
      showToast("Could not build the export file.", "error");
      return;
    }

    await deliverFile(appDataFilename(), json, { savedMsg: "Exported your Splitpage app data" });
  }

  /* Import proper is X2's job (desktop surface): parseAppDataBundle(),
     importAppData() and the merge-through-the-history-store's-write-path
     rules (invariant #49) all land there. This stays a no-op stub so
     handleFileMenuAction's "import-app-data" branch (18-local-files.js) and
     the File-menu entry (page.html, hidden until 20f-desktop.js's
     initDesktop unhides it) have something to call without X1 reaching into
     desktop-only territory ahead of that step. */
  function openImportAppData() {
    /* no-op until X2 */
  }

  window.__appDataTest = {
    build: buildAppDataBundle,
    assertNoSecrets: assertNoSecrets
  };
