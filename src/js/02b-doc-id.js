import { S } from "./_state.js";
import { home } from "./_home.js";
import { mintDocId, randomHexBytes } from "../adapters/identity/ids.ts";
import { mergedDocId, sha256Hex, withPageHead } from "../core/document/ids.ts";
import { cappedLongText, plainText } from "../core/document/text-policy.ts";
import { migrateDocument as migrateDocumentWith } from "../core/migrate.ts";
import { withDocumentPorts } from "../legacy/document-ports.ts";
import { documentTransitions } from "../legacy/transition-bridge.ts";
import { neverWrittenOut } from "../application/recovery/pristine.ts";
import { base64Encode } from "../core/document/media.ts";
import { STATE_FIELDS, buildPublishHtml, defaultState, migrateRows } from "./02-state.js";
import { inlineStateImages } from "../adapters/storage/02c-blobs.js";
import { copyHistory, historyDocumentChanged } from "./03a-history-store.js";
import { showToast } from "./12-dirty-toast.js";
import { onServerDoc } from "./13-hosted.js";
import {
  decideDuplicateLoser,
  docIdFromSha256Hex,
  duplicateReplacementInput,
  normalizeDocId
} from "../../shared/doc-id-policy.js";
import { cloneState } from "../core/document/clone.ts";
export { decideDuplicateLoser };
export { mergedDocId, randomHexBytes, sha256Hex, withPageHead };

var PAGE_NONCE;

export function migrateDocument(raw, origin) {
  return withDocumentPorts(STATE_FIELDS, function (ports) {
    return migrateDocumentWith(raw, origin, ports);
  });
}

export function loadInitialDocument(pristine) {
  S.state = null;
  return loadInitialState(pristine);
}

export async function loadInitialState(pristine) {
  var raw = null;
  if (!pristine) {
    try { raw = JSON.parse(document.getElementById("state-data").textContent); } catch (e) { raw = null; }
  }
  var loaded = pristine || !raw || typeof raw !== "object" || neverWrittenOut(raw)
    ? null
    : migrateDocument(raw, { kind: "file" });
  if (!loaded || neverWrittenOut(loaded)) {
    S.docIdWrittenOut = false;
    return migrateRows(defaultState());
  }
  S.docIdWrittenOut = true;
  return loaded;
}

export function noteMergedDocId(prevId) {
  prevId = normalizeDocId(prevId);
  if (!S.state || !prevId || prevId === S.state.docId) return;
  copyDocHistorySafe(prevId, S.state.docId);
  syncDocIdentity();
}

export function adoptRestoredState(snap) {
  return documentTransitions().restore({ from: { raw: cloneState(snap) } }).document;
}

export var liveDocumentPort = Object.freeze({
  current: function () { return S.state || null; },
  assign: function (doc) { S.state = doc; }
});

export var documentIdentityPort = Object.freeze({
  mint: mintDocId,
  writtenOut: function () { return !!S.docIdWrittenOut; },
  markWrittenOut: function (writtenOut) { S.docIdWrittenOut = writtenOut; }
});

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
  var other = cappedLongText(plainText(opts.otherTitle == null ? "" : opts.otherTitle).trim(), 300) || "Untitled Script";
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
           title: cappedLongText(plainText(S.state.title || ""), 300) };
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
    title: cappedLongText(plainText(msg.title == null ? "" : String(msg.title)), 300)
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

export function standaloneHtmlFor(doc, head, assets) {
  var copy = migrateRows(cloneState(doc.document));
  inlineStateImages(copy, null, assets ? function (sha) {
    var held = assets.picture(sha);
    return held && held.mime ? "data:" + held.mime + ";base64," + base64Encode(held.bytes) : null;
  } : null);
  delete copy.docId;
  var html = buildPublishHtml(JSON.stringify(copy));
  return head ? withPageHead(html, head) : html;
}

export function __init() {
  PAGE_NONCE = randomHexBytes(16);
}
