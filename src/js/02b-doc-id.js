import { S } from "./_state.js";
import { home } from "./_home.js";
import { mintDocId, randomHexBytes } from "../adapters/identity/ids.ts";
import { deriveDocId, docIdEmbeddedIn, mergedDocId, sha256Bytes, sha256Hex, withPageHead } from "../core/document/ids.ts";
import { buildPublishHtml, migrateRows } from "./02-state.js";
import { inlineStateImages } from "./02c-blobs.js";
import { cloneState } from "./03-sync.js";
import { copyHistory, historyDocumentChanged } from "./03a-history-store.js";
import { plainText } from "./04-richtext.js";
import { showToast } from "./12-dirty-toast.js";
import { onServerDoc } from "./13-hosted.js";
import {
  decideDuplicateLoser,
  docIdFromSha256Hex,
  duplicateReplacementInput,
  normalizeDocId
} from "../../shared/doc-id-policy.js";
export { decideDuplicateLoser, normalizeDocId };
export { deriveDocId, docIdEmbeddedIn, mergedDocId, mintDocId, randomHexBytes, sha256Bytes, sha256Hex, withPageHead };

var PAGE_NONCE;

export function migrateDocument(raw, origin) {
  origin = origin || { kind: "fresh" };
  var embedded = docIdEmbeddedIn(raw);
  var seed = "";
  if (!embedded) {
    try { seed = String(JSON.stringify(raw)); } catch (e) { seed = ""; }
  }
  var s = migrateRows(raw);
  if (embedded) return s;
  if (origin.kind === "file") {
    s.docId = deriveDocId("splitpage-file", seed);
  } else if (origin.kind === "server") {
    var serverId = origin.serverId == null ? "" : String(origin.serverId);
    var fallback = normalizeDocId(origin.fallbackId);
    if (fallback) s.docId = fallback;
    else if (serverId) s.docId = deriveDocId("splitpage-server-doc", serverId);
  }
  return s;
}

export function noteMergedDocId(prevId) {
  prevId = normalizeDocId(prevId);
  if (!S.state || !prevId || prevId === S.state.docId) return;
  copyDocHistorySafe(prevId, S.state.docId);
  syncDocIdentity();
}

export function adoptRestoredState(snap) {
  var keep = normalizeDocId(S.state && S.state.docId);
  S.state = migrateRows(cloneState(snap));
  if (keep) S.state.docId = keep;
  return S.state;
}

S.docIdWrittenOut = false;
var identityAdoptedAt = 0;
var lastIdentityKey = "";
var docIdEventLog = [];
var docIdCopyWarned = false;

export function copyDocHistorySafe(from, to) {
  from = normalizeDocId(from);
  to = normalizeDocId(to);
  if (!from || !to || from === to) return;
  docIdEventLog.push({ type: "copy", from: from, to: to });
  if (docIdEventLog.length > 200) docIdEventLog.shift();
  if (typeof copyHistory !== "function") return;
  function warn() {
    if (docIdCopyWarned) return;
    docIdCopyWarned = true;
    try {
      showToast("Could not copy this document's version history to its new identity. " +
        "Earlier versions are still kept under the old one.", "warn");
    } catch (e) { }
  }
  try {
    var p = copyHistory(from, to);
    if (p && typeof p.then === "function") {
      p.then(function (r) { if (r && r.ok === false) warn(); }, warn);
    }
  } catch (e) { warn(); }
}

function docHomeKey() {
  if (home.kind === "server") return "server:" + home.id;
  if (home.kind === "file") {
    return "file:" + ((home.handle && home.handle.name) || home.name || "");
  }
  return "none:" + PAGE_NONCE;
}

export function syncDocIdentity() {
  if (!S.state) return;
  var key = normalizeDocId(S.state.docId) + "|" + docHomeKey();
  if (key === lastIdentityKey) return;
  lastIdentityKey = key;
  identityAdoptedAt = Date.now();
  if (typeof historyDocumentChanged === "function") {
    try { historyDocumentChanged(); } catch (e) { if (window.console) console.error(e); }
  }
  if (!S.DESKTOP) announceDocIdentity();
}

