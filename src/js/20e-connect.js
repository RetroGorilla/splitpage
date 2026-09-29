import { S } from "./_state.js";
import { conn, home, setHome } from "./_home.js";
import { escapeHtml } from "./02-state.js";
import { render } from "./05-render.js";
import { showToast } from "./12-dirty-toast.js";
import {
  applyReviewMode,
  detectServer,
  fetchReviewLink,
  finishServerDetect,
  normalizeServerBase,
  pointTabAt,
  setServerToken
} from "./13-hosted.js";
import { openCollaborate } from "./13b-collaborate.js";
import { deliverFile, updateFileChip } from "./18-local-files.js";
import { setMenuItemLabel, toggleFileMenu } from "./18b-file-menu.js";
import { renderDesktopShareInfo } from "./20f-desktop.js";

/* ================= connecting to a server =================

   The UI half of what 13-hosted.js made possible: the code a shared session
   asks for, the list of servers this browser knows about, and the SSH
   command for reaching one that is not on your network.

   IT IS THIS TAB'S CONNECTION (#11). Each tab is its own page with its own
   `conn` (_home.js), so "Use this server" and "Back to this copy" move the
   tab they are clicked in and no other: a second tab on another server, or
   on a local file, stays exactly where it is, heartbeat and all. The one
   thing a pick changes beyond this tab is where the NEXT fresh page starts.

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
export var SERVER_BOOKMARKS_KEY = "splitpage-server-bookmarks";

S.serverBookmarks = [];
/* what the PIN dialog is for right now: which base, and what to do after */
var pinRequest = null;
/* the bookmark whose ssh command is on screen */
var sshShownFor = null;

export function loadBookmarks() {
  S.serverBookmarks = [];
  var raw;
  try { raw = localStorage.getItem(SERVER_BOOKMARKS_KEY); } catch (e) { return; }
  if (!raw) return;
  try {
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    S.serverBookmarks = parsed.filter(function (b) {
      return b && typeof b === "object" && typeof b.url === "string";
    });
  } catch (e) { /* corrupt: start empty rather than throw on boot */ }
}

export function saveBookmarks() {
  try { localStorage.setItem(SERVER_BOOKMARKS_KEY, JSON.stringify(S.serverBookmarks)); }
  catch (e) { showToast("This browser would not save the server list.", "warn"); }
}

export function newBookmarkId() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function bookmarkById(id) {
  for (var i = 0; i < S.serverBookmarks.length; i++) {
    if (S.serverBookmarks[i].id === id) return S.serverBookmarks[i];
  }
  return null;
}

/* The File menu entry says where you are, so "am I looking at my own copy
   or someone else's server?" is answerable without opening anything. */
export function updateConnectMenu() {
  var item = document.getElementById("menu-servers");
  if (!item) return;
  if (!conn.serverUrl) { setMenuItemLabel(item, "Servers…"); return; }
  var known = S.serverBookmarks.filter(function (b) { return b.url === conn.serverUrl; })[0];
  setMenuItemLabel(item, "Servers… (" + (known ? known.name : shortHost(conn.serverUrl)) + ")");
}

export function shortHost(url) {
  try { return new URL(url).host; } catch (e) { return url; }
}

/* ---- the PIN dialog ----

   Opened by handleApiError() when a server answers "pin-required", by
   detectServer() when health says a code is needed before anything is
   listed, and by the Servers dialog when you use a bookmark. */

