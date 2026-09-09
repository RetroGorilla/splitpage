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
    try { sessionStorage.removeItem(SERVER_RESUME_KEY); } catch (e) {}

    var body;
    try {
      body = await apiFetch("api/docs/" + encodeURIComponent(pending.id));
    } catch (err) {
      /* still signed out, or the document is gone — leave the stash alone so
         a later reload can still recover it */
      return false;
    }

    var stash = readStash();
    var theirs = migrateRows(cloneState(body.state));
    serverDoc = { id: body.id, rev: body.rev || 0 };
    htmlFileHandle = null;
    resetProductionPanelState();

    if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) {
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
    var result = mergeStates(
      stash.base ? migrateRows(cloneState(stash.base)) : null,
      migrateRows(cloneState(stash.mine)),
      theirs
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
    var attempts = 0;
    var mergeResult = null;

    while (attempts < 3) {
      attempts++;
      state.rev = (state.rev || 0) + 1;
      state.lastEditedBy = getEditorName();
      state.lastEditedAt = nowIso();
      var published = cloneState(state);
      var seqAtSave = editSeq;

      try {
        var body = await apiFetch("api/docs/" + encodeURIComponent(serverDoc.id), {
          method: "PUT",
          body: { baseRev: serverDoc.rev, state: published, by: getEditorName() }
        });
        serverDoc.rev = body.rev;
        baseState = published;
        if (editSeq === seqAtSave) clearDirty();
        updateFileChip();
        /* reported only once the merged result is actually stored, so the
           banner can never describe a merge that failed to save */
        if (mergeResult) reportMerge(mergeResult, { alreadySaved: true });
        return true;
      } catch (err) {
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