export function reassignDocId(toId, opts) {
  opts = opts || {};
  toId = normalizeDocId(toId);
  var fromId = normalizeDocId(opts.fromId);
  if (!toId || !fromId || toId === fromId || !S.state || S.state.docId !== fromId) return false;
  if (onServerDoc()) return false;
  S.state.docId = toId;
  S.docIdWrittenOut = false;
  copyDocHistorySafe(fromId, toId);
  syncDocIdentity();
  var other = plainText(opts.otherTitle == null ? "" : opts.otherTitle).trim().slice(0, 300) || "Untitled Script";
  showToast('This file is a copy of "' + other + '", which is open in another tab. ' +
    "It now has its own version history. Save it to keep them separate.", "warn", true);
  return true;
}

var DOC_ID_CHANNEL_NAME = "splitpage-doc-ids";
var docIdChannel = null;

export function initDocIdentityChannel(factory) {
  if (S.DESKTOP) return null;
  if (docIdChannel) {
    try { if (typeof docIdChannel.close === "function") docIdChannel.close(); } catch (e) {}
    docIdChannel = null;
  }
  var ch = null;
  try {
    if (typeof factory === "function") ch = factory(DOC_ID_CHANNEL_NAME);
    else if (typeof BroadcastChannel === "function") ch = new BroadcastChannel(DOC_ID_CHANNEL_NAME);
  } catch (e) { ch = null; }
  if (!ch) return null;
  ch.onmessage = function (ev) {
    onDocIdentityMessage(ev && typeof ev === "object" && "data" in ev ? ev.data : ev);
  };
  docIdChannel = ch;
  announceDocIdentity();
  return ch;
}

function currentDocIdClaim(type) {
  if (!S.state) return null;
  var docId = normalizeDocId(S.state.docId);
  var home = docHomeKey();
  if (!docId || home.indexOf("file:") !== 0) return null;
  return { type: type, docId: docId, home: home, at: identityAdoptedAt, nonce: PAGE_NONCE,
           title: plainText(S.state.title || "").slice(0, 300) };
}

function announceDocIdentity() {
  if (S.DESKTOP || !docIdChannel) return false;
  var claim = currentDocIdClaim("claim");
  if (!claim) return false;
  try { docIdChannel.postMessage(claim); } catch (e) { return false; }
  return true;
}

function onDocIdentityMessage(msg) {
  if (S.DESKTOP || !msg || typeof msg !== "object") return;
  if (msg.type !== "claim" && msg.type !== "here") return;
  if (msg.nonce === PAGE_NONCE) return;
  var mine = currentDocIdClaim("here");
  if (!mine) return;
  var theirs = {
    type: msg.type,
    docId: normalizeDocId(msg.docId),
    home: String(msg.home == null ? "" : msg.home),
    at: Number(msg.at) || 0,
    nonce: String(msg.nonce == null ? "" : msg.nonce),
    title: plainText(msg.title == null ? "" : String(msg.title)).slice(0, 300)
  };
  var loser = decideDuplicateLoser(mine, theirs);
  if (!loser) return;
  if (loser === mine) {
    reassignDocId(docIdFromSha256Hex(sha256Hex(duplicateReplacementInput(mine.docId, mine.home))),
      { fromId: mine.docId, otherTitle: theirs.title });
    return;
  }
  if (msg.type === "claim") {
    try { docIdChannel.postMessage(mine); } catch (e) {}
  }
}

export function docIdEvents() {
  return docIdEventLog.slice();
}

export function standaloneHtmlFor(s, head) {
  var copy = migrateRows(cloneState(s || S.state));
  inlineStateImages(copy);
  delete copy.docId;
  var html = buildPublishHtml(JSON.stringify(copy));
  return head ? withPageHead(html, head) : html;
}

export function __init() {
  PAGE_NONCE = randomHexBytes(16);
}
