import { documentIdStamp } from "../commands/save-stamps.ts";
import { sha256Hex } from "../../core/document/ids.ts";
import { cappedLongText, plainText } from "../../core/document/text-policy.ts";
import { decideDuplicateLoser, docIdFromSha256Hex, duplicateReplacementInput, normalizeDocId } from "../../../shared/doc-id-policy.js";

function startIdentity(ports) {
  var currentDocument = ports.session.currentDocument;
  var stampDocument = ports.session.stampDocument;
  var currentHome = ports.location.home;
  var documentLocation = function () { return ports.location; };
  var showToast = ports.effects.show;
  var copyHistory = ports.history.copyHistory;
  var historyDocumentChanged = ports.history.historyDocumentChanged;
  var runningOnDesktop = ports.desktop.running;
  var mintDocId = ports.ids.docId;
  var randomHexBytes = ports.ids.randomHexBytes;

var PAGE_NONCE = randomHexBytes(16);

function noteMergedDocId(prevId) {
  prevId = normalizeDocId(prevId);
  if (!currentDocument() || !prevId || prevId === currentDocument().docId) return;
  copyDocHistorySafe(prevId, currentDocument().docId);
  syncDocIdentity();
}

var documentIdentityPort = Object.freeze({
  mint: mintDocId,
  writtenOut: function () { return documentLocation().writtenOut(); },
  markWrittenOut: function (writtenOut) { documentLocation().markWrittenOut(writtenOut); }
});

var identityAdoptedAt = 0;
var lastIdentityKey = "";
var docIdEventLog = [];
var docIdCopyWarned = false;

function copyDocHistorySafe(from, to) {
  from = normalizeDocId(from);
  to = normalizeDocId(to);
  if (!from || !to || from === to) return;
  docIdEventLog.push({ type: "copy", from: from, to: to });
  if (docIdEventLog.length > 200) docIdEventLog.shift();
  if (typeof copyHistory !== "function") return;
  function warn() {
    if (!active || docIdCopyWarned) return;
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
  var home = currentHome();
  if (home.kind === "file") {
    return "file:" + ((home.handle && home.handle.name) || home.name || "");
  }
  return "none:" + PAGE_NONCE;
}

function syncDocIdentity() {
  if (!currentDocument()) return;
  var key = normalizeDocId(currentDocument().docId) + "|" + docHomeKey();
  if (key === lastIdentityKey) return;
  lastIdentityKey = key;
  identityAdoptedAt = ports.now();
  if (typeof historyDocumentChanged === "function") {
    try { historyDocumentChanged(); } catch (e) { ports.logger.error(e); }
  }
  if (!runningOnDesktop()) announceDocIdentity();
}

function reassignDocId(toId, opts) {
  opts = opts || {};
  toId = normalizeDocId(toId);
  var fromId = normalizeDocId(opts.fromId);
  if (!toId || !fromId || toId === fromId || !currentDocument() || currentDocument().docId !== fromId) return false;
  stampDocument(documentIdStamp(fromId, toId));
  documentLocation().markWrittenOut(false);
  copyDocHistorySafe(fromId, toId);
  syncDocIdentity();
  var other = cappedLongText(plainText(opts.otherTitle == null ? "" : opts.otherTitle).trim(), 300) || "Untitled Script";
  showToast('This file is a copy of "' + other + '", which is open in another tab. ' +
    "It now has its own version history. Save it to keep them separate.", "warn", true);
  return true;
}

var DOC_ID_CHANNEL_NAME = "splitpage-doc-ids";
var docIdChannel = null;

function initDocIdentityChannel(factory) {
  if (runningOnDesktop()) return null;
  if (docIdChannel) {
    try { if (typeof docIdChannel.close === "function") docIdChannel.close(); } catch (e) {}
    docIdChannel = null;
  }
  var ch;
  try {
    if (typeof factory === "function") ch = factory(DOC_ID_CHANNEL_NAME);
    else ch = ports.channel(DOC_ID_CHANNEL_NAME);
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
  if (!currentDocument()) return null;
  var docId = normalizeDocId(currentDocument().docId);
  var home = docHomeKey();
  if (!docId || home.indexOf("file:") !== 0) return null;
  return { type: type, docId: docId, home: home, at: identityAdoptedAt, nonce: PAGE_NONCE,
           title: cappedLongText(plainText(currentDocument().title || ""), 300) };
}

function announceDocIdentity() {
  if (runningOnDesktop() || !docIdChannel) return false;
  var claim = currentDocIdClaim("claim");
  if (!claim) return false;
  try { docIdChannel.postMessage(claim); } catch (e) { return false; }
  return true;
}

function onDocIdentityMessage(msg) {
  if (runningOnDesktop() || !msg || typeof msg !== "object") return;
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

function docIdEvents() {
  return docIdEventLog.slice();
}

  var active = true;
  function guarded(fn) {
    return function (...args) {
      if (!active) throw new Error("The document identity is not started yet");
      return fn(...args);
    };
  }
  var api = { noteMergedDocId, copyDocHistorySafe, syncDocIdentity, reassignDocId, initDocIdentityChannel, docIdEvents };
  Object.keys(api).forEach(function (key) { api[key] = guarded(api[key]); });
  api.documentIdentityPort = Object.freeze(documentIdentityPort);
  api.dispose = function () {
    if (!active) return;
    active = false;
    if (docIdChannel) {
      docIdChannel.onmessage = null;
      try { if (typeof docIdChannel.close === "function") docIdChannel.close(); } catch (e) {}
      docIdChannel = null;
    }
  };
  return api;
}

export function createDocumentIdentityOwner() {
  var started = null;
  function running() {
    if (!started) throw new Error("The document identity is not started yet");
    return started;
  }
  return {
    startIdentity: function (ports) {
      if (started) throw new Error("The document identity is already started; stop it first");
      var mine = startIdentity(ports);
      started = mine;
      return function () {
        if (started !== mine) return;
        started = null;
        mine.dispose();
      };
    },
    documentIdentityPort: Object.freeze({
      mint: function () { return running().documentIdentityPort.mint(); },
      writtenOut: function () { return running().documentIdentityPort.writtenOut(); },
      markWrittenOut: function (value) { return running().documentIdentityPort.markWrittenOut(value); }
    }),
    noteMergedDocId: function (...args) { return running().noteMergedDocId(...args); },
    copyDocHistorySafe: function (...args) { return running().copyDocHistorySafe(...args); },
    syncDocIdentity: function (...args) { return running().syncDocIdentity(...args); },
    reassignDocId: function (...args) { return running().reassignDocId(...args); },
    initDocIdentityChannel: function (...args) { return running().initDocIdentityChannel(...args); },
    docIdEvents: function (...args) { return running().docIdEvents(...args); }
  };
}
