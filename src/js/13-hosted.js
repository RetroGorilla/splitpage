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

     WHO YOU ARE is still not this app's business. Real authentication belongs
     to Cloudflare Access (or a VPN) sitting in front of the server, and this
     code only ever *reads* who Access says you are, to fill in a name.

     What this file does now carry is a join PIN — a shared code a LAN host
     can set so a stranger on the same wifi cannot simply open the address and
     read everything. Post the PIN once, get a token, send that token with
     every request. It is a door lock, not an identity: it says you were told
     the code, nothing more, and it travels in the clear over plain HTTP. A
     server on the internet still needs Access in front of it.

     A page can also be pointed at a server that did not serve it —
     `serverBase` — so a copy on disk, or one served by a different machine,
     can open documents from someone's shared session. That needs the server
     to allow this origin (ALLOW_ORIGINS) and, if it has one, the PIN.

     ALL OF THIS IS BROWSER STATE — localStorage and sessionStorage, per
     browser, per person. None of it is ever written into the document, so
     invariant #4 (nothing may be added to the state object without going
     through migrateRows) is deliberately not in play here, and no key below
     may ever be moved into `state`. Nor into update-status.json or anything
     else the static handler serves (invariant #29). */

  /* "" means same-origin — the server that served this page, which is the
     normal case and the only one before this existed. */
  var SERVER_BASE_KEY = "splitpage-server-base";
  /* sessionStorage by default: closing the tab forgets the code, which is the
     right default for a code someone read out to you once. "Remember on this
     device" moves it to localStorage. */
  var SERVER_TOKEN_KEY = "splitpage-server-token";
  /* Minted per launch by start.mjs, arrives in the URL fragment, lives only
     as long as this tab. */
  var LAUNCH_TOKEN_KEY = "splitpage-launch-token";

  var serverBase = "";
  var serverToken = "";
  var launchToken = "";

  var serverMode = { available: false, readOnly: false, checked: false,
                     authRequired: false, version: null };
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

  /* ---- where the API is, and what we send with it ---- */

  /* Always ends in a single slash so apiUrl() can just concatenate, and
     always carries a scheme so a typed "192.168.1.20:8791" is not resolved
     as a relative path. */
  function normalizeServerBase(input) {
    var url = String(input || "").trim();
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) url = "http://" + url;
    return url.replace(/\/+$/, "") + "/";
  }

  function loadServerBase() {
    try { serverBase = localStorage.getItem(SERVER_BASE_KEY) || ""; }
    catch (e) { serverBase = ""; }   /* private browsing: same-origin only */
  }

  function setServerBase(input) {
    serverBase = normalizeServerBase(input);
    try {
      if (serverBase) localStorage.setItem(SERVER_BASE_KEY, serverBase);
      else localStorage.removeItem(SERVER_BASE_KEY);
    } catch (e) { /* it just won't survive a reload */ }
  }

  function apiUrl(path) {
    var rel = String(path || "").replace(/^\/+/, "");
    return serverBase ? serverBase + rel : rel;
  }

  function loadServerToken() {
    serverToken = "";
    try { serverToken = sessionStorage.getItem(SERVER_TOKEN_KEY) || ""; } catch (e) {}
    if (!serverToken) {
      try { serverToken = localStorage.getItem(SERVER_TOKEN_KEY) || ""; } catch (e) {}
    }
  }

  function setServerToken(token, remember) {
    serverToken = String(token || "");
    try {
      sessionStorage.setItem(SERVER_TOKEN_KEY, serverToken);
      if (remember) localStorage.setItem(SERVER_TOKEN_KEY, serverToken);
      else localStorage.removeItem(SERVER_TOKEN_KEY);
    } catch (e) { /* the token still works for this page's lifetime */ }
  }

  function clearServerToken() {
    serverToken = "";
    try { sessionStorage.removeItem(SERVER_TOKEN_KEY); } catch (e) {}
    try { localStorage.removeItem(SERVER_TOKEN_KEY); } catch (e) {}
  }

  loadServerBase();
  loadServerToken();

  async function apiFetch(path, opts) {
    opts = opts || {};
    var headers = opts.body
      ? { "Content-Type": "application/json", "Accept": "application/json" }
      : { "Accept": "application/json" };
    if (serverToken) headers["x-splitpage-token"] = serverToken;
    var res;
    try {
      res = await fetch(apiUrl(path), {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        /* Same-origin keeps the Cloudflare Access cookie flowing, which is
           the whole point of serving app and API together. Cross-origin it
           is switched off deliberately: the token in the header is what
           proves us there, and the server never answers with
           Allow-Credentials, so asking for cookies would only turn a working
           request into a CORS failure. */
        credentials: serverBase ? "omit" : "same-origin",
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
      /* A missing or stale join PIN is nothing like a lapsed Access session:
         it is answered right here by asking for the code, with no reload and
         no stash. Kept as its own code so handleApiError() cannot confuse
         the two. */
      if (body403 && (body403.error === "pin-required" || body403.error === "bad-pin")) {
        throw ApiError("pin", "this server asks for a join PIN");
      }
      throw ApiError("auth", "signed out");
    }
    if (res.status === 429) {
      var body429 = await res.json().catch(function () { return null; });
      if (body429 && body429.error === "too-many-attempts") {
        throw ApiError("pin-blocked", "too many wrong codes — wait a minute and try again");
      }
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

  /* The same "reopen it and merge my edits back in" job, asked for by a crash
     draft instead of by a lapsed sign-in (20g-drafts.js arms it before
     detectServer() runs at boot). It is a var rather than a second
     sessionStorage key on purpose: the draft was read from disk, it may be far
     bigger than sessionStorage would take, and stashLocalWork()'s quota
     fallback strips images — which a recovered draft must not lose.

     {id, rev, base, mine, at, onDone(outcome)}. onDone is how the restore
     learns which way this went ('server-resumed' or 'not-found'); polling
     serverDoc.id cannot tell a resume that merged the draft from one that
     simply reopened the document. */
  var draftServerResume = null;

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
    /* A crash draft of a server document asks for the same thing and is
       answered first: it was read from disk moments ago, so it is the more
       recent of the two, and a page that has both (a sign-in lapsed, then the
       app died) would otherwise merge the older sessionStorage stash and drop
       the draft on the floor. */
    var override = draftServerResume;
    var pending;
    if (override) {
      pending = { id: override.id, rev: override.rev || 0 };
    } else {
      try {
        var raw = sessionStorage.getItem(SERVER_RESUME_KEY);
        pending = raw ? JSON.parse(raw) : null;
      } catch (e) { pending = null; }
    }
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
      /* A recovered draft is different: the document it belongs to is GONE
         from the server (deleted while the app was down), so waiting for a
         later launch would hide the work forever. Disarm and hand the restore
         back its answer — it opens the edits as an unsaved local copy. Any
         other failure (signed out, no answer yet, a PIN still to type) leaves
         the override armed: finishServerDetect() calls this again once the
         PIN dialog succeeds. The literal "404" is here because apiFetch()
         names non-ok statuses by their number; "not-found" is what
         saveToServer's own branch looks for. */
      if (override && err && (err.code === "not-found" || err.code === "404")) {
        draftServerResume = null;
        try { override.onDone("not-found"); } catch (e2) {}
      }
      return false;
    }
    if (override) {
      draftServerResume = null;
      /* Only when the lapsed-sign-in stash is about this SAME document does
         it belong to the merge below — the draft already carries everything
         that stash held, and a stash left over from a different document must
         survive for its own resume. */
      var samePending = null;
      try {
        var rawPending = sessionStorage.getItem(SERVER_RESUME_KEY);
        samePending = rawPending ? JSON.parse(rawPending) : null;
      } catch (e) { samePending = null; }
      if (samePending && samePending.id === pending.id) {
        try { sessionStorage.removeItem(SERVER_RESUME_KEY); } catch (e) {}
        clearStash();
      }
    } else {
      try { sessionStorage.removeItem(SERVER_RESUME_KEY); } catch (e) {}
    }

    var stash = override || readStash();
    /* A server document saved by a client older than document ids has none.
       The stash was taken from this same document before the sign-in lapsed,
       so the id this view was already using is the right one to keep;
       failing that, one derived from the server's own document id, the same
       for everyone who opens it. */
    /* `stash` is the override when there is one, so this is also the draft's
       own id — the document the draft was taken from keeps its identity and
       its history rather than deriving a second one from the server id. */
    var theirs = migrateDocument(cloneState(body.state), {
      kind: "server",
      serverId: body.id,
      fallbackId: normalizeDocId(stash && stash.mine && stash.mine.docId) || null
    });
    serverDoc = { id: body.id, rev: body.rev || 0 };
    docIdWrittenOut = true;
    docFileHandle = { handle: null, kind: null };
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
        if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
        return true;
      }
      state = theirs;
      baseState = cloneState(state);
      clearDirty();
      render();
      updateIdentityChip();
      updateFileChip();
      showToast("Signed back in — reopened " + (state.title || body.id), "ok");
      /* Only reachable with an override if the draft held nothing usable; the
         document did reopen, so the restore is finished either way and must
         not be left waiting for an answer that is never coming. */
      if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
      return true;
    }

    if (!override) clearStash();
    var mine = migrateRows(cloneState(stash.mine));
    if (typedDuringResume) {
      /* fold the keystrokes typed on top of the blank interim document into
         what the stash already remembers as "mine", so both survive the
         three-way merge below rather than one silently replacing the other. */
      mine = mergeStates(stateAtStart, migrateRows(cloneState(state)), mine, false).merged;
    }
    /* The recovered version of this document, filed before it is merged into
       whatever the server holds now. The lapsed-sign-in path does not need
       one (the reload it came from is seconds old and the stash is still in
       sessionStorage); a draft can be days old and is deleted from disk by
       the first clean save after this, so without this snapshot the recovered
       edits would exist nowhere but in the merge result. Captured
       synchronously, like every other pushSnapshot caller (invariant #39). */
    if (override) pushSnapshot("Before merging your recovered changes", theirs);
    var result = mergeStates(
      stash.base ? migrateRows(cloneState(stash.base)) : null,
      mine,
      theirs,
      !!stash.imagesStripped
    );
    state = result.merged;
    /* if theirs won the id, the history written under mine follows it */
    noteMergedDocId(mine.docId);
    baseState = cloneState(theirs);
    render();
    updateIdentityChip();
    updateFileChip();
    showToast(override
      ? "Reopened " + (state.title || body.id) + " — the changes recovered from the last session were merged back in"
      : "Signed back in — your unsaved edits were merged back in", "ok");
    reportMerge(result);   /* leaves it dirty and queues the save, which is right */
    if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
    return true;
  }

  function handleApiError(err, whatFailed) {
    if (err && err.code === "auth") { flagServerSessionExpired(); return; }
    /* Never latches serverSessionExpired: the code is one dialog away, the
       page does not have to reload to ask for it, and nothing needs stashing
       because nothing was signed out. */
    if (err && err.code === "pin") {
      clearServerToken();
      openPinDialog({ reason: "This server asks for a join PIN." });
      return;
    }
    if (err && err.code === "pin-blocked") {
      showToast("Too many wrong codes were tried — wait a minute, then try again.", "warn");
      return;
    }
    if (err && err.code === "read-only") {
      showToast("This server is published read-only — save a copy to your own disk instead.", "warn");
      return;
    }
    showToast(whatFailed + " — " + ((err && err.message) || "please try again") + ".", "error");
  }

  async function detectServer() {
    /* A saved base is tried first and is the reason a file:// page can have
       a server at all: the old skip was "no http, no server", and that is
       only still true when nobody has pointed this copy anywhere. */
    if (!serverBase && location.protocol === "file:") { serverMode.checked = true; return; }
    try {
      var health = await apiFetch("api/health");
      serverMode.available = !!(health && health.ok);
      serverMode.readOnly = !!(health && health.readOnly);
      serverMode.authRequired = !!(health && health.authRequired);
      serverMode.version = (health && health.version) || null;
    } catch (e) {
      serverMode.available = false;
    }
    serverMode.checked = true;
    updateConnectMenu();
    if (!serverMode.available) {
      if (serverBase) {
        showToast("Could not reach " + serverBase + " — use File ▸ Servers… to pick another, " +
          "or go back to this copy.", "warn");
      }
      return;
    }

    /* The server wants a code and this browser has not been given one (or
       the one it has is stale): ask before listing anything. Every route
       past here would answer 401 anyway, and a picker full of "could not
       reach the server" is a worse way to say "type the PIN". */
    if (serverMode.authRequired && !serverToken) {
      updateServerMenu();
      openPinDialog({ reason: "This server asks for a join PIN before it will show you anything." });
      return;
    }

    finishServerDetect();
  }

  /* Everything that only makes sense once we are actually allowed in. Split
     out of detectServer() so the PIN dialog can call it on success without
     re-probing health. */
  async function finishServerDetect() {
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

    /* no fallback id: nothing this page holds is known to be this document,
       so an id-less server document derives one from its server id */
    state = migrateDocument(body.state, { kind: "server", serverId: body.id, fallbackId: null });
    baseState = cloneState(state);
    serverDoc = { id: body.id, rev: body.rev || 0 };
    docIdWrittenOut = true;
    /* a hosted document and a local file are different homes for the same
       Save button — holding both would make it ambiguous which one it writes */
    docFileHandle = { handle: null, kind: null };
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
    /* Publishing makes a second home for this script. If its id already
       lives somewhere else (a file on disk, another server document), the
       server copy gets a new one — otherwise two documents that will now be
       edited apart share one version history. Same rule as Save As. */
    var oldId = state.docId;
    var forkDocId = docIdWrittenOut ? mintDocId() : null;
    if (forkDocId) published.docId = forkDocId;
    var body;
    try {
      body = await apiFetch("api/docs", { method: "POST", body: { state: published, by: getEditorName() } });
    } catch (err) { handleApiError(err, "Could not put that on the server"); return; }
    serverDoc = { id: body.id, rev: body.rev || 1 };
    baseState = published;
    docFileHandle = { handle: null, kind: null };
    /* Adopted only after the server has it, like Save As. The id check keeps
       a document opened while the POST was in flight from being re-id'd. */
    if (forkDocId && state.docId === oldId) {
      state.docId = forkDocId;
      copyDocHistorySafe(oldId, forkDocId);
    }
    docIdWrittenOut = true;
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
          /* The id this view has been writing history under, before the merge
             below can hand the document theirs. */
          var prevDocId = state.docId;
          /* Their copy came from the same server document, so if a client
             older than document ids saved it without one, it is still this
             document: keep our id rather than deriving a new one and splitting
             the history on every conflict. */
          var theirs = migrateDocument(cloneState(err.payload.state), {
            kind: "server",
            serverId: docId,
            fallbackId: state.docId
          });
          pushSnapshot("Before merging in someone else's changes", cloneState(state));
          mergeResult = mergeStates(
            baseState ? migrateRows(cloneState(baseState)) : null,
            migrateRows(cloneState(state)),
            theirs
          );
          state = mergeResult.merged;
          /* if theirs won the id, the history written under ours follows it */
          noteMergedDocId(prevDocId);
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

  /* ---- the launcher's key ----

     start.mjs mints one per launch and hands it over in the URL fragment,
     which the browser never sends to a server and no proxy logs. Read it
     once, keep it for this tab only, and take it out of the address bar so
     it is not in a screenshot, a bookmark or a shared link.

     It buys exactly one thing: the loopback-only /api/launcher/* routes,
     which let the first-run wizard register this copy with Windows. Phase 4
     calls launcherFetch(); this file's job is only to hold the key. */

  function readLaunchToken() {
    try { launchToken = sessionStorage.getItem(LAUNCH_TOKEN_KEY) || ""; } catch (e) { launchToken = ""; }
    var hash = location.hash || "";
    var m = /(?:^#|&)launch=([A-Za-z0-9]+)/.exec(hash);
    if (!m) return;
    launchToken = m[1];
    try { sessionStorage.setItem(LAUNCH_TOKEN_KEY, launchToken); } catch (e) {}
    /* Strip it, keeping any other fragment the URL carried. replaceState
       leaves no history entry holding the old URL either. */
    var rest = hash.replace(/(^#|&)launch=[A-Za-z0-9]+/, "$1").replace(/^#&/, "#");
    if (rest === "#") rest = "";
    try {
      history.replaceState(null, "", location.pathname + location.search + rest);
    } catch (e) { /* file:// in some browsers — the token is already stored */ }
  }

  readLaunchToken();

  function hasLauncher() { return !!launchToken; }

  /* Deliberately not apiFetch(): these routes are never on another origin
     (the server refuses them off loopback), they carry a different header,
     and a 404 from them means "not available here", not "signed out". */
  async function launcherFetch(path, opts) {
    opts = opts || {};
    if (!launchToken) throw ApiError("no-launcher", "this copy was not started by the launcher");
    var headers = { "Accept": "application/json", "x-splitpage-launch": launchToken };
    if (opts.body) headers["Content-Type"] = "application/json";
    var res;
    try {
      res = await fetch(String(path || "").replace(/^\/+/, ""), {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: "same-origin",
        cache: "no-store"
      });
    } catch (e) {
      throw ApiError("offline", "no answer from the launcher");
    }
    var body = await res.json().catch(function () { return null; });
    if (res.status === 404) throw ApiError("no-launcher", "not available in this copy");
    if (!res.ok) throw ApiError(String(res.status), (body && body.error) || ("HTTP " + res.status));
    return body;
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
    /* Google Identity Services only ever authorizes an http/https origin
       (Google Cloud Console has no "custom scheme" option for Authorized
       JavaScript origins), and this page runs at splitpage://app — the menu
       entry that reaches here is hidden on desktop for exactly that reason
       (20f-desktop.js's initDesktop()). This is the defensive half, in case
       something still calls the action directly (a native menu command, a
       stale keyboard shortcut) — say why plainly instead of opening a modal
       whose Sign in button can only ever fail. */
    if (DESKTOP) {
      showToast("Google Drive isn't available in the desktop app — sign-in needs a web address Google " +
        "can redirect back to. Use File ▸ Open a document… instead.", "warn");
      return;
    }
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