export function openPinDialog(opts) {
  opts = opts || {};
  var modal = document.getElementById("pin-modal");
  if (!modal) return;
  pinRequest = {
    base: opts.base === undefined ? conn.serverUrl : opts.base,
    onDone: opts.onDone || null
  };
  document.getElementById("pin-reason").textContent =
    opts.reason || "This server asks for its join PIN or key.";
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
/* `key` is the review link's own credential (13-hosted.js's readReviewKey):
   the same door, opened by a link rather than by something typed. The
   server decides which role either one buys — this only carries it. */
export async function joinServer(base, pin, key) {
  var url = (base ? String(base).replace(/\/+$/, "") + "/" : "") + "api/join";
  var res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(key ? { key: String(key) } : { pin: String(pin || "") }),
      credentials: base ? "omit" : "same-origin",
      cache: "no-store"
    });
  } catch (e) {
    return { ok: false, error: "offline" };
  }
  var body = null;
  try { body = await res.json(); } catch (e) { /* not JSON at all */ }
  if (res.ok && body && body.token) {
    var joined = { ok: true, token: body.token, role: body.role || "edit" };
    if (typeof body.docId === "string") joined.docId = body.docId;
    if (typeof body.scope === "string") joined.scope = body.scope;
    return joined;
  }
  if (res.status === 429) return { ok: false, error: "too-many-attempts" };
  if (res.status === 404 || !body) return { ok: false, error: "not-splitpage" };
  return { ok: false, error: (body && body.error) || ("HTTP " + res.status) };
}

export function joinErrorText(code) {
  if (code === "bad-pin") return "That code was not right. Ask whoever is hosting for it again.";
  if (code === "link-off") return "The owner turned off this link. Ask them for a new one.";
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
  closePinDialog();
  /* A code for the server this tab is on is this tab's token now. A code
     for another server (a bookmark's PIN button) is handed to whatever
     asked for it, which points the tab there first — a token is only ever
     set on the connection it was given for. */
  var forThisTab = normalizeServerBase(base) === conn.serverUrl;
  if (forThisTab) setServerToken(result.token, remember);
  /* Which code was typed decides what the session is, and the server has
     just said which — worth saying out loud, so nobody discovers it by
     finding they cannot type. */
  showToast("Joined" + (base ? " " + shortHost(base) : "") +
    (result.role === "review" ? " — viewing and commenting only." : "."), "ok");
  if (done) { done({ token: result.token, remember: remember }); return; }
  if (!forThisTab) return;
  /* No caller waiting: this was a code asked for mid-flight, so pick the
     detection back up where it stopped. */
  if (S.serverMode.available) finishServerDetect();
  else detectServer();
}

/* ---- the Servers dialog ---- */

