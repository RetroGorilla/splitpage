  /* ================= connecting to a server =================

     The UI half of what 13-hosted.js made possible: the code a shared session
     asks for, the list of servers this browser knows about, and the SSH
     command for reaching one that is not on your network.

     EVERYTHING HERE IS BROWSER STATE. Bookmarks are localStorage, the join
     token is sessionStorage (localStorage only if asked), and the launch
     token is sessionStorage. None of it is ever written into the document,
     so invariant #4 is deliberately not in play — and none of it may ever
     move into `state`, update-status.json, or any file the server hands out
     (invariant #29).

     WHAT IS NEVER STORED: a password, an SSH key, a passphrase. The SSH panel
     writes out a command for you to run; ssh's own keys and agent do that
     job, and Splitpage is not a credential manager. */

  /* [{ id, name, url, ssh?: { userHost, remotePort, localPort } }] */
  var SERVER_BOOKMARKS_KEY = "splitpage-server-bookmarks";

  var serverBookmarks = [];
  /* what the PIN dialog is for right now: which base, and what to do after */
  var pinRequest = null;
  /* the bookmark whose ssh command is on screen */
  var sshShownFor = null;

  function loadBookmarks() {
    serverBookmarks = [];
    var raw = null;
    try { raw = localStorage.getItem(SERVER_BOOKMARKS_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      serverBookmarks = parsed.filter(function (b) {
        return b && typeof b === "object" && typeof b.url === "string";
      });
    } catch (e) { /* corrupt: start empty rather than throw on boot */ }
  }

  function saveBookmarks() {
    try { localStorage.setItem(SERVER_BOOKMARKS_KEY, JSON.stringify(serverBookmarks)); }
    catch (e) { showToast("This browser would not save the server list.", "warn"); }
  }

  function newBookmarkId() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function bookmarkById(id) {
    for (var i = 0; i < serverBookmarks.length; i++) {
      if (serverBookmarks[i].id === id) return serverBookmarks[i];
    }
    return null;
  }

  loadBookmarks();

  /* The File menu entry says where you are, so "am I looking at my own copy
     or someone else's server?" is answerable without opening anything. */
  function updateConnectMenu() {
    var item = document.getElementById("menu-servers");
    if (!item) return;
    if (!serverBase) { item.textContent = "Servers…"; return; }
    var known = serverBookmarks.filter(function (b) { return b.url === serverBase; })[0];
    item.textContent = "Servers… (" + (known ? known.name : shortHost(serverBase)) + ")";
  }

  function shortHost(url) {
    try { return new URL(url).host; } catch (e) { return url; }
  }

  /* ---- the PIN dialog ----

     Opened by handleApiError() when a server answers "pin-required", by
     detectServer() when health says a code is needed before anything is
     listed, and by the Servers dialog when you use a bookmark. */

  function openPinDialog(opts) {
    opts = opts || {};
    var modal = document.getElementById("pin-modal");
    if (!modal) return;
    pinRequest = {
      base: opts.base === undefined ? serverBase : opts.base,
      onDone: opts.onDone || null
    };
    document.getElementById("pin-reason").textContent =
      opts.reason || "This server asks for a join PIN.";
    var input = document.getElementById("pin-input");
    input.value = "";
    setPinError("");
    modal.hidden = false;
    /* Owns focus while it is up (invariant #19): there is exactly one thing
       to do here and it is type the code. */
    input.focus();
  }

  function closePinDialog() {
    var modal = document.getElementById("pin-modal");
    if (modal) modal.hidden = true;
    pinRequest = null;
  }

  function setPinError(message) {
    var el = document.getElementById("pin-error");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  /* Its own fetch rather than apiFetch(): this is the one call that has to
     tell a wrong code from a missing one from too many tries, and apiFetch
     deliberately flattens all of that into "pin". */
  async function joinServer(base, pin) {
    var url = (base ? String(base).replace(/\/+$/, "") + "/" : "") + "api/join";
    var res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ pin: String(pin || "") }),
        credentials: base ? "omit" : "same-origin",
        cache: "no-store"
      });
    } catch (e) {
      return { ok: false, error: "offline" };
    }
    var body = null;
    try { body = await res.json(); } catch (e) { /* not JSON at all */ }
    if (res.ok && body && body.token) return { ok: true, token: body.token };
    if (res.status === 429) return { ok: false, error: "too-many-attempts" };
    if (res.status === 404 || !body) return { ok: false, error: "not-splitpage" };
    return { ok: false, error: (body && body.error) || ("HTTP " + res.status) };
  }

  function joinErrorText(code) {
    if (code === "bad-pin") return "That code was not right. Ask whoever is hosting for it again.";
    if (code === "too-many-attempts") return "Too many wrong codes. Wait a minute, then try again.";
    if (code === "offline") return "No answer from that address. Check it, and that the session is still running.";
    if (code === "not-splitpage") return "Something answered, but it was not a Splitpage server.";
    return "Could not join: " + code + ".";
  }

  /* Every call here can wait on a machine that may simply not answer. One
     helper so no button is ever left looking clickable while it is busy. */
  async function withBusy(button, label, work) {
    var was = button ? button.textContent : "";
    if (button) { button.disabled = true; button.textContent = label; }
    try {
      return await work();
    } finally {
      if (button && button.isConnected) { button.disabled = false; button.textContent = was; }
    }
  }

  async function submitPin() {
    if (!pinRequest) return;
    var input = document.getElementById("pin-input");
    var pin = (input.value || "").trim();
    if (!pin) { setPinError("Type the code first."); input.focus(); return; }
    var remember = !!document.getElementById("pin-remember").checked;
    setPinError("");
    /* A machine that is off does not refuse a connection, it says nothing,
       and the browser waits out its own timeout — which can be half a minute.
       Say what is happening and refuse a second click while it happens. */
    var result = await withBusy(document.querySelector('#pin-modal [data-connect-action="pin-submit"]'),
      "Checking…", function () { return joinServer(pinRequest.base, pin); });
    if (!result.ok) {
      setPinError(joinErrorText(result.error));
      input.select();
      return;
    }
    if (!pinRequest) return;   /* cancelled while we were waiting */
    var done = pinRequest.onDone;
    var base = pinRequest.base;
    setServerToken(result.token, remember);
    closePinDialog();
    showToast("Joined" + (base ? " " + shortHost(base) : "") + ".", "ok");
    if (done) { done(); return; }
    /* No caller waiting: this was a code asked for mid-flight, so pick the
       detection back up where it stopped. */
    if (serverMode.available) finishServerDetect();
    else detectServer();
  }

  /* ---- the Servers dialog ---- */

  function openServersDialog() {
    var modal = document.getElementById("connect-modal");
    if (!modal) return;
    loadBookmarks();
    sshShownFor = null;
    document.getElementById("connect-ssh-out").hidden = true;
    setConnectError("");
    modal.hidden = false;
    renderConnect();
  }

  function closeServersDialog() {
    var modal = document.getElementById("connect-modal");
    if (modal) modal.hidden = true;
  }

  function setConnectError(message) {
    var el = document.getElementById("connect-error");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  function renderConnect() {
    var current = document.getElementById("connect-current");
    if (!serverBase) {
      current.innerHTML = "You are using <strong>this copy of Splitpage</strong>" +
        (serverMode.available
          ? " and the server that opened it."
          : " on its own — documents are files you save to disk.");
    } else {
      var known = serverBookmarks.filter(function (b) { return b.url === serverBase; })[0];
      current.innerHTML = "Using <strong>" + escapeHtml(known ? known.name : shortHost(serverBase)) +
        "</strong> — " + escapeHtml(serverBase) +
        (serverMode.available ? "" : " <em>(not answering)</em>");
    }

    var list = document.getElementById("connect-list");
    if (!serverBookmarks.length) {
      list.innerHTML = '<div class="connect-empty">No servers saved yet.</div>';
      return;
    }
    list.innerHTML = serverBookmarks.map(function (b) {
      var isCurrent = b.url === serverBase;
      return '<div class="connect-row' + (isCurrent ? ' is-current' : '') +
          '" data-id="' + escapeHtml(b.id) + '">' +
        '<span class="connect-row-main">' +
          '<span class="connect-row-name">' + escapeHtml(b.name || shortHost(b.url)) + '</span>' +
          '<span class="connect-row-url">' + escapeHtml(b.url) + '</span>' +
        '</span>' +
        '<span class="connect-row-actions">' +
          (b.ssh ? '<button type="button" class="btn" data-connect-action="ssh-show" data-id="' +
            escapeHtml(b.id) + '">SSH</button>' : '') +
          /* A code can change, or be typed wrong, or be forgotten when the
             tab closed — this asks for it again without re-adding anything. */
          '<button type="button" class="btn" data-connect-action="pin" data-id="' +
            escapeHtml(b.id) + '" title="Enter this server\'s join PIN">PIN</button>' +
          (isCurrent ? '' : '<button type="button" class="btn btn-accent" data-connect-action="use" data-id="' +
            escapeHtml(b.id) + '">Use this server</button>') +
          '<button type="button" class="btn" data-connect-action="remove" data-id="' +
            escapeHtml(b.id) + '" title="Forget this server">×</button>' +
        '</span>' +
      '</div>';
    }).join("");
  }

  function connectPortOr(value, fallback) {
    var n = parseInt(String(value || "").trim(), 10);
    return (n >= 1 && n <= 65535) ? n : fallback;
  }

  async function addBookmarkFromForm() {
    var name = document.getElementById("connect-name").value.trim();
    var url = normalizeServerBase(document.getElementById("connect-url").value);
    var pin = document.getElementById("connect-pin").value.trim();
    var remember = !!document.getElementById("connect-remember").checked;
    var useSsh = !!document.getElementById("connect-ssh-toggle").checked;

    if (!url) { setConnectError("An address is needed — something like http://192.168.1.20:8791/"); return; }
    var ssh = null;
    if (useSsh) {
      var userHost = document.getElementById("connect-ssh-userhost").value.trim();
      if (!userHost) { setConnectError("An SSH login is needed, like me@studio.example.com."); return; }
      ssh = {
        userHost: userHost,
        remotePort: connectPortOr(document.getElementById("connect-ssh-remote").value, 8791),
        localPort: connectPortOr(document.getElementById("connect-ssh-local").value, 8791)
      };
    }
    setConnectError("");

    /* A PIN typed here is checked against the address before the bookmark is
       saved, so a typo in either is caught now rather than the first time
       somebody tries to open a document. */
    var joined = null;
    if (pin) {
      joined = await withBusy(document.querySelector('#connect-modal [data-connect-action="add"]'),
        "Checking…", function () { return joinServer(url, pin); });
      if (!joined.ok) { setConnectError(joinErrorText(joined.error)); return; }
    }

    var bookmark = { id: newBookmarkId(), name: name || shortHost(url), url: url };
    if (ssh) bookmark.ssh = ssh;   /* host and ports only — never a credential */
    serverBookmarks.push(bookmark);
    saveBookmarks();

    document.getElementById("connect-name").value = "";
    document.getElementById("connect-url").value = "";
    document.getElementById("connect-pin").value = "";

    if (joined && joined.ok) {
      /* They proved they can get in; putting them there is what they meant. */
      setServerToken(joined.token, remember);
      await useServer(bookmark);
      return;
    }
    renderConnect();
    updateConnectMenu();
    showToast("Saved " + bookmark.name + ".", "ok");
  }

  /* The one exception to "the setup wizard may only edit 20b-onboarding.js":
     its Join-a-server step needs exactly this bookmark-saving path — join
     first if a PIN was given, then save — and duplicating it there would be
     a second copy of addBookmarkFromForm() that could drift from this one.
     Same behaviour, plain arguments instead of the Servers dialog's own
     inputs; nothing here reads or writes DOM. `opts`: { pin, remember }. */
  async function addServerBookmark(name, url, opts) {
    opts = opts || {};
    var base = normalizeServerBase(url);
    if (!base) return { ok: false, error: "no-url" };
    var joined = null;
    if (opts.pin) {
      joined = await joinServer(base, opts.pin);
      if (!joined.ok) return joined;
    }
    var bookmark = { id: newBookmarkId(), name: (name || "").trim() || shortHost(base), url: base };
    serverBookmarks.push(bookmark);
    saveBookmarks();
    updateConnectMenu();
    if (joined && joined.ok) {
      setServerToken(joined.token, !!opts.remember);
      await useServer(bookmark);
    }
    return { ok: true, bookmark: bookmark, joined: !!(joined && joined.ok) };
  }

  /* One token at a time, for whichever server is current: pointing the app
     somewhere else always means proving yourself there again. */
  async function useServer(bookmark) {
    setServerBase(bookmark.url);
    serverDoc = { id: null, rev: 0 };
    serverMode = { available: false, readOnly: false, checked: false, authRequired: false, version: null };
    updateConnectMenu();
    renderConnect();
    await detectServer();
    updateFileChip();
    renderConnect();
    if (serverMode.available && !(serverMode.authRequired && !serverToken)) {
      showToast("Now using " + (bookmark.name || shortHost(bookmark.url)) +
        " — open a document from the File menu.", "ok");
    }
  }

  async function useBookmark(id) {
    var b = bookmarkById(id);
    if (!b) return;
    clearServerToken();
    await useServer(b);
  }

  /* The PIN dialog, opened deliberately rather than in response to a refusal:
     the code for a server you have not switched to yet, or one whose code has
     changed since. Joining is also switching — a token only ever belongs to
     the server that is current. */
  function askPinFor(id) {
    var b = bookmarkById(id);
    if (!b) return;
    openPinDialog({
      base: b.url,
      reason: "Enter the join PIN for " + (b.name || shortHost(b.url)) + ".",
      onDone: function () { useServer(b); }
    });
  }

  function removeBookmark(id) {
    var b = bookmarkById(id);
    if (!b) return;
    serverBookmarks = serverBookmarks.filter(function (x) { return x.id !== id; });
    saveBookmarks();
    if (sshShownFor === id) {
      sshShownFor = null;
      document.getElementById("connect-ssh-out").hidden = true;
    }
    renderConnect();
    updateConnectMenu();
    showToast("Forgot " + (b.name || shortHost(b.url)) + ".", "ok");
  }

  async function backToThisCopy() {
    setServerBase("");
    clearServerToken();
    serverDoc = { id: null, rev: 0 };
    serverMode = { available: false, readOnly: false, checked: false, authRequired: false, version: null };
    updateConnectMenu();
    await detectServer();
    updateFileChip();
    renderConnect();
    showToast("Back to this copy of Splitpage.", "ok");
  }

  /* ---- the SSH helper ----

     Splitpage never spawns ssh from the page — a web page that could start
     processes would be a far bigger hole than anything it opened. It writes
     the command out; you run it. */

  function sshCommandFor(bookmark) {
    var s = bookmark.ssh;
    return "ssh -N -L " + s.localPort + ":localhost:" + s.remotePort + " " + s.userHost;
  }

  function showSshFor(id) {
    var b = bookmarkById(id);
    if (!b || !b.ssh) return;
    sshShownFor = id;
    document.getElementById("connect-ssh-cmd").textContent = sshCommandFor(b);
    document.getElementById("connect-ssh-note").textContent =
      "Leave it running, then open " + b.url;
    document.getElementById("connect-ssh-out").hidden = false;
  }

  async function copySshCommand() {
    if (!sshShownFor) return;
    var b = bookmarkById(sshShownFor);
    if (!b) return;
    var text = sshCommandFor(b);
    try {
      await navigator.clipboard.writeText(text);
      showToast("Command copied.", "ok");
      return;
    } catch (e) { /* no permission, or an insecure origin — fall back */ }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast("Command copied.", "ok");
    } catch (err) {
      showToast("Could not copy — select the command and copy it by hand.", "warn");
    }
  }

  /* A .cmd rather than a .bat only because that is what Windows has called
     these since NT; both run the same. CRLF, because Notepad and cmd both
     expect it. */
  function saveSshCmd() {
    if (!sshShownFor) return;
    var b = bookmarkById(sshShownFor);
    if (!b) return;
    var safe = (b.name || "server").replace(/[^a-zA-Z0-9 _-]+/g, "").trim() || "server";
    var lines = [
      "@echo off",
      "title Splitpage tunnel - " + safe,
      "echo Opening an SSH tunnel to " + b.ssh.userHost,
      "echo Then open " + b.url + " in your browser.",
      "echo Close this window to close the tunnel.",
      "echo.",
      sshCommandFor(b),
      "pause"
    ];
    deliverFile("splitpage-tunnel-" + safe.replace(/\s+/g, "-").toLowerCase() + ".cmd",
      lines.join("\r\n") + "\r\n",
      { savedMsg: "Saved the tunnel command." });
  }

  /* ---- wiring ----

     The File menu's own dispatch lives in 18-local-files.js and knows nothing
     about these dialogs. Rather than reach into it, this listens on the same
     element in the CAPTURE phase, which runs before that file's bubbling
     handler, and stops the event when the action is one of ours. The result
     is that everything about connecting to a server lives in this one file
     and nothing else had to be edited to make the menu entry work. */

  (function wireConnectUi() {
    var menu = document.getElementById("file-menu");
    if (menu) {
      menu.addEventListener("click", function (e) {
        var item = e.target.closest("[data-file-action]");
        if (!item || item.disabled) return;
        if (item.getAttribute("data-file-action") !== "servers") return;
        e.stopPropagation();
        toggleFileMenu(false);
        openServersDialog();
      }, true);
    }

    var pinModal = document.getElementById("pin-modal");
    if (pinModal) {
      pinModal.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-connect-action]");
        if (btn) {
          var action = btn.getAttribute("data-connect-action");
          if (action === "pin-cancel") closePinDialog();
          else if (action === "pin-submit") submitPin();
          return;
        }
        /* click outside the card closes it, like every other modal here */
        if (e.target === pinModal) closePinDialog();
      });
      pinModal.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submitPin(); }
      });
    }

    var connectModal = document.getElementById("connect-modal");
    if (connectModal) {
      connectModal.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-connect-action]");
        if (!btn) {
          if (e.target === connectModal) closeServersDialog();
          return;
        }
        var action = btn.getAttribute("data-connect-action");
        var id = btn.getAttribute("data-id");
        if (action === "close") closeServersDialog();
        else if (action === "add") addBookmarkFromForm();
        else if (action === "use") useBookmark(id);
        else if (action === "remove") removeBookmark(id);
        else if (action === "pin") askPinFor(id);
        else if (action === "ssh-show") showSshFor(id);
        else if (action === "ssh-copy") copySshCommand();
        else if (action === "ssh-save") saveSshCmd();
        else if (action === "back") backToThisCopy();
      });
      var sshToggle = document.getElementById("connect-ssh-toggle");
      if (sshToggle) {
        sshToggle.addEventListener("change", function () {
          document.getElementById("connect-ssh-fields").hidden = !sshToggle.checked;
        });
      }
    }

    /* Esc closes whichever of the two is up, innermost first: the PIN dialog
       can be opened from the Servers dialog and must not take it with it. */
    window.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var pin = document.getElementById("pin-modal");
      if (pin && !pin.hidden) { e.stopPropagation(); closePinDialog(); return; }
      var connect = document.getElementById("connect-modal");
      if (connect && !connect.hidden) { e.stopPropagation(); closeServersDialog(); }
    }, true);
  })();

  updateConnectMenu();
