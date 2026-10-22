import { S } from "./_state.js";
import { currentDocument } from "../legacy/session-bridge.ts";
import { authorityOf, isOwner } from "../application/collaboration/authority.ts";
import { runIsStale } from "../application/collaboration/workflow.ts";
import { currentConn, currentHome, documentLocation, reviewMode, serverHomeId, serverStatus } from "../legacy/location-bridge.ts";
import { normalizeServerUrl } from "../../shared/server-links.js";
import { personSwatchesHtml, setMyColor, updateIdentityChip } from "./03-sync.js";
import { render } from "./05-render.js";
import { getSavedAuthorName } from "./10-comments.js";
import { apiFetch, applyHealth, applyReviewMode, clearServerToken, finishServerDetect, isLinkGuest, onServerDoc, pointTabAt, publishToServer, rememberTokenForServer, rememberedTokenForServer, serverDocShareUrl, setServerToken, shareAccessNote, updateServerMenu } from "./13-hosted.js";
import { updateFileChip } from "./18-local-files.js";
import { updateConnectMenu } from "./20e-connect.js";
import { openSettings } from "./20s-settings.js";
import { escapeHtml } from "../core/document/text-policy.ts";
import { appActions } from "../legacy/app-actions.ts";
import { preferences, preferencesStarted } from "../legacy/preferences-bridge.ts";
import { copyShareText, setMenuItemReason, showToast } from "../legacy/effects-bridge.ts";
import { cleanAuthorName } from "../core/document/people.ts";
import { parseLinkFragment } from "../../shared/server-links.js";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";
import { joinServer } from "../adapters/transport/server-join.ts";

export var DEFAULT_COLLAB_SERVER = "https://script.bigmanonline.uk/";

