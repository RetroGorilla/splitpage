import { S } from "./_state.js";
import {
  conn,
  home,
  homeConn,
  normalizeServerUrl,
  serverHomeId,
  setConnection,
  serverOf,
  setHome,
  stillOnServer,
  updateConnection
} from "./_home.js";
import { escapeHtml, migrateRows } from "./02-state.js";
import {
  copyDocHistorySafe,
  migrateDocument,
  mintDocId,
  normalizeDocId
} from "./02b-doc-id.js";
import {
  acceptStash,
  applyMerge,
  clearStash,
  cloneState,
  getEditorName,
  mergeStates,
  pushSnapshot,
  readStash,
  reportMerge,
  setBaseState,
  stashLocalWork,
  updateIdentityChip
} from "./03-sync.js";
import {
  ensureBytes,
  inlineStateImages,
  intern as internBlob,
  recordFor as blobRecordFor,
  bytesForSync,
  setRemoteSource,
  forgetRemoteMisses
} from "./02c-blobs.js";
import { cssAttr, inertBody } from "./04-richtext.js";
import { withBusyBar } from "./04b-busy.js";
import { render, renderAbsorbed } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import {
  captureReplyDrafts,
  formatTimestamp,
  getSavedAuthorName,
  nowIso,
  renderComments,
  saveAuthorName
} from "./10-comments.js";
import { clearDirty, showActionToast, showToast, updateSaveStatus } from "./12-dirty-toast.js";
import { maybeAskGuestName, parseLinkFragment, updateCollaborateMenu } from "./13b-collaborate.js";
import { saveDoc, scheduleAutoSave } from "./14-export.js";
import { requestSave } from "../legacy/save-bridge.ts";
import { deliverFile, updateFileChip } from "./18-local-files.js";
import {
  joinServer,
  openPinDialog,
  openServersDialog,
  shortHost,
  tunnelCommand,
  updateConnectMenu
} from "./20e-connect.js";
import { setMenuItemReason } from "./18b-file-menu.js";
import { closeNewTabPage } from "./20j-newtab.js";
import { armBrowserServerDraft, offerBrowserDraftAfterLinkOff } from "./20g-drafts.js";
import { isSha256Hex, refsIn } from "../../shared/blob-policy.js";
import { idMap } from "../core/document/id-map.ts";
import { VIEWING_ONLY } from "../legacy/review-wording.ts";
import { isDocumentObject } from "../core/migrate.ts";

var sharedDocId;

var SERVER_BASE_KEY = "splitpage-server-base";
var TAB_SERVER_KEY = "splitpage-tab-server";
var SERVER_TOKEN_KEY = "splitpage-server-token";
var REMEMBERED_TOKENS_KEY = "splitpage-server-tokens";
var LAUNCH_TOKEN_KEY = "splitpage-launch-token";
var REVIEW_KEY_KEY = "splitpage-review-key";
var LINK_KEYS_KEY = "splitpage-invites";

var launchToken = "";
var linkKey = "";
var linkKeyFresh = false;
export var linkTurnedOff = false;

S.serverMode = { available: false, readOnly: false, checked: false,
                   authRequired: false, reviewAvailable: false, version: null };
var serverIdentity = null;
export var serverSessionExpired = false;
var serverDocs = [];

export function onServerDoc() { return home.kind === "server"; }

export function reviewMode() {
  var c = homeConn();
  return !!c && c.role === "review";
}

function ApiError(code, message) {
  var e = new Error(message || code);
  e.code = code;
  return e;
}

export var normalizeServerBase = normalizeServerUrl;

