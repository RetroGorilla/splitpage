  /* ================= hosted documents =================

     Everything here is additive and inert unless the page was actually served
     by a Splitpage document server (server/server.js). Opened from a file://
     path, or from any plain static host, /api/health simply fails and the app
     behaves exactly as it always has — local files, local saves, no server.

     The compare-and-set save below is what the three-way merge at the top of
     this file was written for and has been waiting for: every PUT carries the
     rev this view loaded, the server rejects the write if anyone saved in the
     meantime and hands back their version, and mergeStates() reconciles the
     two instead of either side losing work.

     Authentication is deliberately absent, here and in the server: it belongs
     to Cloudflare Access (or a VPN) sitting in front. This code only ever
     *reads* who Access says you are, to fill in a name. */

  var serverMode = { available: false, readOnly: false, checked: false };
  var serverDoc = { id: null, rev: 0 };   /* the hosted document we are editing */
  var serverIdentity = null;              /* { email, name } from Cloudflare Access */
  var serverSessionExpired = false;
  var serverDocs = [];                    /* last listing, for the picker */

  function onServerDoc() { return !!serverDoc.id; }

  /* A Cloudflare Access session that has expired does not fail — it answers
     200 with an HTML sign-in page. Left undetected that lands as "unexpected
     token <" in the middle of an autosave, or worse, looks like success. Any
     answer that is redirected or is not JSON is treated as a lapsed session. */
  function ApiError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  async function apiFetch(path, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(path, {
        method: opts.method || "GET",
        headers: opts.body
          ? { "Content-Type": "application/json", "Accept": "application/json" }
          : { "Accept": "application/json" },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: "same-origin",
        cache: "no-store"
      });
    } catch (e) {
      throw ApiError("offline", "no answer from the server");
    }

    var ctype = res.headers.get("content-type") || "";
    if (res.redirected || (!ctype.includes("application/json") && res.status !== 204)) {
      throw ApiError("auth", "signed out");
    }
    if (res.status === 401 || res.status === 403) {
      /* a real 403 from our own server (READ_ONLY) still answers JSON, so
         separate the two rather than calling everything an auth failure */
      var body403 = await res.json().catch(function () { return null; });
      if (body403 && body403.error === "read-only") throw ApiError("read-only", "read-only");
      throw ApiError("auth", "signed out");
    }

    var body = res.status === 204 ? null : await res.json().catch(function () { return null; });
    if (res.status === 409) { var c = ApiError("conflict"); c.payload = body; throw c; }
    if (!res.ok) throw ApiError(String(res.status), (body && body.error) || ("HTTP " + res.status));
    return body;
  }

  /* Once the session has lapsed, every queued autosave would fire the same
     failure again. Latch it, say so once, and let a reload clear it — the
     conflict stash already carries unsaved work across that reload. */
  var SERVER_RESUME_KEY = "splitpage-server-resume";

  function flagServerSessionExpired() {
    if (serverSessionExpired) return;
    serverSessionExpired = true;
    /* Stash before promising anything. stashLocalWork() was written for the
       artifact shell's forced reload and had sat unused ever since; this is
       the same situation it was built for — the only way back is a reload,
       and everything typed since the last save would go with it. Only claim
       the work is safe if it actually got persisted. */
    var stashed = false;
    if (onServerDoc()) {
      try {
        sessionStorage.setItem(SERVER_RESUME_KEY, JSON.stringify({ id: serverDoc.id, rev: serverDoc.rev }));
        stashed = stashLocalWork();
        if (!stashed) sessionStorage.removeItem(SERVER_RESUME_KEY);
      } catch (e) { stashed = false; }
    }
    showToast(stashed
      ? "Your sign-in expired. Reload the page to sign in again — your unsaved edits are kept and will be merged back in."
      : "Your sign-in expired. Copy anything unsaved, then reload the page to sign in again.",
      "warn", true);
    updateFileChip();
  }

  /* Coming back after signing in again: reopen the document that was open and
     merge the stashed edits into whatever it looks like now — which may have
     moved on, since the sign-in could have taken a while. Same three-way
     merge as a save conflict, for the same reason. */
  async function resumeServerDoc() {
    var pending;
    try {
      var raw = sessionStorage.getItem(SERVER_RESUME_KEY);
      pending = raw ? JSON.parse(raw) : null;
    } catch (e) { pending = null; }
    if (!pending || !pending.id) return false;

    /* init() fires detectServer() (which leads here) and loadInitialState()
       concurrently with no coordination between them — loadInitialState()
       resolves almost immediately and renders a blank, fully editable
       document, while this is still doing network round trips. Remember
       what was on screen and the edit counter before awaiting anything, so
       keystrokes typed into that transitional document during the wait can
       be recovered rather than silently overwritten below. */
    var seqAtStart = editSeq;
    var stateAtStart = state ? cloneState(state) : null;

    var body;
    try {
      body = await apiFetch("api/docs/" + encodeURIComponent(pending.id));
    } catch (err) {
      /* still signed out, or the document is gone — leave SERVER_RESUME_KEY
         (and the stash it points at) alone so a later reload can still
         recover it. Removing it here, before success is known, is what
         applyStashedWork() (14-export.js) uses to decide a stash belongs to
         a fresh/local document rather than this hosted one — clear it too
         early and a later reload would splice this doc's stashed edits into
         an unrelated blank document instead. */
      return false;
    }
    try { sessionStorage.removeItem(SERVER_RESUME_KEY); } catch (e) {}

    var stash = readStash();
    var theirs = migrateRows(cloneState(body.state));
    serverDoc = { id: body.id, rev: body.rev || 0 };
    htmlFileHandle = null;
    resetProductionPanelState();

    var typedDuringResume = stateAtStart && editSeq !== seqAtStart;

    if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) {
      if (typedDuringResume) {
        var freshResult = mergeStates(stateAtStart, migrateRows(cloneState(state)), theirs, false);
        state = freshResult.merged;
        baseState = cloneState(theirs);
        render();
        updateIdentityChip();
        updateFileChip();
        showToast("Signed back in — merged what you typed while " + (state.title || body.id) + " was reopening", "warn", true);
        reportMerge(freshResult);
        return true;
      }
      state = theirs;
      baseState = cloneState(state);
      clearDirty();
      render();
      updateIdentityChip();
      updateFileChip();
      showToast("Signed back in — reopened " + (state.title || body.id), "ok");
      return true;
    }

    clearStash();
    var mine = migrateRows(cloneState(stash.mine));
    if (typedDuringResume) {
      /* fold the keystrokes typed on top of the blank interim document into
         what the stash already remembers as "mine", so both survive the
         three-way merge below rather than one silently replacing the other. */
      mine = mergeStates(stateAtStart, migrateRows(cloneState(state)), mine, false).merged;
    }
    var result = mergeStates(
      stash.base ? migrateRows(cloneState(stash.base)) : null,
      mine,
      theirs,
      !!stash.imagesStripped
    );
    state = result.merged;
    baseState = cloneState(theirs);
    render();
    updateIdentityChip();
    updateFileChip();
    showToast("Signed back in — your unsaved edits were merged back in", "ok");
    reportMerge(result);   /* leaves it dirty and queues the save, which is right */
    return true;
  }

  function handleApiError(err, whatFailed) {
    if (err && err.code === "auth") { flagServerSessionExpired(); return; }
    if (err && err.code === "read-only") {
      showToast("This server is published read-only — save a copy to your own disk instead.", "warn");
      return;
    }
    showToast(whatFailed + " — " + ((err && err.message) || "please try again") + ".", "error");
  }

  async function detectServer() {
    if (location.protocol === "file:") { serverMode.checked = true; return; }
    try {
      var health = await apiFetch("api/health");
      serverMode.available = !!(health && health.ok);
      serverMode.readOnly = !!(health && health.readOnly);
    } catch (e) {
      serverMode.available = false;
    }
    serverMode.checked = true;
    if (!serverMode.available) return;

    /* Access hands us a verified email; use it for attribution so reviewers
       don't have to introduce themselves, but never overwrite a name someone
       has deliberately set for themselves. */
    try {
      serverIdentity = await apiFetch("api/me");
      if (serverIdentity && serverIdentity.name && !getSavedAuthorName()) {
        saveAuthorName(serverIdentity.name);
        updateIdentityChip();
      }
    } catch (e) { /* identity is a nicety, not a requirement */ }

    updateServerMenu();
    resumeServerDoc();
  }

  function updateServerMenu() {
    ["menu-server-open", "menu-server-new"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = !serverMode.available;
    });
    var sep = document.getElementById("menu-server-sep");
    if (sep) sep.hidden = !serverMode.available;
    var newBtn = document.getElementById("menu-server-new");
    if (newBtn) newBtn.disabled = serverMode.readOnly;
  }

  /* ---- the picker ---- */

  async function openServerPicker() {
    var modal = document.getElementById("server-modal");
    var list = document.getElementById("server-doc-list");
    modal.hidden = false;
    list.innerHTML = '<div class="comments-empty">Loading…</div>';
    try {
      var body = await apiFetch("api/docs");
      serverDocs = (body && body.docs) || [];
    } catch (err) {
      list.innerHTML = '<div class="comments-empty">Could not reach the server.</div>';
      handleApiError(err, "Could not list the documents");
      return;
    }
    renderServerPicker();
  }

  function closeServerPicker() {
    document.getElementById("server-modal").hidden = true;
  }

  function renderServerPicker() {
    var list = document.getElementById("server-doc-list");
    if (!serverDocs.length) {
      list.innerHTML = '<div class="comments-empty">No documents on the server yet.<br><br>' +
        'Use <strong>Put this script on the server</strong> in the File menu to publish the ' +
        'one you have open.</div>';
      return;
    }
    list.innerHTML = serverDocs.map(function (d) {
      var isOpen = d.id === serverDoc.id;
      return '<div class="server-doc' + (isOpen ? ' is-current' : '') + '" data-id="' + escapeHtml(d.id) + '">' +
        '<button type="button" class="server-doc-open" data-action="server-open" data-id="' +
          escapeHtml(d.id) + '">' +
          '<span class="server-doc-title">' + escapeHtml(d.title || "Untitled Script") + '</span>' +
          '<span class="server-doc-meta">' + d.rows + ' scene' + (d.rows === 1 ? '' : 's') +
            ' · v' + d.rev +
            (d.updatedBy ? ' · ' + escapeHtml(d.updatedBy) : '') +
            (d.updatedAt ? ' · ' + escapeHtml(formatTimestamp(d.updatedAt)) : '') +
          '</span>' +
        '</button>' +
        (isOpen ? '<span class="server-doc-current">Open</span>' : '') +
        (serverMode.readOnly ? '' :
          '<button type="button" class="server-doc-delete" data-action="server-delete" data-id="' +
            escapeHtml(d.id) + '" title="Delete this document from the server">×</button>') +
      '</div>';
    }).join("");
  }

  async function openServerDoc(id) {
    var body;
    try {
      body = await apiFetch("api/docs/" + encodeURIComponent(id));
    } catch (err) { handleApiError(err, "Could not open that document"); return; }
    if (!body || !body.state) { showToast("That document is empty.", "warn"); return; }

    if (state && state.rows.length) pushSnapshot("Before opening " + (body.state.title || id));

    state = migrateRows(body.state);
    baseState = cloneState(state);
    serverDoc = { id: body.id, rev: body.rev || 0 };
    /* a hosted document and a local file are different homes for the same
       Save button — holding both would make it ambiguous which one it writes */
    htmlFileHandle = null;
    openedFile = { name: null, handle: null, kind: null, dirty: false, inPlace: false };
    resetProductionPanelState();

    clearDirty();
    render();
    updateIdentityChip();
    updateFileChip();
    closeServerPicker();
    showToast("Opened " + (state.title || id) + " from the server — " + state.rows.length +
      " scene" + (state.rows.length === 1 ? "" : "s"), "ok");
  }

  async function publishToServer() {
    if (serverMode.readOnly) { showToast("This server is published read-only.", "warn"); return; }
    var published = cloneState(state);
    var body;
    try {
      body = await apiFetch("api/docs", { method: "POST", body: { state: published, by: getEditorName() } });
    } catch (err) { handleApiError(err, "Could not put that on the server"); return; }
    serverDoc = { id: body.id, rev: body.rev || 1 };
    baseState = published;
    htmlFileHandle = null;
    clearDirty();
    updateFileChip();
    showToast("Published to the server as “" + (state.title || body.id) + "” — collaborators can open it now", "ok");
  }

  async function armServerDelete(btn, id) {
    if (btn.getAttribute("data-armed") === "1") {
      try {
        await apiFetch("api/docs/" + encodeURIComponent(id), { method: "DELETE" });
      } catch (err) { handleApiError(err, "Could not delete that document"); return; }
      if (serverDoc.id === id) serverDoc = { id: null, rev: 0 };
      serverDocs = serverDocs.filter(function (d) { return d.id !== id; });
      renderServerPicker();
      updateFileChip();
      showToast("Deleted from the server", "ok");
      return;
    }
    btn.setAttribute("data-armed", "1");
    btn.textContent = "Delete?";
    btn.classList.add("armed");
    setTimeout(function () {
      if (!btn.isConnected) return;
      btn.removeAttribute("data-armed");
      btn.textContent = "×";
      btn.classList.remove("armed");
    }, 2800);
  }

  /* ---- the compare-and-set save ----

     Returns true when the document is safely on the server. A 409 means
     somebody saved between our load and our write: we take their version,
     three-way merge it against the base this view still holds, and try again
     against their rev. Bounded, because a busy document could otherwise spin
     here forever — three rounds is far more contention than a script gets. */
  async function saveToServer() {
    if (serverSessionExpired) return false;
    /* The server picker is never disabled while a save is in flight, so
       openServerDoc() can reassign serverDoc/state/baseState to a different
       hosted document mid-save. Remember which document THIS call is for,
       and refuse to write a result — success or conflict — into whatever
       serverDoc/state/baseState point at now if it has moved on. */
    var docId = serverDoc.id;
    var attempts = 0;
    var mergeResult = null;

    while (attempts < 3) {
      attempts++;
      if (serverDoc.id !== docId) return false;
      state.rev = (state.rev || 0) + 1;
      state.lastEditedBy = getEditorName();
      state.lastEditedAt = nowIso();
      var published = cloneState(state);
      var seqAtSave = editSeq;
      var baseRevAtSave = serverDoc.rev;

      try {
        var body = await apiFetch("api/docs/" + encodeURIComponent(docId), {
          method: "PUT",
          body: { baseRev: baseRevAtSave, state: published, by: getEditorName() }
        });
        if (serverDoc.id !== docId) return true; /* saved, but the open document has since changed */
        serverDoc.rev = body.rev;
        baseState = published;
        if (editSeq === seqAtSave) clearDirty();
        updateFileChip();
        /* reported only once the merged result is actually stored, so the
           banner can never describe a merge that failed to save */
        if (mergeResult) reportMerge(mergeResult, { alreadySaved: true });
        return true;
      } catch (err) {
        if (serverDoc.id !== docId) return false;
        state.rev = Math.max(0, (state.rev || 1) - 1);

        if (err && err.code === "conflict" && err.payload && err.payload.state) {
          var theirs = migrateRows(cloneState(err.payload.state));
          pushSnapshot("Before merging in someone else's changes", cloneState(state));
          mergeResult = mergeStates(
            baseState ? migrateRows(cloneState(baseState)) : null,
            migrateRows(cloneState(state)),
            theirs
          );
          state = mergeResult.merged;
          serverDoc.rev = err.payload.rev || serverDoc.rev;
          render();
          continue; /* try again against their rev */
        }

        if (err && err.code === "not-found") {
          showToast("That document is no longer on the server. Use “Put this script on the server” to publish it again.", "warn");
          serverDoc = { id: null, rev: 0 };
          updateFileChip();
          return false;
        }
        handleApiError(err, "Could not save to the server");
        return false;
      }
    }
    showToast("Someone else kept saving while we merged — try Save again in a moment.", "warn");
    return false;
  }

  /* ================= Google Drive file manager =================

     A standalone file browser for a publicly shared Google Drive folder —
     separate from the script editor's own open/save flow above. Two
     different things need two different credentials, because Google splits
     them that way:

     - Listing a public folder and downloading its files works anonymously,
       identified only by an API key. Google still checks each file's own
       sharing permission — this only works because the folder is public.
     - Anything that changes Drive (upload, rename, delete, new folder)
       always needs a real signed-in Google account, even on a folder
       "anyone with the link" can edit — an API key alone carries no
       identity Drive will accept for a write. That needs an OAuth Client ID
       and a sign-in click (Google Identity Services' token client), and
       whoever signs in must actually have edit access to the folder.

     Splitpage has no backend of its own to hold either credential, so
     whoever uses this pastes their own, once, in a small setup form. They
     are kept in localStorage only — never sent anywhere but Google's APIs. */

  var DRIVE_KEY_STORE = "splitpage-drive-api-key";
  var DRIVE_CLIENT_STORE = "splitpage-drive-client-id";
  var DRIVE_FOLDER_STORE = "splitpage-drive-last-folder";
  var DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

  var driveCreds = { apiKey: "", clientId: "" };
  var driveState = {
    connected: false,
    path: [],           /* [{id, name}], root folder first */
    items: [],           /* last listing for the folder on top of path */
    tokenClient: null,
    accessToken: "",
    tokenExpiresAt: 0,
    signedIn: false
  };
  var driveGisPromise = null;
  var driveEditingId = null;

  function loadDriveCreds() {
    try {
      driveCreds.apiKey = localStorage.getItem(DRIVE_KEY_STORE) || "";
      driveCreds.clientId = localStorage.getItem(DRIVE_CLIENT_STORE) || "";
    } catch (e) { /* private browsing etc. — just start empty */ }
  }

  function driveLastFolder() {
    try { return localStorage.getItem(DRIVE_FOLDER_STORE) || ""; } catch (e) { return ""; }
  }

  function driveHasCreds() { return !!(driveCreds.apiKey && driveCreds.clientId); }

  function saveDriveCreds(apiKey, clientId) {
    driveCreds.apiKey = (apiKey || "").trim();
    driveCreds.clientId = (clientId || "").trim();
    try {
      localStorage.setItem(DRIVE_KEY_STORE, driveCreds.apiKey);
      localStorage.setItem(DRIVE_CLIENT_STORE, driveCreds.clientId);
    } catch (e) { /* not fatal — creds just won't survive a reload */ }
  }

  function openDriveModal() {
    loadDriveCreds();
    document.getElementById("drive-modal").hidden = false;
    document.getElementById("drive-folder-input").value = driveLastFolder();
    renderDriveSetup();
  }

  function closeDriveModal() {
    document.getElementById("drive-modal").hidden = true;
  }

  function driveShowCredsForm() {
    document.getElementById("drive-setup").hidden = false;
    document.getElementById("drive-main").hidden = true;
  }

  function renderDriveSetup() {
    var hasCreds = driveHasCreds();
    document.getElementById("drive-setup").hidden = hasCreds;
    document.getElementById("drive-main").hidden = !hasCreds;
    if (!hasCreds) return;
    document.getElementById("drive-api-key").value = driveCreds.apiKey;
    document.getElementById("drive-client-id").value = driveCreds.clientId;
    document.getElementById("drive-browser").hidden = !driveState.connected;
    renderDriveAccount();
  }

  function driveSaveCredsFromForm() {
    var apiKey = document.getElementById("drive-api-key").value;
    var clientId = document.getElementById("drive-client-id").value;
    if (!apiKey.trim() || !clientId.trim()) { showToast("Both fields are needed.", "warn"); return; }
    saveDriveCreds(apiKey, clientId);
    renderDriveSetup();
    showToast("Saved — now paste a folder link below.", "ok");
  }

  /* Accepts a full folder URL (drive.google.com/drive/folders/<id>, with or
     without ?usp=sharing and the rest), or a bare folder ID pasted straight
     from one. */
  function parseDriveFolderId(input) {
    input = (input || "").trim();
    if (!input) return "";
    var m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(input);
    if (m) return m[1];
    m = /[?&]id=([a-zA-Z0-9_-]+)/.exec(input);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input;
    return "";
  }

  function driveApiKeyParam() { return "key=" + encodeURIComponent(driveCreds.apiKey); }

  async function driveFetch(url, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (driveState.accessToken && driveState.tokenExpiresAt > Date.now()) {
      headers = Object.assign({}, headers, { "Authorization": "Bearer " + driveState.accessToken });
    }
    var res = await fetch(url, { method: opts.method || "GET", headers: headers, body: opts.body });
    if (!res.ok) {
      var msg = "request failed (" + res.status + ")";
      try {
        var body = await res.json();
        if (body && body.error && body.error.message) msg = body.error.message;
      } catch (e) {}
      throw new Error(msg);
    }
    return res;
  }

  async function driveConnect(rawInput) {
    if (!driveHasCreds()) { showToast("Add your Google API key and Client ID first.", "warn"); return; }
    var id = parseDriveFolderId(rawInput);
    if (!id) { showToast("That doesn't look like a Drive folder link or ID.", "warn"); return; }
    var btn = document.getElementById("drive-connect-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
    try {
      var url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) +
        "?fields=" + encodeURIComponent("id,name,mimeType") + "&supportsAllDrives=true&" + driveApiKeyParam();
      var res = await driveFetch(url);
      var meta = await res.json();
      if (meta.mimeType !== "application/vnd.google-apps.folder") {
        showToast("That's a file, not a folder — paste a folder link.", "warn");
        return;
      }
      driveState.connected = true;
      driveState.path = [{ id: meta.id, name: meta.name || "Drive folder" }];
      driveEditingId = null;
      try { localStorage.setItem(DRIVE_FOLDER_STORE, rawInput.trim()); } catch (e) {}
      document.getElementById("drive-browser").hidden = false;
      await driveListCurrent();
    } catch (err) {
      showToast("Could not open that folder — " + err.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Open folder"; }
    }
  }

  async function driveListCurrent() {
    var folder = driveState.path[driveState.path.length - 1];
    var list = document.getElementById("drive-list");
    list.innerHTML = '<div class="drive-empty">Loading…</div>';
    try {
      var q = encodeURIComponent("'" + folder.id.replace(/'/g, "\\'") + "' in parents and trashed = false");
      var url = "https://www.googleapis.com/drive/v3/files?q=" + q +
        "&fields=" + encodeURIComponent("files(id,name,mimeType,size,modifiedTime,webViewLink)") +
        "&orderBy=" + encodeURIComponent("folder,name") +
        "&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&" + driveApiKeyParam();
      var res = await driveFetch(url);
      var body = await res.json();
      driveState.items = body.files || [];
      renderDriveBreadcrumb();
      renderDriveList();
    } catch (err) {
      list.innerHTML = '<div class="drive-empty">Could not load this folder — ' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderDriveBreadcrumb() {
    var el = document.getElementById("drive-breadcrumb");
    el.innerHTML = driveState.path.map(function (p, i) {
      var isLast = i === driveState.path.length - 1;
      return isLast
        ? '<span class="drive-crumb-current">' + escapeHtml(p.name) + '</span>'
        : '<button type="button" class="drive-crumb" data-action="drive-crumb" data-index="' + i + '">' +
            escapeHtml(p.name) + '</button><span class="drive-crumb-sep">/</span>';
    }).join("");
  }

  function driveCrumbTo(index) {
    driveState.path = driveState.path.slice(0, index + 1);
    driveEditingId = null;
    driveListCurrent();
  }

  function driveItemById(id) {
    var found = driveState.items.filter(function (it) { return it.id === id; });
    return found[0] || null;
  }

  function driveIconFor(mimeType) {
    if (mimeType === "application/vnd.google-apps.folder") return "📁";
    if (mimeType === "application/vnd.google-apps.document") return "📝";
    if (mimeType === "application/vnd.google-apps.spreadsheet") return "📊";
    if (mimeType === "application/vnd.google-apps.presentation") return "📑";
    if (/^image\//.test(mimeType)) return "🖼";
    if (/^video\//.test(mimeType)) return "🎬";
    if (/^audio\//.test(mimeType)) return "🎵";
    if (mimeType === "application/pdf") return "📕";
    return "📄";
  }

  function driveFormatSize(bytes) {
    var n = Number(bytes);
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function renderDriveList() {
    var list = document.getElementById("drive-list");
    if (!driveState.items.length) {
      list.innerHTML = '<div class="drive-empty">This folder is empty.</div>';
      return;
    }
    var canWrite = driveState.signedIn;
    list.innerHTML = driveState.items.map(function (it) {
      var isFolder = it.mimeType === "application/vnd.google-apps.folder";
      if (driveEditingId === it.id) {
        return '<div class="drive-row is-editing" data-id="' + escapeHtml(it.id) + '">' +
          '<span class="drive-row-icon">' + driveIconFor(it.mimeType) + '</span>' +
          '<input type="text" class="drive-rename-input" data-id="' + escapeHtml(it.id) +
            '" value="' + escapeHtml(it.name) + '">' +
          '<button type="button" class="drive-row-btn" data-action="drive-rename-save" data-id="' +
            escapeHtml(it.id) + '" title="Save">✓</button>' +
          '<button type="button" class="drive-row-btn" data-action="drive-rename-cancel" title="Cancel">×</button>' +
        '</div>';
      }
      return '<div class="drive-row" data-id="' + escapeHtml(it.id) + '">' +
        '<button type="button" class="drive-row-open" data-action="drive-open-item" data-id="' + escapeHtml(it.id) + '">' +
          '<span class="drive-row-icon">' + driveIconFor(it.mimeType) + '</span>' +
          '<span class="drive-row-name">' + escapeHtml(it.name) + '</span>' +
          '<span class="drive-row-meta">' + (isFolder ? "Folder" : driveFormatSize(it.size)) +
            (it.modifiedTime ? ' · ' + escapeHtml(formatTimestamp(it.modifiedTime)) : '') + '</span>' +
        '</button>' +
        '<div class="drive-row-actions">' +
          (canWrite ? '<button type="button" class="drive-row-btn" data-action="drive-rename" data-id="' +
            escapeHtml(it.id) + '" title="Rename">✎</button>' : '') +
          (canWrite ? '<button type="button" class="drive-row-btn danger" data-action="drive-delete" data-id="' +
            escapeHtml(it.id) + '" title="Delete">×</button>' : '') +
        '</div>' +
      '</div>';
    }).join("");
  }

  async function driveOpenItem(id) {
    var it = driveItemById(id);
    if (!it) return;
    if (it.mimeType === "application/vnd.google-apps.folder") {
      driveState.path.push({ id: it.id, name: it.name });
      driveEditingId = null;
      await driveListCurrent();
      return;
    }
    await driveDownloadFile(it);
  }

  var DRIVE_EXPORT_MIME = {
    "application/vnd.google-apps.document":
      { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
    "application/vnd.google-apps.spreadsheet":
      { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
    "application/vnd.google-apps.presentation":
      { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" }
  };

  async function driveDownloadFile(it) {
    var exportInfo = DRIVE_EXPORT_MIME[it.mimeType];
    var url, filename = it.name;
    if (exportInfo) {
      url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(it.id) +
        "/export?mimeType=" + encodeURIComponent(exportInfo.mime) + "&" + driveApiKeyParam();
      if (!/\.[a-z0-9]+$/i.test(filename)) filename += exportInfo.ext;
    } else if (/^application\/vnd\.google-apps\./.test(it.mimeType)) {
      /* forms, sites, drawings, and the like have no clean export — send
         the user to Drive itself rather than pretend to download something */
      window.open(it.webViewLink || ("https://drive.google.com/open?id=" + it.id), "_blank", "noopener");
      return;
    } else {
      url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(it.id) + "?alt=media&" + driveApiKeyParam();
    }
    try {
      var res = await driveFetch(url);
      var blob = await res.blob();
      await deliverFile(filename, blob);
    } catch (err) {
      showToast("Could not download " + it.name + " — " + err.message, "error");
    }
  }

  function driveStartRename(id) {
    driveEditingId = id;
    renderDriveList();
    var input = document.querySelector('.drive-rename-input[data-id="' + id + '"]');
    if (input) { input.focus(); input.select(); }
  }

  function driveCancelRename() {
    driveEditingId = null;
    renderDriveList();
  }

  async function driveSaveRename(id) {
    var input = document.querySelector('.drive-rename-input[data-id="' + id + '"]');
    var name = input ? input.value.trim() : "";
    var item = driveItemById(id);
    driveEditingId = null;
    if (!name || !item || name === item.name) { renderDriveList(); return; }
    try {
      await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?fields=id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name })
      });
      showToast("Renamed to “" + name + "”", "ok");
    } catch (err) {
      showToast("Could not rename — " + err.message, "error");
    }
    await driveListCurrent();
  }

  async function armDriveDelete(btn, item) {
    if (btn.getAttribute("data-armed") === "1") {
      try {
        await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(item.id), { method: "DELETE" });
      } catch (err) {
        showToast("Could not delete “" + item.name + "” — " + err.message, "error");
        return;
      }
      showToast("Deleted “" + item.name + "”", "ok");
      await driveListCurrent();
      return;
    }
    btn.setAttribute("data-armed", "1");
    btn.textContent = "Delete?";
    btn.classList.add("armed");
    setTimeout(function () {
      if (!btn.isConnected) return;
      btn.removeAttribute("data-armed");
      btn.textContent = "×";
      btn.classList.remove("armed");
    }, 2800);
  }

  var driveNewFolderOpen = false;

  function toggleDriveNewFolder(force) {
    driveNewFolderOpen = force === undefined ? !driveNewFolderOpen : force;
    var row = document.getElementById("drive-newfolder-row");
    row.hidden = !driveNewFolderOpen;
    var input = document.getElementById("drive-newfolder-input");
    if (driveNewFolderOpen) { input.value = ""; input.focus(); }
  }

  async function driveCreateFolder() {
    if (!driveState.signedIn) { showToast("Sign in with Google first.", "warn"); toggleDriveNewFolder(false); return; }
    var input = document.getElementById("drive-newfolder-input");
    var name = input ? input.value.trim() : "";
    if (!name) { toggleDriveNewFolder(false); return; }
    var parent = driveState.path[driveState.path.length - 1];
    try {
      await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, mimeType: "application/vnd.google-apps.folder", parents: [parent.id] })
      });
      showToast("Created “" + name + "”", "ok");
    } catch (err) {
      showToast("Could not create the folder — " + err.message, "error");
    }
    toggleDriveNewFolder(false);
    await driveListCurrent();
  }

  async function driveUploadOne(file, parentId) {
    var metadata = { name: file.name, parents: [parentId] };
    var boundary = "splitpage-" + Math.random().toString(36).slice(2);
    var fileBuf = await file.arrayBuffer();
    var encoder = new TextEncoder();
    var head = encoder.encode(
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: " + (file.type || "application/octet-stream") + "\r\n\r\n"
    );
    var tail = encoder.encode("\r\n--" + boundary + "--");
    var body = new Blob([head, fileBuf, tail]);
    await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + boundary },
      body: body
    });
  }

  async function driveUploadFiles(fileList) {
    if (!driveState.signedIn) { showToast("Sign in with Google first.", "warn"); return; }
    var parent = driveState.path[driveState.path.length - 1];
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var failed = 0;
    for (var i = 0; i < files.length; i++) {
      try { await driveUploadOne(files[i], parent.id); }
      catch (err) { failed++; showToast("Could not upload " + files[i].name + " — " + err.message, "error"); }
    }
    if (files.length - failed > 0) {
      showToast("Uploaded " + (files.length - failed) + " file" + (files.length - failed === 1 ? "" : "s"), "ok");
    }
    await driveListCurrent();
  }

  /* ---- sign-in, via Google Identity Services' token client (no backend,
     no redirect — just a popup that hands back an access token) ---- */

  function loadGisScript() {
    if (driveGisPromise) return driveGisPromise;
    driveGisPromise = new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) { resolve(); return; }
      var s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("could not reach Google's sign-in script")); };
      document.head.appendChild(s);
    });
    return driveGisPromise;
  }

  function renderDriveAccount() {
    var el = document.getElementById("drive-account");
    if (!el) return;
    el.innerHTML = driveState.signedIn
      ? '<span class="drive-account-status">✓ Signed in — you can make changes here.</span>' +
        '<button type="button" class="btn" data-action="drive-signout">Sign out</button>'
      : '<span class="drive-account-status">Read-only until you sign in.</span>' +
        '<button type="button" class="btn btn-accent" data-action="drive-signin">Sign in with Google</button>';
    updateDriveWriteButtons();
  }

  /* New folder / Upload live in the toolbar rather than per-row, so they
     can't just be left out of the markup the way rename/delete are — disable
     them instead, with a title explaining why. */
  function updateDriveWriteButtons() {
    var disabled = !driveState.signedIn;
    var reason = disabled ? "Sign in with Google first" : "";
    var nf = document.getElementById("drive-newfolder-toggle");
    if (nf) { nf.disabled = disabled; nf.title = reason; }
    var up = document.querySelector('#drive-browser [data-action="drive-upload"]');
    if (up) { up.disabled = disabled; up.title = reason; }
  }

  async function driveSignIn() {
    if (!driveCreds.clientId) { showToast("Add your OAuth Client ID first.", "warn"); return; }
    if (location.protocol === "file:") {
      showToast("Sign-in needs this page served over http/https, not opened from disk.", "warn");
      return;
    }
    try { await loadGisScript(); } catch (err) { showToast(err.message, "error"); return; }
    if (!driveState.tokenClient) {
      driveState.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: driveCreds.clientId,
        scope: DRIVE_SCOPE,
        callback: function (resp) {
          if (resp && resp.access_token) {
            driveState.accessToken = resp.access_token;
            driveState.tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 30000;
            driveState.signedIn = true;
            renderDriveAccount();
            renderDriveList();
            showToast("Signed in — you can now upload, rename, and delete here.", "ok");
          }
        },
        error_callback: function (err) {
          showToast("Google sign-in was cancelled or failed" + (err && err.type ? " (" + err.type + ")" : "") + ".", "warn");
        }
      });
    }
    driveState.tokenClient.requestAccessToken({ prompt: driveState.signedIn ? "" : "consent" });
  }

  function driveSignOut() {
    if (driveState.accessToken && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(driveState.accessToken, function () {});
    }
    driveState.accessToken = "";
    driveState.tokenExpiresAt = 0;
    driveState.signedIn = false;
    renderDriveAccount();
    renderDriveList();
  }