export function normalizeCollabServer(input) {
  var raw = String(input == null ? "" : input).trim();
  if (!raw) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    var hostPart = raw.split(/[/?#]/)[0].replace(/:\d+$/, "");
    var lan = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i.test(hostPart);
    raw = (lan ? "http://" : "https://") + raw;
  }
  var u;
  try { u = new URL(raw); } catch (e) { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (!u.hostname || u.username || u.password) return "";
  return normalizeServerUrl(u.origin + u.pathname.replace(/\/+$/, ""));
}

export function inviteLink(base, docId, key) {
  if (!docId || !/^[A-Za-z0-9_-]{1,256}$/.test(String(key || ""))) return "";
  var u;
  try { u = new URL("?doc=" + encodeURIComponent(docId), base); } catch (e) { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.hash = "";
  return u.href + "#invite=" + key;
}

export function serverLabel(url) {
  if (!url) {
    if (runningOnDesktop()) return "this computer's shared session";
    try { return location.host || "this server"; } catch (e) { return "this server"; }
  }
  try { return new URL(url).host || url; } catch (e) { return url; }
}

export function readCollabServer() {
  return normalizeCollabServer(preferences().collabServer()) || DEFAULT_COLLAB_SERVER;
}

function servedByServer() {
  return !currentConn().serverUrl && !!serverStatus().mode().available;
}

function collabTarget() {
  if (onServerDoc()) return { url: currentConn().serverUrl, onTab: true };
  if (servedByServer()) return { url: "", onTab: true };
  var url = readCollabServer();
  var maybeHere = !currentConn().serverUrl && !serverStatus().mode().checked && !runningOnDesktop() &&
    /^https?:$/.test(location.protocol);
  return { url: url, onTab: url === currentConn().serverUrl, maybeHere: maybeHere };
}

export function collabServerView() {
  var here = servedByServer();
  var url = here ? "" : readCollabServer();
  var signedIn = !!rememberedTokenForServer(url) ||
    (currentConn().serverUrl === url && isOwner(authorityOf(currentConn())));
  return { servedHere: here, url: url, label: serverLabel(url), signedIn: signedIn,
           isDefault: !here && url === DEFAULT_COLLAB_SERVER };
}

export function signOutCollab() {
  var view = collabServerView();
  rememberTokenForServer(view.url, "");
  if (currentConn().serverUrl === view.url && currentConn().token && !isLinkGuest()) {
    clearServerToken();
    updateServerMenu();
  }
  showToast("Signed out of " + view.label + " on this device.", "ok");
}

export function collaborateBlockedReason() {
  if (isLinkGuest() || serverStatus().linkTurnedOff() || currentConn().role === "review" || reviewMode()) {
    return "Only the script's owner can invite people";
  }
  if ((onServerDoc() || servedByServer()) && serverStatus().mode().readOnly) return "This server is read-only";
  return "";
}

export function updateCollaborateMenu() {
  var btn = document.getElementById("menu-collaborate");
  if (!btn || !preferencesStarted()) return;
  var why = collaborateBlockedReason();
  btn.disabled = !!why;
  setMenuItemReason(btn, why);
  var t = collabTarget();
  btn.title = why ? why + "."
    : "Stores this script on " + serverLabel(t.url) +
      " and gives you two links to send: one to edit it, one to comment on it.";
  var head = document.getElementById("btn-collab");
  if (head) {
    if (why) head.setAttribute("aria-disabled", "true");
    else head.removeAttribute("aria-disabled");
    head.title = why ? why + "." : "Collaborate — invite people to this script";
  }
}

var MODAL_ID = "collab-modal";
var collab = null;
var collabSeq = 0;
var collabReturnFocus = null;
var ARM_MS = 4000;

var ROLES = [
  { role: "edit", name: "Can edit", icon: "i-pen",
    says: "Anyone with this link can change the script, comment and resolve comments. It opens this script only." },
  { role: "review", name: "Can comment", icon: "i-comment",
    says: "Anyone with this link can read the script, present it and leave comments, but not change it." }
];

function modal() { return document.getElementById(MODAL_ID); }

export function collaborateOpen() {
  var m = modal();
  return !!(m && !m.hidden);
}

function ensureModal() {
  var m = modal();
  if (m) return m;
  m = document.createElement("div");
  m.className = "modal-backdrop";
  m.id = MODAL_ID;
  m.hidden = true;
  m.innerHTML =
    '<div class="modal-panel collab-panel" role="dialog" aria-modal="true" aria-labelledby="collab-title">' +
      '<div class="modal-header">' +
        '<h2 id="collab-title">Collaborate</h2>' +
        '<button type="button" class="modal-close" data-collab-action="close" aria-label="Close"><svg aria-hidden="true" focusable="false"><use href="#i-close"/></svg></button>' +
      '</div>' +
      '<div class="collab-doc"><svg class="collab-doc-icon" aria-hidden="true"><use href="#i-file"/></svg>' +
        '<span class="collab-doc-title" id="collab-doc-title"></span>' +
        '<span class="collab-doc-where" id="collab-doc-where"></span></div>' +
      '<div class="collab-body" id="collab-body" aria-live="polite"></div>' +
      '<div class="modal-footer collab-foot" id="collab-foot"></div>' +
    '</div>';
  document.body.appendChild(m);
  wireModal(m);
  return m;
}

export async function openCollaborate() {
  if (!currentDocument()) { showToast("Still loading…", "warn"); return; }
  var why = collaborateBlockedReason();
  if (why) { showToast(why + ".", "warn"); return; }
  var m = ensureModal();
  var active = document.activeElement;
  collabReturnFocus = active && active !== document.body ? active : document.getElementById("btn-file");
  collab = { seq: ++collabSeq, step: "checking", target: collabTarget(), health: null, token: "",
             note: "", error: null, links: { edit: null, review: null }, base: "", armed: {},
             busy: {}, copied: {} };
  m.hidden = false;
  paint();
  await connectStep(collab);
}

export function closeCollaborate() {
  var m = modal();
  if (!m || m.hidden) return;
  m.hidden = true;
  if (collab) Object.keys(collab.armed).forEach(function (r) { clearTimeout(collab.armed[r].timer); });
  collab = null;
  collabSeq++;
  var back = collabReturnFocus;
  collabReturnFocus = null;
  if (back && back.closest && back.closest("#file-menu")) back = document.getElementById("btn-file");
  if (back && document.contains(back) && back.offsetParent !== null) {
    try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); }
  }
}

var workflowGate = { current: function () { return collab; }, seq: function () { return collabSeq; } };

function stale(c) { return runIsStale(workflowGate, c); }

function go(c, step) {
  if (stale(c)) return;
  c.step = step;
  paint();
}

async function connectStep(c) {
  var t = c.target;
  c.error = null;
  if (t.maybeHere) {
    try {
      var own = await apiFetch("api/health", { base: "", token: currentConn().token });
      if (stale(c)) return;
      if (own && own.ok) {
        t.url = ""; t.onTab = true;
        applyHealth(own);
        updateServerMenu();
      }
    } catch (e) { if (stale(c)) return; }
    t.maybeHere = false;
  }
  var health;
  try {
    health = await apiFetch("api/health", t.onTab ? {} : { base: t.url, token: "" });
  } catch (e) {
    if (stale(c)) return;
    c.error = e;
    go(c, "unreachable");
    return;
  }
  if (stale(c)) return;
  if (!health || !health.ok) { c.error = { code: "auth" }; go(c, "unreachable"); return; }
  c.health = health;
  if (t.onTab) { applyHealth(health); updateServerMenu(); updateConnectMenu(); }
  if (health.readOnly && !onServerDoc()) {
    c.error = { code: "read-only" };
    go(c, "error");
    return;
  }
  if (health.authRequired) {
    var token = t.onTab ? currentConn().token : rememberedTokenForServer(t.url);
    if (!token) { go(c, "sign-in"); return; }
    var me;
    try {
      me = await apiFetch("api/me", t.onTab ? {} : { base: t.url, token: token });
    } catch (e2) {
      if (stale(c)) return;
      if (e2 && (e2.code === "pin" || e2.code === "link-off")) {
        if (!t.onTab) rememberTokenForServer(t.url, "");
        else clearServerToken();
        c.note = "expired";
        go(c, "sign-in");
        return;
      }
      c.error = e2;
      go(c, "unreachable");
      return;
    }
    if (stale(c)) return;
    if (me && (me.role === "review" || me.scope)) { c.note = "guest"; go(c, "sign-in"); return; }
    c.token = token;
  }
  afterSignedIn(c);
}

function afterSignedIn(c) {
  if (onServerDoc()) loadLinks(c);
  else go(c, "confirm");
}

async function signInStep(c) {
  var input = document.getElementById("collab-key");
  var key = input ? input.value.trim() : "";
  if (!key) { showSignInError("Enter the owner key first."); if (input) input.focus(); return; }
  var remember = !!(document.getElementById("collab-remember") || {}).checked;
  var t = c.target;
  c.busy.signIn = true;
  paintFoot();
  var joined = await joinServer(t.url, key);
  if (stale(c)) return;
  c.busy.signIn = false;
  if (!joined.ok) {
    paintFoot();
    showSignInError(signInErrorText(joined.error, t.url));
    if (input) input.select();
    return;
  }
  if (joined.role === "review") {
    paintFoot();
    showSignInError("That code only lets you comment. Use the owner key — the server's join PIN.");
    if (input) input.select();
    return;
  }
  if (t.onTab) {
    setServerToken(joined.token, remember);
    documentLocation().updateConnection({ role: "edit", scope: "" });
    updateServerMenu();
    applyReviewMode();
    finishServerDetect();
  } else {
    if (remember) rememberTokenForServer(t.url, joined.token);
    c.token = joined.token;
  }
  c.note = "";
  afterSignedIn(c);
}

function signInErrorText(code, url) {
  var host = serverLabel(url);
  if (code === "bad-pin") return "That isn't the owner key for " + host + ".";
  if (code === "too-many-attempts") return "Too many wrong keys were tried. Wait a minute, then try again.";
  if (code === "offline") return "No answer from " + host + ". Check you're online, and the address in Settings.";
  if (code === "not-splitpage") return "Something answered at " + host + ", but it isn't a Splitpage server.";
  if (code === "link-off") return "That's a link's key, and its link is turned off. Use the owner key.";
  return "Could not sign in: " + code + ".";
}

function showSignInError(text) {
  var el = document.getElementById("collab-error");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
}

async function publishStep(c) {
  var t = c.target;
  go(c, "publishing");
  if (!t.onTab) {
    if (currentHome().kind === "server") { c.error = { code: "moved" }; go(c, "error"); return; }
    serverStatus().forgetMode();
    pointTabAt(t.url, { token: c.token || "" });
    applyHealth(c.health);
    if (c.token || !c.health.authRequired) documentLocation().updateConnection({ role: "edit", scope: "" });
    t.onTab = true;
    updateConnectMenu();
    updateServerMenu();
  }
  var failure = null;
  var ok = await publishToServer({ quiet: true, onError: function (e) { failure = e; } });
  if (stale(c)) {
    if (ok) showToast("“" + (currentDocument().title || "Untitled script") + "” is on " + serverLabel(currentConn().serverUrl) +
      " — File ▸ Collaborate… has its links.", "ok");
    return;
  }
  if (!ok) {
    c.error = failure || { code: "publish" };
    if (failure && failure.code === "pin") { clearServerToken(); c.note = "expired"; go(c, "sign-in"); return; }
    go(c, "error");
    return;
  }
  updateFileChip();
  updateServerMenu();
  loadLinks(c);
}

function hostedId() { return serverHomeId(); }

function linksPath(extra) {
  return "api/docs/" + encodeURIComponent(hostedId()) + "/links" + (extra || "");
}

async function loadLinks(c) {
  go(c, "links-loading");
  c.base = await linkBase();
  if (stale(c)) return;
  if (!(c.health && Number(c.health.links) >= 1)) {
    go(c, "legacy");
    return;
  }
  var list;
  try {
    list = await apiFetch(linksPath());
  } catch (e) {
    if (stale(c)) return;
    if (linksFailure(c, e)) return;
    c.error = e;
    go(c, "error");
    return;
  }
  if (stale(c)) return;
  c.links = { edit: null, review: null };
  ((list && list.links) || []).forEach(function (l) {
    if (l && (l.role === "edit" || l.role === "review") && !c.links[l.role]) c.links[l.role] = l;
  });
  if (!c.links.edit && !c.links.review) {
    try {
      c.links.edit = await apiFetch(linksPath(), { method: "POST", body: { role: "edit" } });
      if (stale(c)) return;
      c.links.review = await apiFetch(linksPath(), { method: "POST", body: { role: "review" } });
    } catch (e2) {
      if (stale(c)) return;
      if (linksFailure(c, e2)) return;
      c.error = e2;
      go(c, "error");
      return;
    }
    if (stale(c)) return;
  }
  go(c, "links");
}

function linksFailure(c, e) {
  if (e && e.code === "conflict" && e.payload && e.payload.error === "no-pin") { go(c, "open-server"); return true; }
  if (e && e.code === "pin") { clearServerToken(); c.note = "expired"; go(c, "sign-in"); return true; }
  return false;
}

async function linkBase() {
  if (currentConn().serverUrl) return currentConn().serverUrl;
  if (runningOnDesktop() && typeof desktopPort().getSessionInfo === "function") {
    try {
      var info = await desktopPort().getSessionInfo();
      var lan = info && Array.isArray(info.lanUrls) ? info.lanUrls[0] : "";
      return lan ? normalizeServerUrl(lan) : "";
    } catch (e) { return ""; }
  }
  return location.href;
}

function linkFor(c, role) {
  var l = c.links[role];
  return l && c.base ? inviteLink(c.base, hostedId(), l.key) : "";
}

function plainLink(c) {
  if (c.base) {
    try { return new URL("?doc=" + encodeURIComponent(hostedId()), c.base).href; } catch (e) {}
  }
  return serverDocShareUrl(hostedId());
}

function arm(c, role, action) {
  var was = c.armed[role];
  if (was) clearTimeout(was.timer);
  if (was && was.action === action) { delete c.armed[role]; return true; }
  c.armed[role] = {
    action: action,
    timer: setTimeout(function () {
      if (stale(c) || !c.armed[role]) return;
      delete c.armed[role];
      paint();
    }, ARM_MS)
  };
  paint();
  return false;
}

async function linkAction(c, role, action) {
  if (c.busy[role]) return;
  if ((action === "new" || action === "off") && !arm(c, role, action)) return;
  c.busy[role] = true;
  paint();
  var l = c.links[role];
  try {
    if (action === "off") {
      if (l) await apiFetch(linksPath("/" + encodeURIComponent(l.id)), { method: "DELETE" });
      if (stale(c)) return;
      c.links[role] = null;
      showToast("The link to " + roleVerb(role) + " is off — it no longer opens the script.", "ok");
    } else {
      var made = await apiFetch(linksPath(), { method: "POST", body: { role: role, replace: action === "new" } });
      if (stale(c)) return;
      c.links[role] = made;
      if (action === "new") showToast("New link to " + roleVerb(role) + " — the old one no longer works.", "ok");
    }
  } catch (e) {
    if (stale(c)) return;
    c.busy[role] = false;
    if (action === "off" && e && e.code === "404" && e.message === "no-such-link") {
      c.links[role] = null;
      paint();
      return;
    }
    if (linksFailure(c, e)) return;
    showToast(collabErrorText(e, currentConn().serverUrl), "warn", true);
    paint();
    return;
  }
  c.busy[role] = false;
  paint();
}

function roleVerb(role) {
  return role === "review" ? "comment" : "edit";
}

async function copyLink(c, role, url) {
  if (!url) return;
  var ok = await copyShareText(url);
  if (stale(c)) return;
  if (ok) {
    c.copied[role] = true;
    paint();
    setTimeout(function () { if (!stale(c)) { c.copied[role] = false; paint(); } }, 1600);
    showToast(role === "review"
      ? "Link copied — whoever opens it can read and comment."
      : role === "edit" ? "Link copied — whoever opens it can edit this script."
      : "Link copied — " + shareAccessNote(), "ok");
  } else {
    showToast("Could not reach the clipboard — select the link and copy it.", "warn");
    var box = document.querySelector('#collab-modal [data-link-role="' + role + '"] .collab-link-url');
    if (box) selectText(box);
  }
}

function selectText(el) {
  try {
    var r = document.createRange();
    r.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } catch (e) {}
}

function collabErrorText(e, url) {
  var host = serverLabel(url);
  var code = e && e.code;
  if (code === "offline") {
    return "No answer from " + host + ". Check you're online and that the address is right" +
      (collab && collab.target && !collab.target.onTab && !runningOnDesktop()
        ? " — and that the server lets this copy of Splitpage connect (its ALLOW_ORIGINS)." : ".");
  }
  if (code === "auth") return "Something answered at " + host + ", but it isn't a Splitpage server.";
  if (code === "read-only") return host + " is read-only, so nothing new can be stored there.";
  if (code === "pin") return "Your sign-in on " + host + " has expired.";
  if (code === "owner-only") return "Only the script's owner can do that.";
  if (code === "moved") return "This tab moved to another script while that was happening. Try again.";
  if (code === "blob-too-large") return "A picture in the script is larger than the server takes (8 MB).";
  if (code === "blob-unsupported") return "A picture in the script is not a PNG, JPEG, GIF or WebP.";
  if (code === "missing-blobs") return "A picture in the script is no longer on this device.";
  if (code === "client-too-old") return "This copy of Splitpage is too old for " + host + ". Reload it and try again.";
  return host + " said: " + ((e && e.message) || "something went wrong") + ".";
}

function unreachableText(c) {
  var code = c.error && c.error.code;
  if (code === "offline") {
    return "Check you're online and that the address is right" +
      (!c.target.onTab && !runningOnDesktop()
        ? " — and that the server lets this copy of Splitpage connect (its ALLOW_ORIGINS)." : ".");
  }
  if (code === "auth") return "Something answered there, but it isn't a Splitpage server.";
  return collabErrorText(c.error, c.target.url);
}

function paint() {
  var c = collab;
  var m = modal();
  if (!c || !m) return;
  var t = c.target;
  var host = serverLabel(t.url);
  document.getElementById("collab-doc-title").textContent = (currentDocument() && currentDocument().title) || "Untitled script";
  document.getElementById("collab-doc-where").textContent =
    onServerDoc() ? "On " + host : "On this device";
  var body = document.getElementById("collab-body");
  var active = document.activeElement;
  var keep = null;
  if (active && m.contains(active) && c.paintedStep === c.step) {
    if (active.id) keep = "#" + active.id;
    else if (active.getAttribute("data-collab-action")) {
      keep = '[data-collab-action="' + active.getAttribute("data-collab-action") + '"]' +
        (active.getAttribute("data-role") ? '[data-role="' + active.getAttribute("data-role") + '"]' : "");
    }
  }
  var typed = document.getElementById("collab-key");
  var typedKey = typed ? typed.value : "";
  var remember = document.getElementById("collab-remember");
  var rememberOn = remember ? remember.checked : true;
  body.innerHTML = bodyHtml(c, host);
  var again = document.getElementById("collab-key");
  if (again) {
    again.value = typedKey;
    var r2 = document.getElementById("collab-remember");
    if (r2) r2.checked = rememberOn;
  }
  paintFoot();
  var newStep = c.paintedStep !== c.step;
  c.paintedStep = c.step;
  var target = keep ? m.querySelector(keep) : null;
  if (target && !target.disabled) { target.focus(); return; }
  if (!newStep && m.contains(document.activeElement)) return;
  var first = m.querySelector("[data-autofocus]") || m.querySelector('#collab-foot [data-collab-action="close"]') ||
    m.querySelector('[data-collab-action="close"]');
  if (first) first.focus();
}

function statusHtml(text) {
  return '<p class="collab-status" role="status"><span class="collab-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
    escapeHtml(text) + '</p>';
}

function bodyHtml(c, host) {
  var hostHtml = "<strong>" + escapeHtml(host) + "</strong>";
  var title = (currentDocument() && currentDocument().title) || "Untitled script";
  switch (c.step) {
    case "checking":
      return statusHtml("Checking " + host + "…");
    case "unreachable":
      return '<div class="connect-error collab-problem">' +
          '<strong>Could not reach ' + escapeHtml(host) + '.</strong> ' + escapeHtml(unreachableText(c)) +
        '</div>' +
        (settingsServer(c)
          ? '<p class="modal-hint collab-after">Collaborate stores scripts on the server in Settings ▸ Collaboration. ' +
            'If that address is wrong, change it there.</p>'
          : '');
    case "sign-in":
      return (c.note === "expired"
          ? '<p class="collab-note">Your sign-in on ' + hostHtml + ' has expired. Enter the owner key again.</p>'
          : c.note === "guest"
            ? '<p class="collab-note">This device is using a guest link on ' + hostHtml + '. Sign in with the owner key to invite people.</p>'
            : '') +
        '<p class="modal-hint">Sign in to ' + hostHtml + ' with its <strong>owner key</strong> — the long code the server was set up with ' +
          '(its join PIN). You only need it once on this device.</p>' +
        '<label class="collab-field-label" for="collab-key">Owner key</label>' +
        '<input type="password" id="collab-key" class="collab-input" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Owner key" data-autofocus>' +
        '<div class="connect-error" id="collab-error" hidden></div>' +
        '<label class="connect-check"><input type="checkbox" id="collab-remember" checked> Remember on this device</label>';
    case "confirm":
      return '<p class="collab-lead">Collaborating stores this script on ' + hostHtml +
          ' — everyone edits that copy. <strong>Save a copy…</strong> still gives you a file any time.</p>' +
        '<p class="modal-hint">Then you get two links to send: one for people who can edit, one for people who can only comment. ' +
          'Nobody needs an account, a code or anything installed.</p>';
    case "publishing":
      return statusHtml("Storing “" + title + "” on " + host + "…");
    case "links-loading":
      return statusHtml("Getting the links…");
    case "links":
      return linksHtml(c);
    case "legacy":
      return legacyHtml(c);
    case "open-server":
      return '<p class="collab-note collab-warn">' + hostHtml + ' has no owner key, so anyone who can reach it can already open and edit ' +
          'every script on it. There is nothing private to make a link to — this is its address:</p>' +
        plainLinkRow(c, plainLink(c));
    case "error":
      return '<div class="connect-error collab-problem"><strong>' +
          escapeHtml(onServerDoc() ? "That didn’t work." : "Could not store the script.") + '</strong> ' +
          escapeHtml(collabErrorText(c.error, c.target.url)) + '</div>' +
        (onServerDoc() ? '' : '<p class="modal-hint collab-after">Nothing changed: the script is still only on this device.</p>');
  }
  return "";
}

function settingsServer(c) {
  return !!c.target.url && !onServerDoc() && c.target.url === readCollabServer();
}

function linksHtml(c) {
  var rows = ROLES.map(function (r) { return linkRowHtml(c, r); }).join("");
  var persist = !(c.health && c.health.linksPersist === false);
  var noBase = !c.base;
  return '<div class="collab-links">' + rows + '</div>' +
    (noBase ? '<p class="collab-note collab-warn">No network address found for this computer yet — check it is on a network, then open Collaborate again.</p>' : '') +
    '<p class="modal-hint collab-after">Whoever opens a link is asked for their name the first time. ' +
      'No account, no code, nothing to install — a phone works too.</p>' +
    (persist ? '' : '<p class="collab-note collab-warn">These links stop working when this sharing session ends.</p>');
}

function linkRowHtml(c, r) {
  var url = linkFor(c, r.role);
  var off = !c.links[r.role];
  var armed = c.armed[r.role];
  var busy = !!c.busy[r.role];
  var head = '<div class="collab-link-head">' +
      '<span class="collab-link-name"><svg class="collab-link-icon" aria-hidden="true"><use href="#' + r.icon + '"/></svg>' +
        escapeHtml(r.name) + '</span>' +
      (off ? '<span class="collab-link-state">Off</span>' :
        '<span class="collab-link-actions">' +
          '<button type="button" class="btn-outline is-small' + (armed && armed.action === "new" ? ' armed' : '') +
            '" data-collab-action="new" data-role="' + r.role + '"' + (busy ? ' disabled' : '') + '>' +
            (armed && armed.action === "new" ? "Replace link" : "New link") + '</button>' +
          '<button type="button" class="btn-outline is-small collab-off' + (armed && armed.action === "off" ? ' armed' : '') +
            '" data-collab-action="off" data-role="' + r.role + '"' + (busy ? ' disabled' : '') + '>' +
            (armed && armed.action === "off" ? "Turn it off" : "Turn off") + '</button>' +
        '</span>') +
    '</div>';
  var says = '<p class="collab-link-says">' + escapeHtml(r.says) + '</p>';
  var main = off
    ? '<div class="collab-link-row is-off"><span class="collab-link-offtext">No link — nobody can open the script this way.</span>' +
        '<button type="button" class="btn-outline is-small" data-collab-action="make" data-role="' + r.role + '"' + (busy ? ' disabled' : '') +
        '>Make a link</button></div>'
    : '<div class="collab-link-row">' +
        '<div class="collab-link-url" tabindex="0" aria-label="' + escapeHtml(r.name) + ' link">' + escapeHtml(url || "…") + '</div>' +
        '<button type="button" class="btn btn-accent collab-copy" data-collab-action="copy" data-role="' + r.role + '"' +
          (url ? '' : ' disabled') + '>' + (c.copied[r.role] ? "Copied" : "Copy") + '</button>' +
      '</div>';
  var warn = armed
    ? '<p class="collab-link-warn" role="status">' + escapeHtml(armed.action === "new"
        ? "Press Replace link to make a new one — the link above stops working for everyone who has it."
        : "Press Turn it off to confirm — the link above stops working for everyone who has it.") + '</p>'
    : '';
  return '<section class="collab-link' + (off ? ' is-off' : '') + '" data-link-role="' + r.role + '" aria-label="' +
    escapeHtml(r.name) + '">' + head + says + main + warn + '</section>';
}

function plainLinkRow(c, url) {
  return '<div class="collab-links"><section class="collab-link" data-link-role="plain" aria-label="Link">' +
    '<div class="collab-link-row">' +
      '<div class="collab-link-url" tabindex="0" aria-label="Link">' + escapeHtml(url) + '</div>' +
      '<button type="button" class="btn btn-accent collab-copy" data-collab-action="copy" data-role="plain">' +
        (c.copied.plain ? "Copied" : "Copy") + '</button>' +
    '</div></section></div>';
}

function legacyHtml(c) {
  return '<p class="modal-hint">' + escapeHtml(serverLabel(c.target.url)) + ' is older than Collaborate, so it has one link for everyone. ' +
      escapeHtml(shareAccessNote()) + '</p>' +
    plainLinkRow(c, plainLink(c));
}

function footButton(action, label, accent, extra) {
  return '<button type="button" class="btn' + (accent ? ' btn-accent' : '') + '" data-collab-action="' + action + '"' +
    (extra || '') + '>' + escapeHtml(label) + '</button>';
}

function paintFoot() {
  var c = collab;
  var foot = document.getElementById("collab-foot");
  if (!c || !foot) return;
  var left = "<span></span>";
  var right;
  switch (c.step) {
    case "checking":
    case "publishing":
    case "links-loading":
      right = footButton("close", "Cancel");
      break;
    case "unreachable":
      if (settingsServer(c)) left = footButton("settings", "Change the address…");
      right = footButton("close", "Cancel") + footButton("retry", "Try again", true, ' data-autofocus');
      break;
    case "sign-in":
      if (settingsServer(c)) left = footButton("settings", "Change the address…");
      right = footButton("close", "Cancel") +
        footButton("sign-in", c.busy.signIn ? "Signing in…" : "Sign in", true, c.busy.signIn ? " disabled" : "");
      break;
    case "confirm":
      right = footButton("close", "Cancel") + footButton("publish", "Collaborate", true, ' data-autofocus');
      break;
    case "error":
      right = footButton("close", "Close") + footButton("retry", "Try again", true, ' data-autofocus');
      break;
    default:
      right = footButton("close", "Done", true);
  }
  foot.innerHTML = left + '<div class="modal-footer-actions">' + right + '</div>';
}

function wireModal(m) {
  m.addEventListener("click", function (e) {
    if (e.target === m) { closeCollaborate(); return; }
    var btn = e.target.closest("[data-collab-action]");
    if (!btn || btn.disabled || !collab) return;
    var c = collab;
    var action = btn.getAttribute("data-collab-action");
    var role = btn.getAttribute("data-role");
    if (action === "close") closeCollaborate();
    else if (action === "retry") {
      c.step = "checking";
      c.note = "";
      c.target = collabTarget();
      paint();
      connectStep(c);
    } else if (action === "settings") {
      closeCollaborate();
      openSettings({ focus: "settings-collab-server" });
    } else if (action === "sign-in") signInStep(c);
    else if (action === "publish") publishStep(c);
    else if (action === "copy") {
      copyLink(c, role, role === "plain"
        ? (c.step === "legacy" || c.step === "open-server" ? plainLink(c) : "")
        : linkFor(c, role));
    } else if (action === "new" || action === "off" || action === "make") linkAction(c, role, action);
  });
  m.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCollaborate(); return; }
    if (e.key === "Enter" && e.target && e.target.id === "collab-key" && collab) {
      e.preventDefault();
      if (!collab.busy.signIn) signInStep(collab);
      return;
    }
    if (e.key !== "Tab") return;
    trapTab(m, e);
  });
  m.addEventListener("focusin", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("collab-link-url")) selectText(e.target);
  });
}