function readJsonFrom(storage, key) {
  try {
    var raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function rememberedTokens() {
  var map = readJsonFrom(localStorage, REMEMBERED_TOKENS_KEY);
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

function writeRememberedTokens(map) {
  try {
    if (Object.keys(map).length) localStorage.setItem(REMEMBERED_TOKENS_KEY, JSON.stringify(map));
    else localStorage.removeItem(REMEMBERED_TOKENS_KEY);
  } catch (e) { }
}

function rememberedTokenFor(serverUrl) {
  var t = rememberedTokens()[serverUrl];
  return typeof t === "string" ? t : "";
}

function migrateLegacyRememberedToken() {
  var legacy, base;
  try {
    legacy = localStorage.getItem(SERVER_TOKEN_KEY);
    base = normalizeServerUrl(localStorage.getItem(SERVER_BASE_KEY) || "");
  } catch (e) { return; }
  if (!legacy) return;
  var map = rememberedTokens();
  if (!map[base]) map[base] = legacy;
  writeRememberedTokens(map);
  try { localStorage.removeItem(SERVER_TOKEN_KEY); } catch (e) {}
}

function sessionTokenFor(serverUrl) {
  var raw;
  try { raw = sessionStorage.getItem(SERVER_TOKEN_KEY); } catch (e) { return ""; }
  if (!raw) return "";
  var rec;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (rec && typeof rec === "object") {
    return rec.serverUrl === serverUrl && typeof rec.token === "string" ? rec.token : "";
  }
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : "";
}

function saveTabServer() {
  try {
    sessionStorage.setItem(TAB_SERVER_KEY, JSON.stringify({ serverUrl: conn.serverUrl, tunnel: conn.tunnel }));
    if (conn.token) {
      sessionStorage.setItem(SERVER_TOKEN_KEY, JSON.stringify({ serverUrl: conn.serverUrl, token: conn.token }));
    } else {
      sessionStorage.removeItem(SERVER_TOKEN_KEY);
    }
  } catch (e) { }
}

function loadTabConnection() {
  migrateLegacyRememberedToken();
  var from = null;
  var boot = S.DESKTOP && S.DESKTOP.connection;
  if (boot && typeof boot === "object") from = boot;
  if (!from) {
    var mine = readJsonFrom(sessionStorage, TAB_SERVER_KEY);
    if (mine && typeof mine === "object") from = mine;
  }
  if (!from) {
    var fallback;
    try { fallback = localStorage.getItem(SERVER_BASE_KEY) || ""; } catch (e) { fallback = ""; }
    from = { serverUrl: fallback };
  }
  var serverUrl = normalizeServerUrl(from.serverUrl);
  var token = (typeof from.token === "string" && from.token) || sessionTokenFor(serverUrl) ||
              rememberedTokenFor(serverUrl);
  try {
    setConnection({ serverUrl: serverUrl, token: token, tunnel: from.tunnel || null });
  } catch (e) {
    setConnection({});
  }
  saveTabServer();
}

export function pointTabAt(serverUrl, opts) {
  opts = opts || {};
  var url = normalizeServerUrl(serverUrl);
  setConnection({
    serverUrl: url,
    token: opts.token || rememberedTokenFor(url),
    tunnel: opts.tunnel || null
  });
  saveTabServer();
  if (opts.makeDefault) {
    try {
      if (url) localStorage.setItem(SERVER_BASE_KEY, url);
      else localStorage.removeItem(SERVER_BASE_KEY);
    } catch (e) { }
  }
  return conn;
}

export function apiUrl(path) {
  var rel = String(path || "").replace(/^\/+/, "");
  return conn.serverUrl ? conn.serverUrl + rel : rel;
}

export function setServerToken(token, remember) {
  updateConnection({ token: String(token || "") });
  saveTabServer();
  var map = rememberedTokens();
  if (remember) map[conn.serverUrl] = conn.token;
  else delete map[conn.serverUrl];
  writeRememberedTokens(map);
}

export function clearServerToken() {
  updateConnection({ token: "", role: "", scope: "" });
  saveTabServer();
  var map = rememberedTokens();
  if (Object.prototype.hasOwnProperty.call(map, conn.serverUrl)) {
    delete map[conn.serverUrl];
    writeRememberedTokens(map);
  }
}

function setLinkToken(token) {
  updateConnection({ token: String(token || "") });
  saveTabServer();
}

export function rememberedTokenForServer(serverUrl) {
  return rememberedTokenFor(normalizeServerUrl(serverUrl));
}

export function rememberTokenForServer(serverUrl, token) {
  var url = normalizeServerUrl(serverUrl);
  var map = rememberedTokens();
  if (token) map[url] = String(token);
  else delete map[url];
  writeRememberedTokens(map);
}

function readLinkKey() {
  linkKeyFresh = false;
  var found = parseLinkFragment(location.hash || "");
  if (found) {
    linkKey = found.key;
    linkKeyFresh = true;
    try { sessionStorage.setItem(REVIEW_KEY_KEY, linkKey); } catch (e) {}
    try {
      history.replaceState(null, "", location.pathname + location.search + found.rest);
    } catch (e) { }
    return;
  }
  try { linkKey = sessionStorage.getItem(REVIEW_KEY_KEY) || ""; } catch (e) { linkKey = ""; }
  if (linkKey) return;
  var saved = deviceLinkKeys()[conn.serverUrl];
  if (saved && typeof saved.key === "string") linkKey = saved.key;
}

function deviceLinkKeys() {
  var map = readJsonFrom(localStorage, LINK_KEYS_KEY);
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

function writeDeviceLinkKeys(map) {
  try {
    if (Object.keys(map).length) localStorage.setItem(LINK_KEYS_KEY, JSON.stringify(map));
    else localStorage.removeItem(LINK_KEYS_KEY);
  } catch (e) {}
}

function rememberLinkKey(serverUrl, key, docId, persist) {
  try { sessionStorage.setItem(REVIEW_KEY_KEY, key); } catch (e) {}
  var map = deviceLinkKeys();
  if (persist) map[serverUrl] = { key: key, doc: docId || "" };
  else delete map[serverUrl];
  writeDeviceLinkKeys(map);
}

function forgetLinkKey(serverUrl) {
  linkKey = "";
  linkKeyFresh = false;
  try { sessionStorage.removeItem(REVIEW_KEY_KEY); } catch (e) {}
  var map = deviceLinkKeys();
  if (Object.prototype.hasOwnProperty.call(map, serverUrl)) {
    delete map[serverUrl];
    writeDeviceLinkKeys(map);
  }
}

export function arrivingOnLink() {
  return !!linkKey || !!sharedDocId;
}

export function isLinkGuest() {
  return !!conn.scope;
}

function holdsOwnerSignIn() {
  return !!conn.token && conn.token === rememberedTokenFor(conn.serverUrl);
}

var CLIENT_HEADER = "x-splitpage-client";
var CLIENT_GENERATION = "2";
var serverCaps = new WeakMap();

function capsOf(c) {
  var server = serverOf(c);
  return (server && serverCaps.get(server)) || { blobs: false, noClientHeader: false, known: false };
}

function noteCaps(c, health, noClientHeader) {
  var server = serverOf(c);
  if (!server) return;
  serverCaps.set(server, {
    blobs: !!(health && Number(health.blobs) >= 1),
    noClientHeader: !!noClientHeader,
    known: true
  });
}

function serverTakesBlobs() {
  return capsOf(conn).blobs;
}

function clientHeaders(headers, opts) {
  var other = !!(opts && opts.base !== undefined);
  var token = opts && opts.token !== undefined ? opts.token : conn.token;
  if (token) headers["x-splitpage-token"] = token;
  if (!(opts && opts.noClientHeader) && (other || !capsOf(conn).noClientHeader)) headers[CLIENT_HEADER] = CLIENT_GENERATION;
  return headers;
}

export async function apiFetch(path, opts) {
  opts = opts || {};
  var headers = opts.raw
    ? { "Content-Type": opts.contentType || "application/octet-stream", "Accept": "application/json" }
    : opts.body
      ? { "Content-Type": "application/json", "Accept": "application/json" }
      : { "Accept": "application/json" };
  clientHeaders(headers, opts);
  var base = opts.base !== undefined ? normalizeServerUrl(opts.base) : conn.serverUrl;
  var rel = String(path || "").replace(/^\/+/, "");
  var res;
  try {
    res = await fetch(base ? base + rel : rel, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.raw ? opts.raw : opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: base ? "omit" : "same-origin",
      cache: "no-store"
    });
  } catch (e) {
    throw ApiError("offline", "no answer from the server");
  }

  var ctype = res.headers.get("content-type") || "";
  if (opts.raw && res.status === 413) throw ApiError("blob-too-large", "too-large");
  if (res.redirected || (!ctype.includes("application/json") && res.status !== 204)) {
    throw ApiError("auth", "signed out");
  }
  if (res.status === 401 || res.status === 403) {
    var body403 = await res.json().catch(function () { return null; });
    if (body403 && body403.error === "read-only") throw ApiError("read-only", "read-only");
    if (body403 && body403.error === "review-only") {
      var e403 = ApiError("review-only", "this link can comment, but not change the script");
      e403.detail = body403.detail || "";
      throw e403;
    }
    if (body403 && (body403.error === "pin-required" || body403.error === "bad-pin")) {
      throw ApiError("pin", "this server asks for a join PIN");
    }
    if (body403 && body403.error === "link-off") throw ApiError("link-off", "the owner turned off this link");
    if (body403 && body403.error === "owner-only") throw ApiError("owner-only", "only the script's owner can do that");
    if (body403 && body403.error === "wrong-document") {
      throw ApiError("wrong-document", "this link opens a different script");
    }
    throw ApiError("auth", "signed out");
  }
  if (res.status === 410) {
    var body410 = await res.json().catch(function () { return null; });
    if (body410 && body410.error === "link-off") throw ApiError("link-off", "the owner turned off this link");
    var gone = ApiError("410", (body410 && body410.error) || "HTTP 410");
    gone.payload = body410;
    throw gone;
  }
  if (res.status === 429) {
    var body429 = await res.json().catch(function () { return null; });
    if (body429 && body429.error === "too-many-attempts") {
      throw ApiError("pin-blocked", "too many wrong codes — wait a minute and try again");
    }
    if (body429 && body429.error === "review-budget") {
      throw ApiError("review-budget", "this link's image allowance is used up for now");
    }
  }
  if (res.status === 426) throw ApiError("client-too-old", "this page is out of date");

  var body = res.status === 204 ? null : await res.json().catch(function () { return null; });
  if (res.status === 409) { var c = ApiError("conflict"); c.payload = body; throw c; }
  if (res.status === 404 && body && body.error === "not-found") throw ApiError("not-found");
  if (res.status === 422 && body && body.error === "missing-blobs") {
    var mb = ApiError("missing-blobs", "an image in it is not on the server");
    mb.payload = body;
    throw mb;
  }
  if (opts.raw && res.status === 415) throw ApiError("blob-unsupported", (body && body.error) || "unsupported-type");
  if (!res.ok) {
    var ge = ApiError(String(res.status), (body && body.error) || ("HTTP " + res.status));
    ge.payload = body;
    throw ge;
  }
  return body;
}

export var SERVER_RESUME_KEY = "splitpage-server-resume";

S.draftServerResume = null;

function stashForReload() {
  var stashed = false;
  if (onServerDoc()) {
    try {
      sessionStorage.setItem(SERVER_RESUME_KEY, JSON.stringify({ id: home.id, rev: home.rev }));
      stashed = stashLocalWork();
      if (!stashed) sessionStorage.removeItem(SERVER_RESUME_KEY);
    } catch (e) { stashed = false; }
  }
  return stashed;
}

function flagServerSessionExpired() {
  if (serverSessionExpired) return;
  serverSessionExpired = true;
  var stashed = stashForReload();
  showToast(stashed
    ? "Your sign-in expired. Reload the page to sign in again — your unsaved edits are kept and will be merged back in."
    : "Your sign-in expired. Copy anything unsaved, then reload the page to sign in again.",
    "warn", true);
  updateFileChip();
}

var clientTooOld = false;

function flagClientTooOld() {
  if (clientTooOld) return;
  clientTooOld = true;
  var stashed = stashForReload();
  showToast(stashed
    ? "This page is out of date for this server. Reload it to keep saving — your unsaved edits are kept and will be merged back in."
    : "This page is out of date for this server. Copy anything unsaved, then reload the page to keep saving.",
    "warn", true);
  updateFileChip();
}

function flagLinkOff(kind) {
  if (linkTurnedOff) return;
  linkTurnedOff = true;
  if (kind === "arrived") {
    forgetLinkKey(conn.serverUrl);
    showToast("This link has been turned off. Ask whoever sent it for a new one.", "warn", true);
    updateFileChip();
    updateSaveStatus();
    updateServerMenu();
    offerDraftAfterLinkOff();
    return;
  }
  stashForReload();
  forgetLinkKey(conn.serverUrl);
  var saveCopy = function () { saveDoc({ saveAs: true }); };
  showActionToast(kind === "gone"
    ? "This link no longer works — ask whoever sent it for a new one. Your changes can't be saved to it any more."
    : "The owner turned off this link. Your changes can't be saved to it any more.",
  "warn", "Save a copy…", saveCopy, true);
  updateFileChip();
  updateSaveStatus();
  updateServerMenu();
  offerDraftAfterLinkOff();
}

function offerDraftAfterLinkOff() {
  if (S.DESKTOP || onServerDoc()) return;
  offerBrowserDraftAfterLinkOff(conn.scope || sharedDocId || linkDocId || "");
}

function pendingServerResume() {
  var override = S.draftServerResume;
  if (override) return { id: override.id, rev: override.rev || 0 };
  try {
    var raw = sessionStorage.getItem(SERVER_RESUME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function resumeServerDoc() {
  var override = S.draftServerResume;
  var pending = pendingServerResume();
  if (!pending || !pending.id) return false;

  var seqAtStart = S.editSeq;
  var stateAtStart = S.state ? cloneState(S.state) : null;

  var body;
  var via = conn;
  try {
    body = await apiFetch("api/docs/" + encodeURIComponent(pending.id));
    if (!stillOnServer(via)) return false;
    forgetRemoteMisses();
  } catch (err) {
    if (override && err && err.code === "not-found") {
      S.draftServerResume = null;
      try { override.onDone("not-found"); } catch (e2) {}
    }
    return false;
  }
  if (!body || !isDocumentObject(body.state)) { showToast("That document is empty.", "warn"); return "empty"; }
  if (override) {
    S.draftServerResume = null;
    var samePending;
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
  var theirs = migrateDocument(cloneState(body.state), {
    kind: "server",
    serverId: body.id,
    fallbackId: normalizeDocId(stash && stash.mine && stash.mine.docId) || null
  });
  if (stash) acceptStash(stash, theirs);
  setHome("server", { id: body.id, rev: body.rev || 0 });
  S.docIdWrittenOut = true;
  resetProductionPanelState();
  applyReviewMode();

  var typedDuringResume = stateAtStart && S.editSeq !== seqAtStart;

  if (!stash || !stash.mine || !Array.isArray(stash.mine.rows)) {
    if (typedDuringResume) {
      applyMerge({
        base: stateAtStart,
        mine: S.state,
        theirs: theirs,
        source: "server-resume",
        newBase: cloneState(theirs),
        chips: true,
        noAutoSave: !!override,
        toast: {
          text: function () {
            return "Signed back in — merged what you typed while " +
              (S.state.title || body.id) + " was reopening";
          },
          tone: "warn",
          sticky: true
        }
      });
      if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
      return true;
    }
    S.state = theirs;
    setBaseState(cloneState(S.state), "resumeServerDoc: reopened as the server has it, nothing to merge");
    clearDirty();
    renderAbsorbed();
    updateIdentityChip();
    updateFileChip();
    showToast("Signed back in — reopened " + (S.state.title || body.id), "ok");
    if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
    return true;
  }

  if (!override) clearStash();
  var mine = migrateRows(cloneState(stash.mine));
  if (typedDuringResume) {
    mine = mergeStates(stateAtStart, migrateRows(cloneState(S.state)), mine).merged;
  }
  applyMerge({
    base: stash.base || null,
    mine: mine,
    theirs: theirs,
    source: "server-resume",
    undoPoint: override ? theirs : null,
    keepLabel: override ? "Your unsaved changes, recovered" : null,
    historyFrom: mine.docId,
    newBase: cloneState(theirs),
    chips: true,
    noAutoSave: !!override,
    toast: {
      text: function () {
        return override
          ? "Reopened " + (S.state.title || body.id) +
            " — the changes recovered from the last session were merged back in"
          : "Signed back in — your unsaved edits were merged back in";
      }
    }
  });
  if (override) { try { override.onDone("server-resumed"); } catch (e) {} }
  return true;
}

function handleApiError(err, whatFailed) {
  if (err && err.code === "auth") { flagServerSessionExpired(); return; }
  if (err && err.code === "link-off") { flagLinkOff("off"); return; }
  if (err && err.code === "pin" && (isLinkGuest() || linkKey)) {
    joinWithLinkKey().then(function (r) {
      if (r === "ok") {
        showToast(whatFailed + " — the connection to the server was renewed. " +
          (S.dirty ? "Save again to send your latest changes." : "Try again."), "warn");
      } else if (r === "none" || r === "gone") {
        flagLinkOff("gone");
      } else if (r === "failed") {
        showToast(whatFailed + " — no answer from the server. Try again in a moment.", "warn");
      }
    });
    return;
  }
  if (err && err.code === "pin") {
    clearServerToken();
    openPinDialog({ reason: "This server asks for its join PIN or key." });
    return;
  }
  if (err && err.code === "owner-only") {
    showToast(whatFailed + " — only the script's owner can do that. Your link opens this one script.", "warn");
    return;
  }
  if (err && err.code === "wrong-document") {
    showToast(whatFailed + " — your link opens a different script.", "warn");
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
  if (err && err.code === "review-only") {
    showToast("You are viewing this session — you can comment on it, but not change the script. " +
      "Ask whoever is hosting for the editing code.", "warn", true);
    return;
  }
  if (err && err.code === "client-too-old") { flagClientTooOld(); return; }
  if (err && err.code === "review-budget") {
    showToast(whatFailed + " — this link has used up its allowance for images for now. " +
      "Try again in an hour, or leave the picture out.", "warn", true);
    return;
  }
  if (err && err.code === "blob-too-large") {
    showToast(whatFailed + " — an image in it is larger than the server takes (8 MB). " +
      "Use a smaller picture.", "warn", true);
    return;
  }
  if (err && err.code === "blob-unsupported") {
    showToast(whatFailed + " — an image in it is not a PNG, JPEG, GIF or WebP, which is all the server takes.",
      "warn", true);
    return;
  }
  if (err && err.code === "missing-blobs") {
    showToast(whatFailed + " — an image in it is no longer on this device or on the server. " +
      "Remove it and try again.", "warn", true);
    return;
  }
  showToast(whatFailed + " — " + plainReason(err) + ".", "error");
}

export function plainReason(err) {
  var message = err && err.message ? String(err.message) : "";
  if (err && err.code === "offline") {
    return "there was no answer — check that you are online and that the server is running";
  }
  if (err && err.name === "AbortError") return "it took too long — try again";
  if ((err && err.name === "TypeError") ||
      /failed to fetch|load failed|networkerror|network request failed/i.test(message)) {
    return "the connection failed — check that you are online, then try again";
  }
  return message.replace(/[.\s]+$/, "") || "please try again";
}

export async function detectServer() {
  if (!conn.serverUrl && location.protocol === "file:") { S.serverMode.checked = true; return; }
  var probing = conn;
  try {
    var health = await probeHealth(probing);
    if (!stillOnServer(probing)) return;
    applyHealth(health);
  } catch (e) {
    if (!stillOnServer(probing)) return;
    S.serverMode.available = false;
  }
  if (!stillOnServer(probing)) return;
  S.serverMode.checked = true;
  updateConnectMenu();
  updateServerMenu();
  if (!S.serverMode.available) {
    if (conn.serverUrl) {
      showToast("Could not reach " + conn.serverUrl +
        (conn.tunnel ? " — is the SSH tunnel to " + conn.tunnel.userHost + " running? (" +
          tunnelCommand(conn.tunnel) + ") Or" : " —") +
        " use File ▸ Servers… to pick another, or go back to this copy.", "warn");
    }
    return;
  }

  var useKey = !!linkKey && (!conn.token || (linkKeyFresh && !holdsOwnerSignIn()));
  if (linkKeyFresh && holdsOwnerSignIn()) {
    linkKey = "";
    linkKeyFresh = false;
    try { sessionStorage.removeItem(REVIEW_KEY_KEY); } catch (e) {}
  }
  if (S.serverMode.authRequired && (!conn.token || useKey)) {
    var reason = null;
    if (useKey) {
      var r = await joinWithLinkKey();
      if (!stillOnServer(probing)) return;
      if (r === "ok") { finishServerDetect(); return; }
      if (r === "off") { updateServerMenu(); return; }
      if (r === "gone") reason = "This link no longer works — ask whoever sent it for a new one. " +
        "If you have this server's join PIN or key, enter it here.";
      if (conn.token) { finishServerDetect(); return; }
    }
    updateServerMenu();
    openPinDialog({ reason: reason || ((conn.serverUrl ? shortHost(conn.serverUrl) : "This server") +
      " asks for a join PIN or key before it will show you anything.") });
    return;
  }

  finishServerDetect();
}

export function applyHealth(health) {
  S.serverMode.available = !!(health && health.ok);
  S.serverMode.readOnly = !!(health && health.readOnly);
  S.serverMode.authRequired = !!(health && health.authRequired);
  S.serverMode.reviewAvailable = !!(health && health.reviewAvailable);
  S.serverMode.version = (health && health.version) || null;
  S.serverMode.links = !!(health && Number(health.links) >= 1);
  S.serverMode.linksPersist = !!(health && health.linksPersist === true);
  S.serverMode.checked = true;
  if (!capsOf(conn).known && health) noteCaps(conn, health, false);
}

async function joinWithLinkKey() {
  if (!linkKey || linkTurnedOff) return "none";
  var key = linkKey;
  var via = conn;
  var joined = await joinServer(conn.serverUrl, null, key);
  if (!stillOnServer(via)) return "moved";
  if (joined && joined.ok) {
    linkKeyFresh = false;
    setLinkToken(joined.token);
    var scope = typeof joined.scope === "string" ? joined.scope
      : typeof joined.docId === "string" && joined.role === "review" ? joined.docId : "";
    try {
      updateConnection({ role: joined.role === "review" ? "review" : "edit", scope: scope });
    } catch (e) {}
    linkDocId = joined.docId || scope || "";
    rememberLinkKey(conn.serverUrl, key, linkDocId, !!S.serverMode.linksPersist);
    return "ok";
  }
  if (joined && joined.error === "link-off") {
    flagLinkOff(onServerDoc() || S.dirty ? "off" : "arrived");
    return "off";
  }
  if (joined && joined.error === "bad-pin") { forgetLinkKey(conn.serverUrl); return "gone"; }
  return "failed";
}

var linkDocId = "";

async function probeHealth(probing) {
  var health;
  try {
    health = await apiFetch("api/health");
  } catch (e) {
    if (!(e && e.code === "offline" && probing.serverUrl) || !stillOnServer(probing)) throw e;
    health = await apiFetch("api/health", { noClientHeader: true });
    if (stillOnServer(probing)) noteCaps(probing, health, !(health && Number(health.blobs) >= 1));
    return health;
  }
  if (stillOnServer(probing)) noteCaps(probing, health, false);
  return health;
}

export async function finishServerDetect() {
  var asking = conn;
  try {
    var me = await apiFetch("api/me");
    if (!stillOnServer(asking)) return;
    serverIdentity = me;
    var role = (serverIdentity && serverIdentity.role) === "review" ? "review" : "edit";
    var scope = serverIdentity && typeof serverIdentity.scope === "string" ? serverIdentity.scope
      : (role === "review" ? conn.scope : "");
    try { updateConnection({ role: role, scope: scope }); }
    catch (e2) { updateConnection({ role: role, scope: "" }); }
    if (serverIdentity && serverIdentity.name && !getSavedAuthorName()) {
      saveAuthorName(serverIdentity.name);
      updateIdentityChip();
    }
  } catch (e) {
    if (!stillOnServer(asking)) return;
    if (e && e.code === "link-off") { flagLinkOff("off"); updateServerMenu(); return; }
    if (e && e.code === "pin" && linkKey && !linkTurnedOff) {
      updateConnection({ token: "", role: "", scope: "" });
      saveTabServer();
      var again = await joinWithLinkKey();
      if (!stillOnServer(asking)) return;
      if (again === "ok") { finishServerDetect(); return; }
      if (again === "gone" || again === "none") flagLinkOff("gone");
      updateServerMenu();
      return;
    }
  }

  updateServerMenu();
  applyReviewMode();
  var draftFor = S.DESKTOP ? "" : (conn.scope || sharedDocId || linkDocId || "");
  (draftFor ? armBrowserServerDraft(draftFor) : Promise.resolve(false)).then(function () {
    return resumeServerDoc().then(function (resumed) {
      if (resumed === true) return;
      var refused = resumed === "empty" ? pendingServerResume() : null;
      openSharedDocFromLink(refused ? refused.id : "");
    }, function () { openSharedDocFromLink(""); });
  });
}

export function serverOpenItemState() {
  var guest = isLinkGuest();
  return { hidden: !S.serverMode.available, disabled: guest, reason: guest ? "Your link opens this one script" : "" };
}

export function serverPublishItemState() {
  var guest = isLinkGuest();
  var disabled = !!(S.serverMode.readOnly || conn.role === "review" || guest);
  return {
    hidden: !S.serverMode.available,
    disabled: disabled,
    reason: !disabled ? ""
      : guest ? "Your link opens this one script"
      : conn.role === "review" ? "Viewing only — publishing needs the editing code"
      : "This server is read-only"
  };
}

function paintServerItem(id, state) {
  var el = document.getElementById(id);
  if (!el) return;
  el.hidden = state.hidden;
  el.disabled = state.disabled;
  setMenuItemReason(el, state.reason);
}

export function updateServerMenu() {
  paintServerItem("menu-server-open", serverOpenItemState());
  paintServerItem("menu-server-new", serverPublishItemState());
  updateCollaborateMenu();
}

export function applyReviewMode() {
  var on = reviewMode();
  document.body.classList.toggle("is-review", on);
  var badge = document.getElementById("review-chip");
  if (badge) badge.hidden = !on;
  var title = document.getElementById("doc-title");
  if (title) title.readOnly = on;
}

export { VIEWING_ONLY };

export function reviewBlocked() {
  if (!reviewMode()) return false;
  showToast(VIEWING_ONLY, "warn");
  return true;
}

export async function fetchReviewLink() {
  if (!S.serverMode.available || !S.serverMode.reviewAvailable || conn.role === "review") return "";
  if (S.serverMode.links || isLinkGuest()) return "";
  if (!onServerDoc()) return "";
  var body;
  try { body = await apiFetch("api/share?doc=" + encodeURIComponent(home.id)); } catch (e) { return ""; }
  if (!body || !body.reviewKey) return "";
  var base = conn.serverUrl || (location.origin + "/");
  return base + "?doc=" + encodeURIComponent(body.docId || home.id) +
         "#review=" + body.reviewKey;
}

export async function openServerPicker() {
  var modal = document.getElementById("server-modal");
  var list = document.getElementById("server-doc-list");
  modal.hidden = false;
  list.innerHTML = '<div class="comments-empty">Loading…</div>';
  try {
    var body = await withBusyBar("Listing the documents on the server…", function () {
      return apiFetch("api/docs");
    });
    serverDocs = (body && body.docs) || [];
  } catch (err) {
    list.innerHTML = '<div class="comments-empty">Could not reach the server.</div>';
    handleApiError(err, "Could not list the documents");
    return;
  }
  renderServerPicker();
}

export function closeServerPicker() {
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
    var isOpen = d.id === serverHomeId();
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
      (S.serverMode.readOnly || conn.role === "review" ? '' :
        '<button type="button" class="server-doc-delete" data-action="server-delete" data-id="' +
          escapeHtml(d.id) + '" title="Delete this document from the server" aria-label="Delete from the server">' +
          spriteIcon("i-trash") + '</button>') +
    '</div>';
  }).join("");
}

export async function openServerDoc(id) {
  if (!S.DESKTOP && !S.draftServerResume && await armBrowserServerDraft(id)) {
    if (S.state && S.state.rows.length) pushSnapshot("Before opening a script from the server");
    var resumed = await resumeServerDoc() === true;
    if (resumed) {
      if (typeof closeNewTabPage === "function") closeNewTabPage();
      closeServerPicker();
    }
    return resumed;
  }
  var body;
  var via = conn;
  try {
    body = await apiFetch("api/docs/" + encodeURIComponent(id));
  } catch (err) {
    if (!stillOnServer(via)) return false;
    handleApiError(err, "Could not open that document"); return false;
  }
  if (!stillOnServer(via)) return false;
  if (!body || !isDocumentObject(body.state)) { showToast("That document is empty.", "warn"); return false; }
  forgetRemoteMisses();

  if (S.state && S.state.rows.length) pushSnapshot("Before opening " + (body.state.title || id));

  S.state = migrateDocument(body.state, { kind: "server", serverId: body.id, fallbackId: null });
  setBaseState(cloneState(S.state), "openServerDoc: the document as the server sent it");
  if (typeof closeNewTabPage === "function") closeNewTabPage();
  setHome("server", { id: body.id, rev: body.rev || 0 });
  S.docIdWrittenOut = true;
  resetProductionPanelState();

  clearDirty();
  applyReviewMode();
  renderAbsorbed();
  updateIdentityChip();
  updateFileChip();
  closeServerPicker();
  showToast("Opened " + (S.state.title || id) + " from the server — " + S.state.rows.length +
    " scene" + (S.state.rows.length === 1 ? "" : "s"), "ok");
  return true;
}

export async function publishToServer(opts) {
  opts = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  if (S.serverMode.readOnly) { showToast("This server is published read-only.", "warn"); return false; }
  if (conn.role === "review") {
    showToast("You are viewing this session — publishing a script needs the editing code.", "warn");
    return false;
  }
  if (isLinkGuest()) {
    showToast("Your link opens this one script — only its owner can put a script on the server.", "warn");
    return false;
  }
  var published = cloneState(S.state);
  var seqAtPublish = S.editSeq;
  var oldId = S.state.docId;
  var forkDocId = S.docIdWrittenOut ? mintDocId() : null;
  if (forkDocId) published.docId = forkDocId;
  var body;
  var via = conn;
  var homeAtStart = home;
  try {
    body = await withBusyBar("Publishing to the server…", function () {
      return sendWithBlobs(published, function (sending, acceptMissing) {
        var post = { state: sending, by: getEditorName() };
        if (acceptMissing.length) post.acceptMissing = acceptMissing;
        return apiFetch("api/docs", { method: "POST", body: post });
      }, true);
    });
  } catch (err) {
    if (opts.onError) opts.onError(err);
    else handleApiError(err, "Could not put that on the server");
    return false;
  }
  if (!stillOnServer(via)) return false;
  if (S.state.docId !== oldId || home !== homeAtStart) {
    showToast("Published “" + (published.title || body.id) + "” to the server, but you had opened " +
      "another script by then, so that one was left as it was. You can open the published copy from File ▸ Open from the server….", "warn");
    return false;
  }
  setHome("server", { id: body.id, rev: body.rev || 1 });
  setBaseState(published, "publishToServer: what the server just accepted");
  if (forkDocId) {
    S.state.docId = forkDocId;
    copyDocHistorySafe(oldId, forkDocId);
  }
  S.docIdWrittenOut = true;
  if (S.editSeq === seqAtPublish) clearDirty();
  else scheduleAutoSave();
  updateFileChip();
  if (!opts.quiet) {
    showToast("Published to the server as “" + (S.state.title || body.id) + "” — collaborators can open it now", "ok");
  }
  return true;
}

export function serverDocShareUrl(id) {
  try {
    return new URL("?doc=" + encodeURIComponent(id), conn.serverUrl || location.href).href;
  } catch (e) {
    return (conn.serverUrl || "") + "?doc=" + encodeURIComponent(id);
  }
}

export function shareAccessNote() {
  if (S.serverMode.authRequired) return "They'll need the join PIN to open it.";
  if (serverIdentity && serverIdentity.email) return "They'll need to sign in the same way you did.";
  return "Anyone who can reach that address can open it.";
}

export function copyShareText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return copyShareTextFallback(text); });
  }
  return Promise.resolve(copyShareTextFallback(text));
}

function copyShareTextFallback(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (e) { return false; }
}

export async function publishAndCopyShareLink() {
  if (!S.serverMode.available) {
    showToast("A share link needs a Splitpage server to publish to. " +
      "Pick or add one under Servers…, then try again.", "warn");
    if (typeof openServersDialog === "function") openServersDialog();
    return false;
  }
  if (S.serverMode.readOnly) {
    showToast("This server is published read-only — nothing new can be put on it.", "warn");
    return false;
  }
  if (onServerDoc()) {
    if (S.dirty) {
      var shared = await requestSave({ kind: "server" });
      if (shared.kind !== "saved" && !(shared.kind === "obsolete" && shared.here)) return false;
    }
  } else if (!(await publishToServer()) || !onServerDoc()) {
    return false;
  }
  var url = serverDocShareUrl(home.id);
  var copied = await copyShareText(url);
  showToast(copied
    ? "Link copied — " + shareAccessNote()
    : "Published. Could not reach the clipboard, so here is the link: " + url,
    copied ? "ok" : "warn", !copied);
  return true;
}

function readSharedDocParam() {
  var id;
  try { id = new URLSearchParams(location.search).get("doc") || ""; } catch (e) { id = ""; }
  if (!id) return "";
  try {
    var url = new URL(location.href);
    url.searchParams.delete("doc");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch (e) { }
  return id;
}

async function openSharedDocFromLink(refusedId) {
  var id = conn.scope || sharedDocId || linkDocId;
  sharedDocId = "";
  if (!id || id === refusedId) return false;
  if (onServerDoc()) return false;
  var opened = await openServerDoc(id);
  if (opened && (isLinkGuest() || linkKey)) maybeAskGuestName();
  return true;
}

export async function armServerDelete(btn, id) {
  if (btn.getAttribute("data-armed") === "1") {
    try {
      await apiFetch("api/docs/" + encodeURIComponent(id), { method: "DELETE" });
    } catch (err) { handleApiError(err, "Could not delete that document"); return; }
    if (serverHomeId() === id) setHome("none");
    serverDocs = serverDocs.filter(function (d) { return d.id !== id; });
    renderServerPicker();
    updateFileChip();
    showToast("Deleted from the server", "ok");
    return;
  }
  var label = btn.getAttribute("aria-label");
  btn.setAttribute("data-armed", "1");
  btn.textContent = "Delete?";
  btn.setAttribute("aria-label", "Delete? Click again to confirm");
  btn.classList.add("armed");
  setTimeout(function () {
    if (!btn.isConnected) return;
    btn.removeAttribute("data-armed");
    btn.innerHTML = spriteIcon("i-trash");
    if (label) btn.setAttribute("aria-label", label);
    btn.classList.remove("armed");
  }, 2800);
}

var MISSING_BATCH = 2000;

function uniqueShas(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (sha) {
    if (isSha256Hex(sha) && out.indexOf(sha) === -1) out.push(sha);
  });
  return out;
}

async function blobsMissingOnServer(shas) {
  var out = [];
  for (var i = 0; i < shas.length; i += MISSING_BATCH) {
    var chunk = shas.slice(i, i + MISSING_BATCH);
    var body = await apiFetch("api/blobs/missing", { method: "POST", body: { shas: chunk } });
    uniqueShas(body && body.missing).forEach(function (sha) {
      if (chunk.indexOf(sha) !== -1 && out.indexOf(sha) === -1) out.push(sha);
    });
  }
  return out;
}

async function uploadBlobs(shas, known) {
  var list = uniqueShas(shas);
  if (!list.length) return [];
  var need = known ? list : await blobsMissingOnServer(list);
  if (!need.length) return [];
  var absent = await ensureBytes(need, { remote: false });
  for (var i = 0; i < need.length; i++) {
    var sha = need[i];
    if (absent.indexOf(sha) !== -1) continue;
    var bytes = bytesForSync(sha);
    var rec = blobRecordFor(sha);
    if (!bytes || !rec) { absent.push(sha); continue; }
    await apiFetch("api/blobs/" + sha, { method: "PUT", raw: bytes, contentType: rec.mime });
  }
  return absent;
}

async function inlineBlobsForServer(state, refs) {
  if (!refs.length) return state;
  await ensureBytes(refs);
  var out = cloneState(state);
  inlineStateImages(out);
  return out;
}

async function sendWithBlobs(state, send, canAccept) {
  var refs = refsIn(state);
  if (!serverTakesBlobs()) return send(await inlineBlobsForServer(state, refs), []);
  if (refs.length) await uploadBlobs(refs, false);
  try {
    return await send(state, []);
  } catch (err) {
    if (!(err && err.code === "missing-blobs")) throw err;
    var absent = await uploadBlobs(err.payload && err.payload.missing, true);
    if (absent.length && !canAccept) throw err;
    return send(state, absent);
  }
}

export async function fetchBlob(sha) {
  if (!isSha256Hex(sha) || !serverTakesBlobs()) return null;
  var res;
  try {
    res = await fetch(apiUrl("api/blobs/" + sha), {
      method: "GET",
      headers: clientHeaders({ "Accept": "image/*" }),
      credentials: conn.serverUrl ? "omit" : "same-origin"
    });
  } catch (e) { return null; }
  if (!res.ok || res.redirected) return null;
  var bytes;
  try { bytes = new Uint8Array(await res.arrayBuffer()); } catch (e) { return null; }
  var rec = internBlob(bytes);
  if (!rec || rec.sha256 !== sha) {
    if (window.console) console.warn("Image from the server refused: it is not the image " + sha);
    return null;
  }
  return bytesForSync(sha);
}

function reportLateServerSave() {
  showToast("An earlier save of this script arrived late. Your next save will merge both versions.", "warn");
}

export async function saveToServer() {
  if (serverSessionExpired || clientTooOld || linkTurnedOff) return false;
  if (reviewMode()) return sendReviewWrites();
  var docId = serverHomeId();
  var attempts = 0;
  var mergeResult = null;

  while (attempts < 3) {
    attempts++;
    if (serverHomeId() !== docId) return false;
    S.state.lastEditedBy = getEditorName();
    S.state.lastEditedAt = nowIso();
    var published = cloneState(S.state);
    var seqAtSave = S.editSeq;
    var baseRevAtSave = home.rev;
    var homeAtSave = home;

    try {
      var body = await withBusyBar("Saving to the server…", function () {
        return sendWithBlobs(published, function (sending, acceptMissing) {
          var put = { baseRev: baseRevAtSave, state: sending, by: getEditorName() };
          if (acceptMissing.length) put.acceptMissing = acceptMissing;
          return apiFetch("api/docs/" + encodeURIComponent(docId), { method: "PUT", body: put });
        }, true);
      });
      if (serverHomeId() !== docId) return true;
      if (home !== homeAtSave) {
        if (home.rev < body.rev) reportLateServerSave();
        return true;
      }
      home.rev = body.rev;
      setBaseState(published, "saveToServer: what the server just accepted");
      if (S.editSeq === seqAtSave) clearDirty();
      updateFileChip();
      if (mergeResult) reportMerge(mergeResult, { alreadySaved: true, undo: "saved" });
      return true;
    } catch (err) {
      if (serverHomeId() !== docId) return false;

      if (err && err.code === "conflict" && err.payload && isDocumentObject(err.payload.state)) {
        var prevDocId = S.state.docId;
        forgetRemoteMisses();
        var theirs = migrateDocument(cloneState(err.payload.state), {
          kind: "server",
          serverId: docId,
          fallbackId: S.state.docId
        });
        mergeResult = applyMerge({
          base: S.baseState,
          mine: S.state,
          theirs: theirs,
          source: "server-conflict",
          undoPoint: mergeResult ? null : cloneState(S.state),
          historyFrom: prevDocId,
          report: false
        }).result;
        home.rev = err.payload.rev || home.rev;
        continue;
      }

      if (err && err.code === "not-found") {
        showToast("That document is no longer on the server. Use “Put this script on the server” to publish it again.", "warn");
        setHome("none");
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

var reviewWriting = false;

var reviewRefused = {};

function commentIndexIn(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return i;
  return -1;
}

function rowIn(state, id) {
  var rows = (state && state.rows) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === id) return rows[i];
  return null;
}

function jsonCopy(v) { return JSON.parse(JSON.stringify(v)); }

function nextReviewWrite() {
  var base = (S.baseState && S.baseState.comments) || [];
  var list = (S.state && S.state.comments) || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!c || c.kind === "conflict") continue;
    var bi = commentIndexIn(base, c.id);
    if (bi === -1) {
      if (!reviewRefused["c:" + c.id]) return { kind: "comment", id: c.id, key: "c:" + c.id };
      continue;
    }
    var was = base[bi];
    var had = idMap();
    (was.replies || []).forEach(function (r) { if (r) had[r.id] = true; });
    var replies = c.replies || [];
    for (var j = 0; j < replies.length; j++) {
      var r = replies[j];
      var rkey = "r:" + c.id + ":" + (r && r.id);
      if (r && !had[r.id] && !reviewRefused[rkey]) return { kind: "reply", id: c.id, replyId: r.id, key: rkey };
    }
  }
  return null;
}

function dropLocalResolves() {
  var base = (S.baseState && S.baseState.comments) || [];
  var changed = false;
  ((S.state && S.state.comments) || []).forEach(function (c) {
    if (!c || c.kind === "conflict") return;
    var bi = commentIndexIn(base, c.id);
    var was = bi === -1 ? null : base[bi];
    var wasResolved = !!(was && was.resolved);
    if (!!c.resolved === wasResolved) return;
    c.resolved = wasResolved;
    c.resolvedBy = was ? (was.resolvedBy || null) : null;
    c.resolvedAt = was ? (was.resolvedAt || null) : null;
    changed = true;
  });
  return changed;
}

function reviewAnchorFor(c) {
  if (c.field !== "visualText" && c.field !== "audioText") return null;
  var row = rowIn(S.state, c.rowId);
  var baseRow = rowIn(S.baseState, c.rowId);
  if (!row || !baseRow) return null;
  var body = inertBody(row[c.field] || "");
  if (!body.querySelector('.cmt-anchor[data-cmt="' + cssAttr(c.id) + '"]')) return null;
  var confirmed = idMap();
  inertBody(baseRow[c.field] || "").querySelectorAll(".cmt-anchor").forEach(function (el) {
    confirmed[el.getAttribute("data-cmt")] = true;
  });
  confirmed[c.id] = true;
  body.querySelectorAll(".cmt-anchor").forEach(function (el) {
    if (!confirmed[el.getAttribute("data-cmt")]) unwrapElement(el);
  });
  return { rowId: c.rowId, field: c.field, html: body.innerHTML };
}

function unwrapElement(el) {
  while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
  el.parentNode.removeChild(el);
}

function dropLocalAnchor(c) {
  var row = rowIn(S.state, c.rowId);
  if (!row || (c.field !== "visualText" && c.field !== "audioText")) return false;
  var body = inertBody(row[c.field] || "");
  var span = body.querySelector('.cmt-anchor[data-cmt="' + cssAttr(c.id) + '"]');
  if (!span) return false;
  unwrapElement(span);
  row[c.field] = body.innerHTML;
  var baseRow = rowIn(S.baseState, c.rowId);
  if (baseRow && baseRow[c.field] === row[c.field]) {
    row.updatedAt = baseRow.updatedAt;
    row.updatedBy = baseRow.updatedBy;
  }
  return true;
}

function reviewRequest(op, c) {
  var path = "api/docs/" + encodeURIComponent(home.id) + "/comments";
  var by = getEditorName();
  if (op.kind === "reply") {
    var reply = null;
    (c.replies || []).forEach(function (r) { if (r && r.id === op.replyId) reply = r; });
    return {
      path: path,
      method: "POST",
      body: { replyTo: c.id, reply: { id: reply.id, author: reply.author, body: reply.body }, by: by },
      busy: "Posting your reply…"
    };
  }
  var payload = {
    comment: {
      id: c.id, rowId: c.rowId, field: c.field, anchorId: c.anchorId,
      quotedText: c.quotedText, author: c.author, body: c.body,
      assignee: c.assignee || "", kind: c.kind
    },
    by: by
  };
  var anchor = reviewAnchorFor(c);
  if (anchor) payload.anchor = anchor;
  return { path: path, method: "POST", body: payload, busy: "Posting your comment…" };
}

function sendReviewRequest(req) {
  var isReply = !!req.body.reply;
  var probe = { comments: [{ body: isReply ? req.body.reply.body : req.body.comment.body }] };
  return sendWithBlobs(probe, function (sending) {
    var body = req.body;
    if (sending !== probe) {
      body = jsonCopy(req.body);
      if (isReply) body.reply.body = sending.comments[0].body;
      else body.comment.body = sending.comments[0].body;
    }
    return apiFetch(req.path, { method: req.method, body: body });
  }, false);
}

function adoptReviewAnswer(op, sent, body) {
  var stored = body.comment;
  var baseList = S.baseState.comments || (S.baseState.comments = []);
  var bi = commentIndexIn(baseList, stored.id);
  if (bi === -1) baseList.push(jsonCopy(stored));
  else baseList[bi] = jsonCopy(stored);

  var list = S.state.comments;
  var si = commentIndexIn(list, stored.id);
  var local = si === -1 ? null : list[si];
  if (local) {
    var next = jsonCopy(stored);
    if (!Array.isArray(next.replies)) next.replies = [];
    var have = idMap();
    next.replies.forEach(function (r) { if (r) have[r.id] = true; });
    (local.replies || []).forEach(function (r) { if (r && !have[r.id]) next.replies.push(r); });
    list[si] = next;
  }

  var redraw = false;
  if (op.kind === "comment" && sent.anchor) {
    if (body.anchored === true) {
      var baseRow = rowIn(S.baseState, sent.anchor.rowId);
      if (baseRow) {
        baseRow[sent.anchor.field] = sent.anchor.html;
        baseRow.updatedAt = body.updatedAt;
        baseRow.updatedBy = stored.author;
      }
      var row = rowIn(S.state, sent.anchor.rowId);
      if (row) {
        row.updatedAt = body.updatedAt;
        row.updatedBy = stored.author;
      }
    } else if (local) {
      redraw = dropLocalAnchor(local);
    }
  }

  if (typeof body.rev === "number" && body.rev === (home.rev || 0) + (body.changed ? 1 : 0)) {
    home.rev = body.rev;
  }
  return redraw;
}

var REVIEW_REFUSALS = {
  "too-many-comments": "this script already holds as many comments as it can",
  "too-many-replies": "that thread already holds as many replies as it can",
  "no-such-comment": "the comment it belongs to has been deleted",
  "too-large": "it is too large to send",
  "bad-comment": "the server could not read it as a comment",
  "bad-anchor": "the server could not read where it goes",
  "bad-comment-id": "the server could not read it as a comment",
  "no-state": "the document on the server is empty",
  "missing-blobs": "an image in it is no longer on this device or on the server",
  "blob-too-large": "an image in it is larger than the server takes (8 MB)",
  "blob-unsupported": "an image in it is not a PNG, JPEG, GIF or WebP"
};

function permanentReviewRefusal(err) {
  if (!err) return "";
  if (err.code === "missing-blobs" || err.code === "blob-too-large" || err.code === "blob-unsupported") {
    return REVIEW_REFUSALS[err.code];
  }
  var reason = err.code === "conflict" ? (err.payload && err.payload.error) : err.message;
  if (err.code === "conflict" || err.code === "400" || err.code === "413" ||
      (err.code === "404" && reason === "no-such-comment")) {
    return REVIEW_REFUSALS[reason] || reason || "the server refused it";
  }
  return "";
}

async function sendReviewWrites() {
  var docId = serverHomeId();
  if (!S.baseState) return false;
  var redraw = dropLocalResolves();
  var sentAny = false;
  var sentKeys = {};
  reviewWriting = true;
  try {
    for (;;) {
      if (serverHomeId() !== docId) return false;
      var op = nextReviewWrite();
      if (!op) break;
      if (sentKeys[op.key]) { reviewRefused[op.key] = true; continue; }
      sentKeys[op.key] = true;
      var c = S.state.comments[commentIndexIn(S.state.comments, op.id)];
      var req = reviewRequest(op, c);
      var body;
      try {
        body = await withBusyBar(req.busy, function () { return sendReviewRequest(req); });
      } catch (err) {
        if (serverHomeId() !== docId) return false;
        var why = permanentReviewRefusal(err);
        if (why) {
          reviewRefused[op.key] = true;
          showToast((op.kind === "reply" ? "Your reply could not be posted" :
                     "Your comment could not be posted") +
                    " — " + why + ". It stays on this screen only, so copy anything you need.",
                    "warn", true);
          continue;
        }
        if (err && err.code === "405") {
          showToast("This server is older than this copy of Splitpage and cannot take a " +
                    "comment from a review link. Ask whoever is hosting to update it.", "warn", true);
          return false;
        }
        handleApiError(err, op.kind === "reply" ? "Could not post your reply" :
                            "Could not post your comment");
        return false;
      }
      if (serverHomeId() !== docId) return true;
      if (!body || !body.comment) return false;
      if (adoptReviewAnswer(op, req.body, body)) redraw = true;
      sentAny = true;
    }
  } finally {
    reviewWriting = false;
  }
  if (redraw) render();
  else if (sentAny) { captureReplyDrafts(); renderComments(); }
  var refusedHere = false;
  (S.state.comments || []).forEach(function (c) {
    if (!c) return;
    if (reviewRefused["c:" + c.id]) refusedHere = true;
    (c.replies || []).forEach(function (r) { if (r && reviewRefused["r:" + c.id + ":" + r.id]) refusedHere = true; });
  });
  if (!refusedHere) clearDirty();
  updateFileChip();
  return true;
}

var pullInFlight = false;

function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(function (k) {
    return v[k] !== undefined;
  }).map(function (k) {
    return JSON.stringify(k) + ":" + canonicalJson(v[k]);
  }).join(",") + "}";
}

function sameDocumentContent(a, b) {
  if (!a || !b) return false;
  function bare(s) {
    var copy = cloneState(s);
    copy.rev = 0;
    copy.lastEditedBy = "";
    copy.lastEditedAt = "";
    return canonicalJson(copy);
  }
  return bare(a) === bare(b);
}

export function notePresenceRev(body) {
  if (!body || pullInFlight || serverSessionExpired || linkTurnedOff || reviewWriting) return;
  var docId = serverHomeId();
  if (!docId || body.docId !== docId) return;
  if (typeof body.rev !== "number") return;
  if (body.rev <= (home.rev || 0)) return;
  if (S.saveButtonBusy) return;
  pullInFlight = true;
  pullServerDoc(docId).catch(function () {}).then(function () { pullInFlight = false; });
}

async function pullServerDoc(docId) {
  var body;
  try {
    body = await apiFetch("api/docs/" + encodeURIComponent(docId));
  } catch (err) {
    return;
  }
  if (!body || !isDocumentObject(body.state)) return;
  if (serverHomeId() !== docId) return;
  if (S.saveButtonBusy || reviewWriting) return;
  var rev = body.rev || 0;
  if (rev <= (home.rev || 0)) return;
  forgetRemoteMisses();

  var theirs = migrateDocument(cloneState(body.state), {
    kind: "server",
    serverId: docId,
    fallbackId: S.state.docId
  });

  home.rev = rev;
  if (sameDocumentContent(theirs, S.baseState)) {
    setBaseState(cloneState(theirs), "pullServerDoc: their save says what ours already said");
    updateFileChip();
    return;
  }

  var prevDocId = S.state.docId;
  var merged = applyMerge({
    base: S.baseState,
    mine: S.state,
    theirs: theirs,
    historyFrom: prevDocId,
    newBase: cloneState(theirs),
    chips: true,
    report: false
  });
  if (merged.result) reportMerge(merged.result, { alreadySaved: true, undo: false });
  showToast("Merged in changes from " + (body.updatedBy || "someone else"), "ok");
}

function readLaunchToken() {
  try { launchToken = sessionStorage.getItem(LAUNCH_TOKEN_KEY) || ""; } catch (e) { launchToken = ""; }
  var hash = location.hash || "";
  var m = /(?:^#|&)launch=([A-Za-z0-9]+)/.exec(hash);
  if (!m) return;
  launchToken = m[1];
  try { sessionStorage.setItem(LAUNCH_TOKEN_KEY, launchToken); } catch (e) {}
  var rest = hash.replace(/(^#|&)launch=[A-Za-z0-9]+/, "$1").replace(/^#&/, "#");
  if (rest === "#") rest = "";
  try {
    history.replaceState(null, "", location.pathname + location.search + rest);
  } catch (e) { }
}


export async function launcherFetch(path, opts) {
  opts = opts || {};
  if (!launchToken) throw ApiError("no-launcher", "this copy was not started by the launcher");
  var headers = { "Accept": "application/json", "x-splitpage-launch": launchToken };
  headers[CLIENT_HEADER] = CLIENT_GENERATION;
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

/* global google -- injected at runtime by Google Identity Services; see above */

var DRIVE_KEY_STORE = "splitpage-drive-api-key";
var DRIVE_CLIENT_STORE = "splitpage-drive-client-id";
var DRIVE_FOLDER_STORE = "splitpage-drive-last-folder";
var DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

var driveCreds = { apiKey: "", clientId: "" };
var driveState = {
  connected: false,
  path: [],
  items: [],
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
  } catch (e) { }
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
  } catch (e) { }
}

var driveDesktopStatus = null;

function driveDesktopBridge() {
  return !!(S.DESKTOP && typeof S.DESKTOP.driveStatus === "function");
}

var DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
var DRIVE_DOC_MIME = "application/vnd.google-apps.document";
var DRIVE_ENV_VARS_FALLBACK = ["SPLITPAGE_GOOGLE_CLIENT_ID", "SPLITPAGE_GOOGLE_CLIENT_SECRET"];

function applyDriveChrome(desktop) {
  document.getElementById("drive-web-hint").hidden = desktop;
  document.getElementById("drive-desktop-hint").hidden = !desktop;
  document.getElementById("drive-desktop-setup").hidden = true;
  if (desktop) document.getElementById("drive-setup").hidden = true;
  var edit = document.querySelector("#drive-modal .drive-edit-creds");
  if (edit) edit.hidden = desktop;
  var nf = document.getElementById("drive-newfolder-toggle");
  if (nf) nf.hidden = desktop;
  var row = document.querySelector("#drive-modal .drive-connect-row");
  if (row) row.hidden = false;
  document.getElementById("drive-folder-input").placeholder = desktop
    ? "Paste a Drive folder link or ID — or leave empty for My Drive"
    : "Paste a Drive folder link or ID…";
}

function driveDesktopMessage(res) {
  var code = res && res.code;
  if (code === "SIGNED_OUT") return "Google no longer accepts this sign-in — sign in again.";
  if (code === "NOT_CONFIGURED") return "no Google client is set up on this computer.";
  if (code === "NETWORK") return "couldn't reach Google. Check your connection.";
  if (code === "NOT_FOUND") return "it isn't there, or this Google account can't see it.";
  if (code === "FORBIDDEN") return "this Google account doesn't have permission.";
  if (code === "TOO_LARGE") return "it's larger than 64 MB.";
  if (code === "UNSUPPORTED") return "Google Sheets, Slides and forms can't be downloaded here — open them in Drive.";
  if (code === "NOT_A_FOLDER") return "that's a file, not a folder.";
  if (code === "IS_A_FOLDER") return "that's a folder.";
  if (code === "BAD_ARGS") return "Splitpage refused the request.";
  return "something went wrong" + (code ? " (" + code + ")" : "") + ".";
}

async function driveDesktopCall(method, arg) {
  try {
    var res = await (arguments.length > 1 ? S.DESKTOP[method](arg) : S.DESKTOP[method]());
    return res || { ok: false, code: "FAILED" };
  } catch (e) {
    return { ok: false, code: "FAILED" };
  }
}

async function driveDesktopSignedOut(res) {
  if (!res || res.code !== "SIGNED_OUT") return false;
  driveResetBrowse();
  await refreshDriveDesktop();
  return true;
}

function driveResetBrowse() {
  driveState.connected = false;
  driveState.path = [];
  driveState.items = [];
  driveEditingId = null;
}

async function refreshDriveDesktop() {
  var st = await driveDesktopCall("driveStatus");
  driveDesktopStatus = st;
  renderDriveDesktop();
  if (st.ok && st.configured && st.signedIn && !driveState.connected) await driveConnect("");
}

function renderDriveDesktop() {
  var st = driveDesktopStatus || {};
  var configured = !!(st.ok && st.configured);
  document.getElementById("drive-desktop-setup").hidden = configured;
  document.getElementById("drive-main").hidden = !configured;
  if (!configured) {
    document.getElementById("drive-desktop-client-path").textContent =
      st.clientFilePath || "google-oauth-client.json, in Splitpage's settings folder";
    document.getElementById("drive-desktop-env-vars").textContent =
      (Array.isArray(st.envVars) && st.envVars.length ? st.envVars : DRIVE_ENV_VARS_FALLBACK).join(" and ");
    return;
  }
  driveState.signedIn = !!st.signedIn;
  if (!driveState.signedIn) driveResetBrowse();
  var row = document.querySelector("#drive-modal .drive-connect-row");
  if (row) row.hidden = !driveState.signedIn;
  document.getElementById("drive-browser").hidden = !(driveState.signedIn && driveState.connected);
  renderDriveAccount();
}

function renderDriveAccountDesktop(el) {
  var st = driveDesktopStatus || {};
  if (st.signingIn) {
    el.innerHTML = '<span class="drive-account-status">Finish signing in in your browser, then come back here.</span>' +
      '<button type="button" class="btn" disabled>Waiting for Google…</button>';
  } else if (driveState.signedIn) {
    var who = st.email ? "Signed in as " + escapeHtml(st.email) : "Signed in";
    var session = st.persisted ? "" : " — for this session only: this computer has no secure storage to keep the sign-in.";
    el.innerHTML = '<span class="drive-account-status">' + spriteIcon("i-check") + who + escapeHtml(session) + '</span>' +
      '<button type="button" class="btn" data-action="drive-signout">Sign out</button>';
  } else {
    el.innerHTML = '<span class="drive-account-status">Sign in to browse your Google Drive. Google opens in your browser.</span>' +
      '<button type="button" class="btn btn-accent" data-action="drive-signin">Sign in with Google</button>';
  }
  updateDriveWriteButtons();
}

async function driveSignInDesktop() {
  if (driveDesktopStatus && driveDesktopStatus.signingIn) return;
  driveDesktopStatus = Object.assign({}, driveDesktopStatus, { signingIn: true });
  renderDriveAccount();
  var res = await driveDesktopCall("driveSignIn");
  if (res.ok) {
    driveDesktopStatus = res;
    driveResetBrowse();
    renderDriveDesktop();
    showToast("Signed in to Google Drive" + (res.email ? " as " + res.email : "") + ".", "ok");
    await driveConnect("");
    return;
  }
  var code = res.code;
  var msg = code === "DENIED" ? "Google sign-in was cancelled."
    : code === "TIMEOUT" ? "Sign-in timed out — nothing came back from your browser within 5 minutes. Try again."
    : code === "STATE_MISMATCH" ? "The reply from Google didn't match this sign-in, so it was refused. Try again."
    : code === "NO_REFRESH_TOKEN" ? "Google didn't grant lasting access. Try again, and allow access when Google asks."
    : code === "NO_BROWSER" ? "Could not open your browser for Google sign-in."
    : code === "CANCELLED" ? "Sign-in was cancelled."
    : code === "NOT_CONFIGURED" ? "No Google client is set up on this computer yet."
    : "Could not finish signing in to Google Drive" + (code ? " (" + code + ")" : "") + ".";
  showToast(msg, code === "DENIED" || code === "CANCELLED" ? "warn" : "error");
  await refreshDriveDesktop();
}

async function driveSignOutDesktop() {
  var res = await driveDesktopCall("driveSignOut");
  driveResetBrowse();
  driveDesktopStatus = res && res.status ? Object.assign({ ok: true }, res.status) : await driveDesktopCall("driveStatus");
  renderDriveDesktop();
  showToast("Signed out of Google Drive.", "ok");
}

async function driveConnectDesktop(rawInput) {
  var raw = (rawInput || "").trim();
  var id = raw ? parseDriveFolderId(raw) : "root";
  if (!id) { showToast("That doesn't look like a Drive folder link or ID.", "warn"); return; }
  var btn = document.getElementById("drive-connect-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
  try {
    var res = await driveDesktopCall("driveList", id);
    if (!res.ok) {
      if (await driveDesktopSignedOut(res)) return;
      showToast("Could not open that folder — " + driveDesktopMessage(res), res.code === "NOT_A_FOLDER" ? "warn" : "error");
      return;
    }
    driveState.connected = true;
    driveState.path = [id === "root"
      ? { id: "root", name: "My Drive" }
      : { id: (res.folder && res.folder.id) || id, name: (res.folder && res.folder.name) || "Drive folder" }];
    driveState.items = Array.isArray(res.files) ? res.files : [];
    driveEditingId = null;
    document.getElementById("drive-browser").hidden = false;
    renderDriveBreadcrumb();
    renderDriveList();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Open folder"; }
  }
}

async function driveListCurrentDesktop() {
  var folder = driveState.path[driveState.path.length - 1];
  if (!folder) return;
  var list = document.getElementById("drive-list");
  list.innerHTML = '<div class="drive-empty">Loading…</div>';
  var res = await driveDesktopCall("driveList", folder.id);
  if (!res.ok) {
    if (await driveDesktopSignedOut(res)) return;
    list.innerHTML = '<div class="drive-empty">Could not load this folder — ' + escapeHtml(driveDesktopMessage(res)) + '</div>';
    return;
  }
  driveState.items = Array.isArray(res.files) ? res.files : [];
  renderDriveBreadcrumb();
  renderDriveList();
}

async function driveDownloadDesktop(it) {
  if (it.mimeType !== DRIVE_DOC_MIME && /^application\/vnd\.google-apps\./.test(it.mimeType)) {
    S.DESKTOP.openExternal("https://drive.google.com/open?id=" + encodeURIComponent(it.id));
    return;
  }
  var res = await driveDesktopCall("driveDownload", it.id);
  if (!res.ok) {
    if (await driveDesktopSignedOut(res)) return;
    showToast("Could not download " + it.name + " — " + driveDesktopMessage(res), "error");
    return;
  }
  var filename = it.name;
  if (it.mimeType === DRIVE_DOC_MIME && !/\.[a-z0-9]+$/i.test(filename)) filename += ".txt";
  await deliverFile(filename, res.bytes);
}

async function driveUploadOneDesktop(file, parentId) {
  var bytes = new Uint8Array(await file.arrayBuffer());
  var same = driveState.items.filter(function (it) {
    return it.name === file.name && it.mimeType !== DRIVE_FOLDER_MIME && !/^application\/vnd\.google-apps\./.test(it.mimeType);
  });
  var req = same.length === 1 ? { fileId: same[0].id, bytes: bytes } : { parentId: parentId, name: file.name, bytes: bytes };
  if (file.type) req.mimeType = file.type;
  var res = await driveDesktopCall("driveUpload", req);
  if (!res.ok) {
    var err = new Error(driveDesktopMessage(res));
    err.driveResult = res;
    throw err;
  }
  return same.length === 1 ? "updated" : "created";
}

export function openDriveModal() {
  if (S.DESKTOP) {
    if (!driveDesktopBridge()) {
      showToast("Google Drive isn't available in this version of the desktop app. Use File ▸ Open… instead.", "warn");
      return;
    }
    document.getElementById("drive-modal").hidden = false;
    document.getElementById("drive-folder-input").value = "";
    applyDriveChrome(true);
    document.getElementById("drive-main").hidden = true;
    refreshDriveDesktop();
    return;
  }
  applyDriveChrome(false);
  loadDriveCreds();
  document.getElementById("drive-modal").hidden = false;
  document.getElementById("drive-folder-input").value = driveLastFolder();
  renderDriveSetup();
}

export function closeDriveModal() {
  document.getElementById("drive-modal").hidden = true;
}

export function driveShowCredsForm() {
  if (S.DESKTOP) return;
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

export function driveSaveCredsFromForm() {
  var apiKey = document.getElementById("drive-api-key").value;
  var clientId = document.getElementById("drive-client-id").value;
  if (!apiKey.trim() || !clientId.trim()) { showToast("Both fields are needed.", "warn"); return; }
  saveDriveCreds(apiKey, clientId);
  renderDriveSetup();
  showToast("Saved — now paste a folder link below.", "ok");
}

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
  if (S.DESKTOP) throw new Error("not available in the desktop app");
  opts = opts || {};
  var headers = opts.headers || {};
  if (driveState.accessToken && driveState.tokenExpiresAt > Date.now()) {
    headers = Object.assign({}, headers, { "Authorization": "Bearer " + driveState.accessToken });
  }
  var res = await fetch(url, { method: opts.method || "GET", headers: headers, body: opts.body });
  if (!res.ok) {
    var msg = res.status === 401 || res.status === 403
      ? "Google refused access — sign in to Google Drive again"
      : res.status === 404 ? "Google Drive could not find it"
      : res.status === 429 ? "Google Drive is busy — wait a moment, then try again"
      : "Google Drive answered with an error (" + res.status + ")";
    try {
      var body = await res.json();
      if (body && body.error && body.error.message) msg = body.error.message;
    } catch (e) {}
    throw new Error(msg);
  }
  return res;
}

export async function driveConnect(rawInput) {
  if (driveDesktopBridge()) return driveConnectDesktop(rawInput);
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
    showToast("Could not open that folder — " + plainReason(err), "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Open folder"; }
  }
}

export async function driveListCurrent() {
  if (driveDesktopBridge()) return driveListCurrentDesktop();
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
    list.innerHTML = '<div class="drive-empty">Could not load this folder — ' + escapeHtml(plainReason(err)) + '</div>';
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

export function driveCrumbTo(index) {
  driveState.path = driveState.path.slice(0, index + 1);
  driveEditingId = null;
  driveListCurrent();
}

export function driveItemById(id) {
  var found = driveState.items.filter(function (it) { return it.id === id; });
  return found[0] || null;
}

function spriteIcon(id) {
  return '<svg class="row-icon-svg" aria-hidden="true" focusable="false"><use href="#' + id + '"/></svg>';
}

function driveIconFor(mimeType) {
  if (mimeType === "application/vnd.google-apps.folder") return spriteIcon("i-folder");
  if (/^image\//.test(mimeType)) return spriteIcon("i-image");
  if (/^video\//.test(mimeType)) return spriteIcon("i-camera");
  if (/^audio\//.test(mimeType)) return spriteIcon("i-mic");
  return spriteIcon("i-file");
}

export function driveFormatSize(bytes) {
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
  var canWrite = driveState.signedIn && !driveDesktopBridge();
  list.innerHTML = driveState.items.map(function (it) {
    var isFolder = it.mimeType === "application/vnd.google-apps.folder";
    if (driveEditingId === it.id) {
      return '<div class="drive-row is-editing" data-id="' + escapeHtml(it.id) + '">' +
        '<span class="drive-row-icon">' + driveIconFor(it.mimeType) + '</span>' +
        '<input type="text" class="drive-rename-input" data-id="' + escapeHtml(it.id) +
          '" value="' + escapeHtml(it.name) + '">' +
        '<button type="button" class="drive-row-btn" data-action="drive-rename-save" data-id="' +
          escapeHtml(it.id) + '" title="Save" aria-label="Save">' + spriteIcon("i-check") + '</button>' +
        '<button type="button" class="drive-row-btn" data-action="drive-rename-cancel" title="Cancel" aria-label="Cancel">' +
          spriteIcon("i-close") + '</button>' +
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
          escapeHtml(it.id) + '" title="Rename" aria-label="Rename">' + spriteIcon("i-pen") + '</button>' : '') +
        (canWrite ? '<button type="button" class="drive-row-btn danger" data-action="drive-delete" data-id="' +
          escapeHtml(it.id) + '" title="Delete" aria-label="Delete">' + spriteIcon("i-trash") + '</button>' : '') +
      '</div>' +
    '</div>';
  }).join("");
}

export async function driveOpenItem(id) {
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
  if (driveDesktopBridge()) return driveDownloadDesktop(it);
  var exportInfo = DRIVE_EXPORT_MIME[it.mimeType];
  var url, filename = it.name;
  if (exportInfo) {
    url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(it.id) +
      "/export?mimeType=" + encodeURIComponent(exportInfo.mime) + "&" + driveApiKeyParam();
    if (!/\.[a-z0-9]+$/i.test(filename)) filename += exportInfo.ext;
  } else if (/^application\/vnd\.google-apps\./.test(it.mimeType)) {
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
    showToast("Could not download " + it.name + " — " + plainReason(err), "error");
  }
}

export function driveStartRename(id) {
  driveEditingId = id;
  renderDriveList();
  var input = document.querySelector('.drive-rename-input[data-id="' + id + '"]');
  if (input) { input.focus(); input.select(); }
}

export function driveCancelRename() {
  driveEditingId = null;
  renderDriveList();
}

export async function driveSaveRename(id) {
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
    showToast("Could not rename — " + plainReason(err), "error");
  }
  await driveListCurrent();
}

export async function armDriveDelete(btn, item) {
  if (btn.getAttribute("data-armed") === "1") {
    try {
      await driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(item.id), { method: "DELETE" });
    } catch (err) {
      showToast("Could not delete “" + item.name + "” — " + plainReason(err), "error");
      return;
    }
    showToast("Deleted “" + item.name + "”", "ok");
    await driveListCurrent();
    return;
  }
  var label = btn.getAttribute("aria-label");
  btn.setAttribute("data-armed", "1");
  btn.textContent = "Delete?";
  btn.setAttribute("aria-label", "Delete? Click again to confirm");
  btn.classList.add("armed");
  setTimeout(function () {
    if (!btn.isConnected) return;
    btn.removeAttribute("data-armed");
    btn.innerHTML = spriteIcon("i-trash");
    if (label) btn.setAttribute("aria-label", label);
    btn.classList.remove("armed");
  }, 2800);
}

var driveNewFolderOpen = false;

export function toggleDriveNewFolder(force) {
  driveNewFolderOpen = force === undefined ? !driveNewFolderOpen : force;
  var row = document.getElementById("drive-newfolder-row");
  row.hidden = !driveNewFolderOpen;
  var input = document.getElementById("drive-newfolder-input");
  if (driveNewFolderOpen) { input.value = ""; input.focus(); }
}

export async function driveCreateFolder() {
  if (driveDesktopBridge()) { toggleDriveNewFolder(false); return; }
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
    showToast("Could not create the folder — " + plainReason(err), "error");
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

export async function driveUploadFiles(fileList) {
  if (!driveState.signedIn) { showToast("Sign in with Google first.", "warn"); return; }
  var parent = driveState.path[driveState.path.length - 1];
  var files = Array.prototype.slice.call(fileList || []);
  if (!files.length || !parent) return;
  var desktop = driveDesktopBridge();
  var failed = 0, updated = 0;
  for (var i = 0; i < files.length; i++) {
    try {
      if (desktop) { if (await driveUploadOneDesktop(files[i], parent.id) === "updated") updated++; }
      else await driveUploadOne(files[i], parent.id);
    } catch (err) {
      failed++;
      if (desktop && await driveDesktopSignedOut(err.driveResult)) return;
      showToast("Could not upload " + files[i].name + " — " + plainReason(err), "error");
    }
  }
  var created = files.length - failed - updated;
  if (created > 0) showToast("Uploaded " + created + " file" + (created === 1 ? "" : "s"), "ok");
  if (updated > 0) showToast("Replaced " + updated + " file" + (updated === 1 ? "" : "s") + " of the same name with a new version", "ok");
  await driveListCurrent();
}

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
  if (driveDesktopBridge()) { renderDriveAccountDesktop(el); return; }
  el.innerHTML = driveState.signedIn
    ? '<span class="drive-account-status">' + spriteIcon("i-check") + 'Signed in — you can make changes here.</span>' +
      '<button type="button" class="btn" data-action="drive-signout">Sign out</button>'
    : '<span class="drive-account-status">Read-only until you sign in.</span>' +
      '<button type="button" class="btn btn-accent" data-action="drive-signin">Sign in with Google</button>';
  updateDriveWriteButtons();
}

function updateDriveWriteButtons() {
  var disabled = !driveState.signedIn;
  var reason = disabled ? "Sign in with Google first" : "";
  var nf = document.getElementById("drive-newfolder-toggle");
  if (nf) { nf.disabled = disabled; nf.title = reason; }
  var up = document.querySelector('#drive-browser [data-action="drive-upload"]');
  if (up) { up.disabled = disabled; up.title = reason; }
}

export async function driveSignIn() {
  if (driveDesktopBridge()) return driveSignInDesktop();
  if (!driveCreds.clientId) { showToast("Add your OAuth Client ID first.", "warn"); return; }
  if (location.protocol === "file:") {
    showToast("Sign-in needs this page served over http/https, not opened from disk.", "warn");
    return;
  }
  try { await loadGisScript(); } catch (err) { showToast("Could not start Google sign-in — " + plainReason(err) + ".", "error"); return; }
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

export function driveSignOut() {
  if (driveDesktopBridge()) return driveSignOutDesktop();
  if (driveState.accessToken && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(driveState.accessToken, function () {});
  }
  driveState.accessToken = "";
  driveState.tokenExpiresAt = 0;
  driveState.signedIn = false;
  renderDriveAccount();
  renderDriveList();
}

export function __init() {
  loadTabConnection();

  setRemoteSource(function (sha) { return onServerDoc() ? fetchBlob(sha) : null; });

  readLinkKey();
  window.addEventListener("hashchange", function () {
    if (parseLinkFragment(location.hash || "")) location.reload();
  });

  sharedDocId = readSharedDocParam();

  window.__shareTest = {
    url: serverDocShareUrl,
    note: shareAccessNote,
    publishAndCopy: publishAndCopyShareLink,
    mode: function () { return S.serverMode; },
    updateMenu: updateServerMenu,
    sharedDocId: function () { return sharedDocId; },
    setIdentity: function (who) { serverIdentity = who; }
  };

  readLaunchToken();

  window.__hostedTest = {
    setSession: function (opts) {
      opts = opts || {};
      S.serverMode.available = true;
      S.serverMode.checked = true;
      S.serverMode.authRequired = true;
      S.serverMode.reviewAvailable = opts.reviewAvailable !== false;
      updateConnection({ role: opts.role || "edit", scope: opts.scope || "" });
      if (opts.docId === null) { if (home.kind === "server") setHome("none"); }
      else setHome("server", { id: opts.docId || "doc-test", rev: opts.rev || 1 });
      if (onServerDoc() && opts.base !== false) setBaseState(cloneState(S.state), "__hostedTest.setSession: as openServerDoc would");
      if (opts.blobs !== undefined) noteCaps(conn, { blobs: opts.blobs ? 1 : 0 }, false);
      applyReviewMode();
      updateServerMenu();
      render();
    },
    role: function () { return conn.role; },
    conn: function () {
      return { serverUrl: conn.serverUrl, hasToken: !!conn.token, role: conn.role, scope: conn.scope,
               tunnel: conn.tunnel ? Object.assign({}, conn.tunnel) : null,
               homeHoldsIt: home.kind === "server" && home.conn === conn };
    },
    link: function () {
      return { hasKey: !!linkKey, fresh: linkKeyFresh, turnedOff: linkTurnedOff,
               deviceServers: Object.keys(deviceLinkKeys()), docId: linkDocId,
               arriving: arrivingOnLink(), guest: isLinkGuest() };
    },
    serverMode: function () { return Object.assign({}, S.serverMode); },
    pointTabAt: function (url, opts) { if (home.kind === "server") setHome("none"); return pointTabAt(url, opts).serverUrl; },
    setToken: setServerToken,
    clearToken: clearServerToken,
    reviewMode: reviewMode,
    reviewLink: fetchReviewLink,
    home: function () { return Object.assign({}, home); },
    noteRev: notePresenceRev,
    base: function () { return S.baseState ? cloneState(S.baseState) : null; },
    dirty: function () { return !!S.dirty; },
    detect: detectServer,
    caps: function () { return Object.assign({}, capsOf(conn)); },
    fetchBlob: fetchBlob
  };
}