export function openServersDialog() {
  var modal = document.getElementById("connect-modal");
  if (!modal) return;
  loadBookmarks();
  sshShownFor = null;
  document.getElementById("connect-ssh-out").hidden = true;
  setConnectError("");
  modal.hidden = false;
  renderConnect();
  renderReviewLink();
  /* Desktop's own "who's connected to me" summary — defined in
     20f-desktop.js, a no-op (and the element it would fill stays hidden)
     whenever DESKTOP is null, i.e. the whole web build. */
  if (typeof renderDesktopShareInfo === "function") renderDesktopShareInfo();
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

/* ---- the review link ----

   Offered beside the addresses because that is what it is: another address
   for the script you have open, one that opens it to be read and commented
   on and nothing else. Hidden unless this launch actually has a review
   credential, a document is open on the server to make a link TO (the key
   is minted per document — see fetchReviewLink, #63), and this browser is
   an editor here — a reviewer has nothing to hand on.
   Async and last, so a server that is slow to answer never holds up the
   dialog itself. */
var reviewLinkUrl = "";

async function renderReviewLink() {
  var box = document.getElementById("connect-review");
  if (!box) return;
  if (S.serverMode.available && S.serverMode.links && home.kind === "server" &&
      conn.role !== "review" && !conn.scope) {
    reviewLinkUrl = "";
    box.innerHTML = '<div class="connect-add-title">Invite people to this script</div>' +
      '<div class="modal-row">' +
        '<span class="modal-hint">Collaborate gives you a link to edit it and one to comment — no PIN needed.</span>' +
        '<button type="button" class="btn" data-connect-action="collaborate">Collaborate…</button>' +
      '</div>';
    box.hidden = false;
    return;
  }
  reviewLinkUrl = await fetchReviewLink();
  if (!reviewLinkUrl) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = '<div class="connect-add-title">Share this script to read and comment</div>' +
    '<p class="modal-hint">Whoever opens this can read this one script, present it and export it, ' +
    'and leave comments — the server refuses every other change, and every other document, ' +
    'whatever their copy of Splitpage lets them click.</p>' +
    '<div class="connect-share-url">' + escapeHtml(reviewLinkUrl) + '</div>' +
    '<div class="modal-row">' +
      '<span class="modal-hint">Restarting the session invalidates it, like the PIN.</span>' +
      '<button type="button" class="btn" data-connect-action="review-copy">Copy review link</button>' +
    '</div>';
  box.hidden = false;
}

export function renderConnect() {
  var current = document.getElementById("connect-current");
  var base = conn.serverUrl;
  /* "This tab": since #11 that is exactly the scope of everything this
     dialog changes, and a reader with two tabs on two servers is owed the
     word that says so. */
  if (!base) {
    current.innerHTML = "This tab is using <strong>this copy of Splitpage</strong>" +
      (S.serverMode.available
        ? " and the server that opened it."
        : " on its own — documents are files you save to disk.");
  } else {
    var known = S.serverBookmarks.filter(function (b) { return b.url === base; })[0];
    current.innerHTML = "This tab is using <strong>" + escapeHtml(known ? known.name : shortHost(base)) +
      "</strong> — " + escapeHtml(base) +
      (conn.tunnel ? " through an SSH tunnel to " + escapeHtml(conn.tunnel.userHost) : "") +
      (S.serverMode.available ? "" : " <em>(not answering)</em>");
  }
  current.setAttribute("data-server-url", base);

  var list = document.getElementById("connect-list");
  if (!S.serverBookmarks.length) {
    list.innerHTML = '<div class="connect-empty">No servers saved yet.</div>';
    return;
  }
  list.innerHTML = S.serverBookmarks.map(function (b) {
    var isCurrent = b.url === conn.serverUrl;
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
        /* the sprite's close icon, not a "×" glyph (#169) */
        '<button type="button" class="btn connect-forget" data-connect-action="remove" data-id="' +
          escapeHtml(b.id) + '" title="Forget this server" aria-label="Forget this server">' +
          '<svg class="row-icon-svg" aria-hidden="true" focusable="false"><use href="#i-close"/></svg></button>' +
      '</span>' +
    '</div>';
  }).join("");
}

export function connectPortOr(value, fallback) {
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
  S.serverBookmarks.push(bookmark);
  saveBookmarks();

  document.getElementById("connect-name").value = "";
  document.getElementById("connect-url").value = "";
  document.getElementById("connect-pin").value = "";

  if (joined && joined.ok) {
    /* They proved they can get in; putting them there is what they meant. */
    await useServer(bookmark, { token: joined.token, remember: remember });
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
export async function addServerBookmark(name, url, opts) {
  opts = opts || {};
  var base = normalizeServerBase(url);
  if (!base) return { ok: false, error: "no-url" };
  var joined = null;
  if (opts.pin) {
    joined = await joinServer(base, opts.pin);
    if (!joined.ok) return joined;
  }
  var bookmark = { id: newBookmarkId(), name: (name || "").trim() || shortHost(base), url: base };
  S.serverBookmarks.push(bookmark);
  saveBookmarks();
  updateConnectMenu();
  if (joined && joined.ok) {
    await useServer(bookmark, { token: joined.token, remember: !!opts.remember });
  }
  return { ok: true, bookmark: bookmark, joined: !!(joined && joined.ok) };
}

/* The bookmark's SSH forward as the connection's tunnel field, or null.
   A bookmark written by hand (or by an older copy) that does not validate
   is a server without a tunnel note, not a reason to refuse the server. */
function tunnelOf(bookmark) {
  var s = bookmark && bookmark.ssh;
  if (!s || typeof s !== "object") return null;
  return { userHost: String(s.userHost || ""), remotePort: Number(s.remotePort), localPort: Number(s.localPort) };
}

/* Points THIS tab at a server (#11). One token per connection: the tab
   proves itself on the server it is now on, with the code just typed
   (opts.token) or one remembered for that same server; a token from the
   server it left never follows it. Any other tab is untouched — its own
   connection, its own heartbeat — and only the next fresh page starts
   here. opts: {token, remember}. */
async function useServer(bookmark, opts) {
  opts = opts || {};
  /* A document on the old server is not on this one. A local home stays
     exactly where it is. */
  if (home.kind === "server") setHome("none");
  S.serverMode = { available: false, readOnly: false, checked: false, authRequired: false,
                 reviewAvailable: false, version: null };
  try {
    pointTabAt(bookmark.url, { token: opts.token, tunnel: tunnelOf(bookmark), makeDefault: true });
  } catch (e) {
    pointTabAt(bookmark.url, { token: opts.token, makeDefault: true });
  }
  if (opts.token) setServerToken(opts.token, !!opts.remember);
  updateConnectMenu();
  renderConnect();
  await detectServer();
  /* Whatever is on screen is nobody's hosted document now, so it is not a
     review of one either — rebuild it as the ordinary editable document it
     has become. */
  applyReviewMode();
  if (S.state) render();
  updateFileChip();
  renderConnect();
  renderReviewLink();
  if (S.serverMode.available && !(S.serverMode.authRequired && !conn.token)) {
    showToast("This tab is now using " + (bookmark.name || shortHost(bookmark.url)) +
      " — open a document from the File menu.", "ok");
  }
}

async function useBookmark(id) {
  var b = bookmarkById(id);
  if (!b) return;
  await useServer(b);
}

/* The PIN dialog, opened deliberately rather than in response to a refusal:
   the code for a server this tab is not on yet, or one whose code has
   changed since. Joining is also switching — the token goes onto the
   connection for that server and no other. */
function askPinFor(id) {
  var b = bookmarkById(id);
  if (!b) return;
  openPinDialog({
    base: b.url,
    reason: "Enter the join PIN or key for " + (b.name || shortHost(b.url)) + ".",
    onDone: function (joined) { useServer(b, joined); }
  });
}

function removeBookmark(id) {
  var b = bookmarkById(id);
  if (!b) return;
  S.serverBookmarks = S.serverBookmarks.filter(function (x) { return x.id !== id; });
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
  if (home.kind === "server") setHome("none");
  S.serverMode = { available: false, readOnly: false, checked: false, authRequired: false,
                 reviewAvailable: false, version: null };
  pointTabAt("", { makeDefault: true });
  updateConnectMenu();
  await detectServer();
  applyReviewMode();
  if (S.state) render();
  updateFileChip();
  renderConnect();
  renderReviewLink();
  showToast("This tab is back on this copy of Splitpage.", "ok");
}

/* ---- the SSH helper ----

   Splitpage never spawns ssh from the page — a web page that could start
   processes would be a far bigger hole than anything it opened. It writes
   the command out; you run it. */

export function tunnelCommand(t) {
  return "ssh -N -L " + t.localPort + ":localhost:" + t.remotePort + " " + t.userHost;
}

function sshCommandFor(bookmark) {
  return tunnelCommand(bookmark.ssh);
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

/* navigator.clipboard needs a secure origin, and a shared session on a LAN
   is plain HTTP — so the old textarea trick is the path that actually runs
   most of the time here, not the fallback it looks like. */
async function copyPlainText(text, okMsg, failMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg, "ok");
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
    showToast(okMsg, "ok");
  } catch (err) {
    showToast(failMsg, "warn");
  }
}

async function copySshCommand() {
  if (!sshShownFor) return;
  var b = bookmarkById(sshShownFor);
  if (!b) return;
  await copyPlainText(sshCommandFor(b), "Command copied.",
    "Could not copy — select the command and copy it by hand.");
}

async function copyReviewLink() {
  if (!reviewLinkUrl) return;
  await copyPlainText(reviewLinkUrl, "Review link copied — anyone who opens it can comment, not edit.",
    "Could not copy — select the address and copy it by hand.");
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

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  loadBookmarks();

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
        else if (action === "review-copy") copyReviewLink();
        else if (action === "collaborate") { closeServersDialog(); openCollaborate(); }
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
}
