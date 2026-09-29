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
import { deliverFile, updateFileChip } from "./18-local-files.js";
import { setMenuItemLabel, toggleFileMenu } from "./18b-file-menu.js";
import { renderDesktopShareInfo } from "./20f-desktop.js";

export var SERVER_BOOKMARKS_KEY = "splitpage-server-bookmarks";

S.serverBookmarks = [];
var pinRequest = null;
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
  } catch (e) { }
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

export function openPinDialog(opts) {
  opts = opts || {};
  var modal = document.getElementById("pin-modal");
  if (!modal) return;
  pinRequest = {
    base: opts.base === undefined ? conn.serverUrl : opts.base,
    onDone: opts.onDone || null
  };
  document.getElementById("pin-reason").textContent =
    opts.reason || "This server asks for a join PIN.";
  var input = document.getElementById("pin-input");
  input.value = "";
  setPinError("");
  modal.hidden = false;
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
  try { body = await res.json(); } catch (e) { }
  if (res.ok && body && body.token) return { ok: true, token: body.token, role: body.role || "edit" };
  if (res.status === 429) return { ok: false, error: "too-many-attempts" };
  if (res.status === 404 || !body) return { ok: false, error: "not-splitpage" };
  return { ok: false, error: (body && body.error) || ("HTTP " + res.status) };
}

export function joinErrorText(code) {
  if (code === "bad-pin") return "That code was not right. Ask whoever is hosting for it again.";
  if (code === "too-many-attempts") return "Too many wrong codes. Wait a minute, then try again.";
  if (code === "offline") return "No answer from that address. Check it, and that the session is still running.";
  if (code === "not-splitpage") return "Something answered, but it was not a Splitpage server.";
  return "Could not join: " + code + ".";
}

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
  var result = await withBusy(document.querySelector('#pin-modal [data-connect-action="pin-submit"]'),
    "Checking…", function () { return joinServer(pinRequest.base, pin); });
  if (!result.ok) {
    setPinError(joinErrorText(result.error));
    input.select();
    return;
  }
  if (!pinRequest) return;
  var done = pinRequest.onDone;
  var base = pinRequest.base;
  closePinDialog();
  var forThisTab = normalizeServerBase(base) === conn.serverUrl;
  if (forThisTab) setServerToken(result.token, remember);
  showToast("Joined" + (base ? " " + shortHost(base) : "") +
    (result.role === "review" ? " — viewing and commenting only." : "."), "ok");
  if (done) { done({ token: result.token, remember: remember }); return; }
  if (!forThisTab) return;
  if (S.serverMode.available) finishServerDetect();
  else detectServer();
}

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

var reviewLinkUrl = "";

async function renderReviewLink() {
  var box = document.getElementById("connect-review");
  if (!box) return;
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
        '<button type="button" class="btn" data-connect-action="pin" data-id="' +
          escapeHtml(b.id) + '" title="Enter this server\'s join PIN">PIN</button>' +
        (isCurrent ? '' : '<button type="button" class="btn btn-accent" data-connect-action="use" data-id="' +
          escapeHtml(b.id) + '">Use this server</button>') +
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

  var joined = null;
  if (pin) {
    joined = await withBusy(document.querySelector('#connect-modal [data-connect-action="add"]'),
      "Checking…", function () { return joinServer(url, pin); });
    if (!joined.ok) { setConnectError(joinErrorText(joined.error)); return; }
  }

  var bookmark = { id: newBookmarkId(), name: name || shortHost(url), url: url };
  if (ssh) bookmark.ssh = ssh;
  S.serverBookmarks.push(bookmark);
  saveBookmarks();

  document.getElementById("connect-name").value = "";
  document.getElementById("connect-url").value = "";
  document.getElementById("connect-pin").value = "";

  if (joined && joined.ok) {
    await useServer(bookmark, { token: joined.token, remember: remember });
    return;
  }
  renderConnect();
  updateConnectMenu();
  showToast("Saved " + bookmark.name + ".", "ok");
}

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

function tunnelOf(bookmark) {
  var s = bookmark && bookmark.ssh;
  if (!s || typeof s !== "object") return null;
  return { userHost: String(s.userHost || ""), remotePort: Number(s.remotePort), localPort: Number(s.localPort) };
}

async function useServer(bookmark, opts) {
  opts = opts || {};
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

function askPinFor(id) {
  var b = bookmarkById(id);
  if (!b) return;
  openPinDialog({
    base: b.url,
    reason: "Enter the join PIN for " + (b.name || shortHost(b.url)) + ".",
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

async function copyPlainText(text, okMsg, failMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg, "ok");
    return;
  } catch (e) { }
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

export function __init() {
  loadBookmarks();

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
        else if (action === "back") backToThisCopy();
      });
      var sshToggle = document.getElementById("connect-ssh-toggle");
      if (sshToggle) {
        sshToggle.addEventListener("change", function () {
          document.getElementById("connect-ssh-fields").hidden = !sshToggle.checked;
        });
      }
    }

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
