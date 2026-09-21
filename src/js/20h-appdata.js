  /* ================= export/import: the whole app's data =================

     File ▸ Export app data… (X1, this file) lets someone take their version
     history, server bookmarks and preferences to another machine or between
     the browser build and the desktop app — none of which live in a
     document, so opening a file never carries them. File ▸ Import app
     data… (X2, the second half of this file) is the merge on the receiving
     side: parse and refuse what did not come from this app, then MERGE,
     NEVER REPLACE — history only through importHistoryBundle
     (03a-history-store.js, invariant #49), bookmarks as a union where the
     existing entry wins, preferences only where this machine has none.

     Both directions run in every build. exportHistoryAll()
     (03a-history-store.js) reads through whichever history backend this
     page resolved to — IndexedDB/memory in the browser, or the desktop
     bridge's DESKTOP.historyListDocs() enumerating main's on-disk store —
     and buildAppDataBundle() below lets that one section fail on its own
     (a backend that cannot answer, say) without failing the whole export.

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
        taggingHelpDismissed: appDataReadRaw(TAGGING_HELP_KEY),
        autosave: appDataReadRaw(AUTOSAVE_KEY)
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

  /* File ▸ Export app data… (X1 — visible in both the browser and the
     desktop app; 20f-desktop.js's initDesktop no longer hides this entry).
     Gathers, asserts, then hands off to deliverFile() the same way every
     export in 18-local-files.js already does: a browser download, or the
     desktop native Save dialog. */
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

  /* ================= import (X2) ================= */

  /* A bundle is JSON text we hold whole in memory, and V8 cannot build a
     string much past this anyway; a bigger file is not ours. */
  var APPDATA_MAX_TEXT = 512 * 1024 * 1024;

  function appDataError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function appDataIsPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  function appDataNormalizeHistory(h) {
    if (!appDataIsPlainObject(h)) return null;
    /* Shape only. Every id and body is validated again by
       importHistoryBundle, which counts what it refuses — dropping a bad
       document here would hide it from that count. */
    return {
      docs: (Array.isArray(h.docs) ? h.docs : []).filter(appDataIsPlainObject).map(function (d) {
        return {
          docId: d.docId,
          title: typeof d.title === "string" ? d.title : "",
          lastOpenedAt: Number(d.lastOpenedAt) || 0,
          snapshots: Array.isArray(d.snapshots) ? d.snapshots : []
        };
      }),
      older: Array.isArray(h.older) ? h.older : [],
      truncated: !!h.truncated
    };
  }

  function appDataNormalizePrefs(p) {
    if (!appDataIsPlainObject(p)) return {};
    function str(v) { return typeof v === "string" ? v : null; }
    return {
      onboarding: appDataIsPlainObject(p.onboarding) ? p.onboarding : null,
      tourDone: str(p.tourDone),
      commentAuthor: str(p.commentAuthor),
      commentsSort: str(p.commentsSort),
      writerSize: str(p.writerSize),
      taggingHelpDismissed: str(p.taggingHelpDismissed),
      autosave: str(p.autosave)
    };
  }

  /* text → a normalised AppDataBundle, or throws an Error whose code is
     "not-json" | "too-large" | "wrong-format" | "newer-version" | "secret"
     and whose message is fit for a toast. Whole-file refusals only: a
     malformed SECTION (history not an object, bookmarks not an array) is
     dropped and the rest still imports.

     A key that looks like a credential anywhere in the file (invariant #48,
     the same walk export runs) refuses the whole file: this app never
     writes one, so a file carrying one was not made by this app and nothing
     else in it can be trusted to be what it claims. */
  function parseAppDataBundle(text) {
    if (typeof text !== "string") {
      throw appDataError("not-json", "That file isn't Splitpage app data (it isn't readable text).");
    }
    if (text.length > APPDATA_MAX_TEXT) {
      throw appDataError("too-large", "That file is too large to be Splitpage app data (over 512 MB).");
    }
    var raw;
    try { raw = JSON.parse(text); } catch (e) {
      throw appDataError("not-json", "That file isn't Splitpage app data (it isn't valid JSON).");
    }
    if (!appDataIsPlainObject(raw) || raw.format !== APPDATA_FORMAT ||
        typeof raw.version !== "number" || !isFinite(raw.version) || raw.version < 1) {
      throw appDataError("wrong-format", "That file isn't a Splitpage app data export.");
    }
    if (raw.version > APPDATA_VERSION) {
      throw appDataError("newer-version", "That app data was exported by a newer version of Splitpage. " +
        "Update this app, then import it again.");
    }
    try {
      assertNoSecrets(raw);
    } catch (e) {
      var refused = appDataError("secret", "Import refused — the file contains something that looks like a " +
        "credential (" + ((e && e.secretKey) || "unknown") + "). Splitpage never exports those, so this file " +
        "did not come from Splitpage.");
      refused.secretKey = e && e.secretKey;
      throw refused;
    }
    return {
      format: APPDATA_FORMAT,
      version: raw.version,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : null,
      appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
      snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : null,
      history: appDataNormalizeHistory(raw.history),
      bookmarks: (Array.isArray(raw.bookmarks) ? raw.bookmarks : []).filter(function (b) {
        return appDataIsPlainObject(b) && typeof b.url === "string";
      }),
      prefs: appDataNormalizePrefs(raw.prefs)
    };
  }

  /* Union by normalised URL. An existing bookmark always wins (its name,
     its ssh settings, its id); an imported one whose id is already taken
     gets a fresh one. Only the known fields are carried — {id, name, url,
     ssh:{userHost, remotePort, localPort}} — so nothing else in the file
     can ride into localStorage on a bookmark's back. */
  function appDataMergeBookmarks(list) {
    var out = { added: 0, skipped: 0, failed: 0 };
    if (!list || !list.length) return out;
    loadBookmarks();
    var byUrl = {}, ids = {};
    serverBookmarks.forEach(function (b) {
      var u = normalizeServerBase(b.url);
      if (u) byUrl[u] = true;
      if (typeof b.id === "string") ids[b.id] = true;
    });
    var fresh = [];
    list.forEach(function (b) {
      var url = normalizeServerBase(b.url);
      if (!url) { out.failed++; return; }
      if (byUrl[url]) { out.skipped++; return; }
      var id = (typeof b.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.id)) ? b.id : "";
      while (!id || ids[id]) id = newBookmarkId();
      var name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 200) : shortHost(url);
      var bookmark = { id: id, name: name, url: url };
      if (appDataIsPlainObject(b.ssh) && typeof b.ssh.userHost === "string" && b.ssh.userHost.trim()) {
        bookmark.ssh = {
          userHost: b.ssh.userHost.trim().slice(0, 300),
          remotePort: connectPortOr(b.ssh.remotePort, 8791),
          localPort: connectPortOr(b.ssh.localPort, 8791)
        };
      }
      byUrl[url] = true;
      ids[id] = true;
      fresh.push(bookmark);
      out.added++;
    });
    if (fresh.length) {
      serverBookmarks = serverBookmarks.concat(fresh);
      saveBookmarks();
      try {
        var modal = document.getElementById("connect-modal");
        if (modal && !modal.hidden) renderConnect();
        updateConnectMenu();
      } catch (e) { /* a re-render is a courtesy; the list is saved */ }
    }
    return out;
  }

  /* Each simple preference is written ONLY when this machine has no value
     for it at all — a local choice is never overwritten by an imported one.
     Values are checked against the shape the app itself writes; one that
     does not fit is ignored rather than stored for the app to choke on. */
  function appDataPrefSpecs() {
    return [
      { name: "tourDone", key: TOUR_DONE_KEY,
        valid: function (v) { return v.length > 0 && v.length <= 20; } },
      { name: "commentAuthor", key: COMMENT_NAME_KEY,
        valid: function (v) { return v.trim().length > 0 && v.length <= 200; } },
      { name: "commentsSort", key: COMMENTS_SORT_KEY,
        valid: function (v) { return v === "recent" || v === "position"; } },
      { name: "writerSize", key: WRITER_SIZE_KEY,
        valid: function (v) {
          var n = /^\d{1,3}$/.test(v) ? parseInt(v, 10) : NaN;
          return n >= WRITER_SIZE_MIN && n <= WRITER_SIZE_MAX;
        } },
      { name: "taggingHelpDismissed", key: TAGGING_HELP_KEY,
        valid: function (v) { return v === "0" || v === "1"; } },
      { name: "autosave", key: AUTOSAVE_KEY,
        valid: function (v) { return v === "0" || v === "1"; } }
    ];
  }

  function appDataMergePrefs(prefs) {
    var written = [];
    prefs = prefs || {};
    appDataPrefSpecs().forEach(function (spec) {
      var incoming = prefs[spec.name];
      if (typeof incoming !== "string" || !spec.valid(incoming)) return;
      if (appDataReadRaw(spec.key) != null) return;
      try {
        localStorage.setItem(spec.key, incoming);
        written.push(spec.name);
      } catch (e) { /* storage blocked — nothing to merge into */ }
    });

    /* Onboarding is an object, merged key by key with the LOCAL value
       winning. Only flat values travel (the app writes v/done/skipped/at).
       A local value that exists but is not a JSON object is left alone: it
       is this machine's value even if the wizard reads it as absent. */
    var inc = prefs.onboarding;
    if (appDataIsPlainObject(inc)) {
      var clean = {}, n = 0;
      Object.keys(inc).forEach(function (k) {
        var v = inc[k];
        if (n >= 20 || k === "__proto__" || k.length > 40) return;
        if (typeof v === "string") { clean[k] = v.slice(0, 200); n++; }
        else if (typeof v === "boolean" || (typeof v === "number" && isFinite(v))) { clean[k] = v; n++; }
      });
      var rawLocal = appDataReadRaw(ONBOARD_KEY);
      var local = rawLocal == null ? null : appDataReadJson(ONBOARD_KEY, undefined);
      if (n && (rawLocal == null || appDataIsPlainObject(local))) {
        var merged = {}, changed = rawLocal == null;
        Object.keys(clean).forEach(function (k) { merged[k] = clean[k]; });
        if (local) {
          Object.keys(local).forEach(function (k) {
            if (k === "__proto__") return;
            merged[k] = local[k];
          });
          Object.keys(clean).forEach(function (k) {
            if (!Object.prototype.hasOwnProperty.call(local, k)) changed = true;
          });
        }
        if (changed) {
          try {
            localStorage.setItem(ONBOARD_KEY, JSON.stringify(merged));
            written.push("onboarding");
          } catch (e) {}
        }
      }
    }

    /* The two preferences this page holds in memory as well. */
    try {
      if (written.indexOf("commentsSort") !== -1) commentSortMode = readCommentSortMode();
      if (written.indexOf("writerSize") !== -1) applyWriterSize(readWriterSize(), false);
    } catch (e) {}
    return written;
  }

  function appDataPlural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  var appDataLastSummary = null;

  /* text → the import's summary (also kept for __appDataTest.summary()).
     Never rejects. One toast says what arrived; a warn toast and a
     console.warn say what did not. */
  async function importAppData(text) {
    var bundle;
    try {
      bundle = parseAppDataBundle(text);
    } catch (e) {
      var refused = { ok: false, code: (e && e.code) || "invalid",
                      message: (e && e.message) || "That file could not be imported." };
      appDataLastSummary = refused;
      showToast(refused.message, "error");
      return refused;
    }

    var summary = { ok: true, history: null, bookmarks: null, prefs: [], legacy: null, toast: "", warning: null };

    /* The legacy shared list goes to Older, never back into localStorage
       ('splitpage-snapshots' is left exactly as this machine had it). Same
       content-derived ids as the one-time migration, so a list this machine
       already migrated dedupes instead of doubling. */
    var legacy = [];
    if (bundle.snapshots) {
      try { legacy = normalizeLegacySnapshots(JSON.stringify(bundle.snapshots)) || []; } catch (e) { legacy = []; }
      summary.legacy = legacy.length;
    }
    var hist = bundle.history || { docs: [], older: [] };
    summary.history = await importHistoryBundle({ docs: hist.docs, older: hist.older.concat(legacy) });

    try {
      summary.bookmarks = appDataMergeBookmarks(bundle.bookmarks);
    } catch (e) {
      if (window.console) console.error(e);
      summary.bookmarks = { added: 0, skipped: 0, failed: bundle.bookmarks.length };
    }

    try {
      summary.prefs = appDataMergePrefs(bundle.prefs);
    } catch (e) {
      if (window.console) console.error(e);
      summary.prefs = [];
    }

    var h = summary.history;
    var snapshots = h.added + h.older;
    summary.toast = "Imported " + appDataPlural(snapshots, "version-history snapshot", "version-history snapshots") +
      " across " + appDataPlural(h.docs, "document", "documents") + ", " +
      appDataPlural(summary.bookmarks.added, "server", "servers") + " and your preferences.";
    showToast(summary.toast, "ok");

    if (h.skipped || h.failed || h.code || summary.bookmarks.skipped || summary.bookmarks.failed) {
      if (window.console) {
        console.warn("Import app data: not everything was imported.", {
          history: h, bookmarks: summary.bookmarks, prefsWritten: summary.prefs
        });
      }
    }
    if (h.failed || h.code || summary.bookmarks.failed) {
      if (h.code === "quota") {
        summary.warning = "Import stopped — storage is full. " +
          appDataPlural(h.failed, "snapshot was", "snapshots were") + " not imported.";
      } else {
        summary.warning = "Some app data could not be imported: " +
          appDataPlural(h.failed, "snapshot", "snapshots") + ", " +
          appDataPlural(summary.bookmarks.failed, "server", "servers") + ". Details are in the console.";
      }
      showToast(summary.warning, "warn", true);
    }

    appDataLastSummary = summary;
    return summary;
  }

  /* File ▸ Import app data… (desktop — initDesktop unhides it). The page's
     own file input, deliberately not DESKTOP.openFileDialog(): main's filter
     lists script extensions only, and widening it would mean touching
     main.js. Wired on first use, so nothing here runs at boot. */
  var appDataInputWired = false;

  function openImportAppData() {
    var input = document.getElementById("import-app-data-input");
    if (!input) return;
    if (!appDataInputWired) {
      appDataInputWired = true;
      input.addEventListener("change", onImportAppDataChosen);
    }
    input.click();
  }

  async function onImportAppDataChosen(e) {
    var input = e.target;
    var file = input.files && input.files[0];
    if (!file) { input.value = ""; return; }
    try {
      if (file.size > APPDATA_MAX_TEXT) {
        showToast("That file is too large to be Splitpage app data (over 512 MB).", "error");
        return;
      }
      showToast("Importing your Splitpage data…");
      var text;
      try { text = await file.text(); } catch (err) {
        showToast("Could not read that file.", "error");
        return;
      }
      await importAppData(text);
    } finally {
      /* so picking the same file again still fires 'change' */
      input.value = "";
    }
  }

  window.__appDataTest = {
    build: buildAppDataBundle,
    assertNoSecrets: assertNoSecrets,
    parse: parseAppDataBundle,
    importText: importAppData,
    summary: function () { return appDataLastSummary; }
  };