function trapTab(m, e) {
  var focusables = Array.prototype.filter.call(
    m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    function (el) { return !el.disabled && el.offsetParent !== null; }
  );
  if (!focusables.length) return;
  var first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

var GUEST_ID = "guest-modal";
var GUEST_ASKED_KEY = "splitpage-guest-asked";

export function maybeAskGuestName() {
  if (getSavedAuthorName()) return false;
  try { if (sessionStorage.getItem(GUEST_ASKED_KEY)) return false; } catch (e) {}
  try { sessionStorage.setItem(GUEST_ASKED_KEY, "1"); } catch (e) {}
  openGuestName();
  return true;
}

function openGuestName() {
  var m = document.getElementById(GUEST_ID);
  if (!m) {
    m = document.createElement("div");
    m.className = "modal-backdrop";
    m.id = GUEST_ID;
    m.hidden = true;
    document.body.appendChild(m);
    wireGuest(m);
  }
  var title = (currentDocument() && currentDocument().title) || "this script";
  var can = reviewMode() ? "you can read it, present it and leave comments."
    : "you can edit it and leave comments.";
  m.innerHTML =
    '<div class="modal-panel guest-panel" role="dialog" aria-modal="true" aria-labelledby="guest-title">' +
      '<div class="modal-header">' +
        '<h2 id="guest-title">What’s your name?</h2>' +
        '<button type="button" class="modal-close" data-guest-action="skip" aria-label="Close"><svg aria-hidden="true" focusable="false"><use href="#i-close"/></svg></button>' +
      '</div>' +
      '<p class="modal-hint">You’re in <strong>' + escapeHtml(title) + '</strong> — ' + escapeHtml(can) +
        ' Your name goes on your changes and comments, and shows the others where you are.</p>' +
      '<label class="collab-field-label" for="guest-name">Your name</label>' +
      '<input type="text" id="guest-name" class="collab-input" autocomplete="name" placeholder="Your name">' +
      personSwatchesHtml("", "guest-person-color", "collab-field-label") +
      '<div class="modal-footer">' +
        '<span></span>' +
        '<div class="modal-footer-actions">' +
          '<button type="button" class="btn" data-guest-action="skip">Skip</button>' +
          '<button type="button" class="btn btn-accent" data-guest-action="save">Continue</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  m.hidden = false;
  var input = document.getElementById("guest-name");
  if (input) input.focus();
}

function closeGuestName() {
  var m = document.getElementById(GUEST_ID);
  if (m) m.hidden = true;
}

function saveGuestName() {
  var input = document.getElementById("guest-name");
  var v = input ? cleanAuthorName(input.value) : "";
  if (!v) { if (input) input.focus(); return; }
  preferences().setCommentAuthor(v);
  updateIdentityChip();
  if (S.state) render();
  closeGuestName();
  showToast("Hi " + v + " — that's how the others will see you.", "ok");
}

function wireGuest(m) {
  m.addEventListener("click", function (e) {
    if (e.target === m) { closeGuestName(); return; }
    var btn = e.target.closest("[data-guest-action]");
    if (!btn) return;
    if (btn.getAttribute("data-guest-action") === "save") saveGuestName();
    else closeGuestName();
  });
  m.addEventListener("change", function (e) {
    if (e.target && e.target.name === "guest-person-color") setMyColor(e.target.value);
  });
  m.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeGuestName(); return; }
    if (e.key === "Enter" && e.target && e.target.id === "guest-name") { e.preventDefault(); saveGuestName(); return; }
    if (e.key === "Tab") trapTab(m, e);
  });
}

export function __init() {
  updateCollaborateMenu();
  var headBtn = document.getElementById("btn-collab");
  if (headBtn) {
    headBtn.addEventListener("click", function () {
      appActions.invoke("collaborate", "button");
    });
    headBtn.addEventListener("pointerenter", updateCollaborateMenu);
    headBtn.addEventListener("focus", updateCollaborateMenu);
  }

  window.__collabTest = {
    open: openCollaborate,
    close: closeCollaborate,
    isOpen: collaborateOpen,
    step: function () { return collab ? collab.step : ""; },
    target: function () { var t = collabTarget(); return { url: t.url, onTab: t.onTab }; },
    links: function () { return collab ? { edit: linkFor(collab, "edit"), review: linkFor(collab, "review") } : null; },
    view: collabServerView,
    blocked: collaborateBlockedReason,
    readServer: readCollabServer,
    normalize: normalizeCollabServer,
    parse: parseLinkFragment,
    inviteLink: inviteLink,
    askGuestName: maybeAskGuestName,
    DEFAULT: DEFAULT_COLLAB_SERVER
  };
}
