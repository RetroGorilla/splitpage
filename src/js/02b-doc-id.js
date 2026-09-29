import { S } from "./_state.js";
import { home } from "./_home.js";
import { buildPublishHtml, escapeHtml, migrateRows } from "./02-state.js";
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

var PAGE_NONCE;

export function randomHexBytes(n) {
  var bytes = new Uint8Array(n), i;
  var c = window.crypto || window.msCrypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  var hex = "";
  for (i = 0; i < n; i++) hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return hex;
}

export function mintDocId() {
  return "d" + randomHexBytes(16);
}

var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

// Must match TextEncoder byte-for-byte, lone surrogates included
function utf8BytesManual(str) {
  var out = [], i, c, n;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (n - 0xdc00); i++; }
      else c = 0xfffd;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function utf8Bytes(str) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(str);
  return utf8BytesManual(str);
}

function sha256Block(H, w, src, off) {
  var a, b, c, d, e, f, g, h, t, j, x, y, t1, t2;
  for (t = 0; t < 16; t++) {
    j = off + t * 4;
    w[t] = (src[j] << 24) | (src[j + 1] << 16) | (src[j + 2] << 8) | src[j + 3];
  }
  for (t = 16; t < 64; t++) {
    x = w[t - 2]; y = w[t - 15];
    w[t] = ((((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10)) +
            w[t - 7] +
            (((y >>> 7) | (y << 25)) ^ ((y >>> 18) | (y << 14)) ^ (y >>> 3)) +
            w[t - 16]) | 0;
  }
  a = H[0]; b = H[1]; c = H[2]; d = H[3]; e = H[4]; f = H[5]; g = H[6]; h = H[7];
  for (t = 0; t < 64; t++) {
    t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
          ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) | 0;
    t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
          ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

export function sha256Bytes(bytes) {
  var len = bytes.length;
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var w = new Int32Array(64);
  var full = len - (len % 64), off, t;
  for (off = 0; off < full; off += 64) sha256Block(H, w, bytes, off);
  var rest = len - full;
  var total = rest + 9 <= 64 ? 64 : 128;
  var msg = new Uint8Array(total);
  for (t = 0; t < rest; t++) msg[t] = bytes[full + t];
  msg[rest] = 0x80;
  var hi = Math.floor(len / 0x20000000), lo = (len * 8) >>> 0;
  msg[total - 8] = (hi >>> 24) & 0xff; msg[total - 7] = (hi >>> 16) & 0xff;
  msg[total - 6] = (hi >>> 8) & 0xff;  msg[total - 5] = hi & 0xff;
  msg[total - 4] = (lo >>> 24) & 0xff; msg[total - 3] = (lo >>> 16) & 0xff;
  msg[total - 2] = (lo >>> 8) & 0xff;  msg[total - 1] = lo & 0xff;
  for (off = 0; off < total; off += 64) sha256Block(H, w, msg, off);
  var hex = "";
  for (t = 0; t < 8; t++) hex += ("0000000" + (H[t] >>> 0).toString(16)).slice(-8);
  return hex;
}

export function sha256Hex(str) {
  return sha256Bytes(utf8Bytes(String(str)));
}

// FROZEN; changing it re-ids every existing document
export function deriveDocId(domain, text) {
  return "d" + sha256Hex(String(domain) + "\n" + String(text)).slice(0, 32);
}

export function docIdEmbeddedIn(raw) {
  return !!normalizeDocId(raw && typeof raw === "object" ? raw.docId : null);
}

// Legacy files need deterministic ids, else history resets each open
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

export function mergedDocId(base, mine, theirs) {
  var m = normalizeDocId(mine && mine.docId);
  var t = normalizeDocId(theirs && theirs.docId);
  if (m === t) return m;
  if (base && t === normalizeDocId(base.docId)) return m || t;
  return t || m;
}

export function noteMergedDocId(prevId) {
  prevId = normalizeDocId(prevId);
  if (!S.state || !prevId || prevId === S.state.docId) return;
  copyDocHistorySafe(prevId, S.state.docId);
  syncDocIdentity();
}

// Restore keeps current id; never adopt snapshot's id
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

// Must never throw or block the save it rides on
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

// Runs on every markDirty; must stay cheap and idempotent
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

// Never writes user's file: no markDirty, no autosave
export function reassignDocId(toId, opts) {
  opts = opts || {};
  toId = normalizeDocId(toId);
  var fromId = normalizeDocId(opts.fromId);
  if (!toId || !fromId || toId === fromId || !S.state || S.state.docId !== fromId) return false;
  // Server doc ids are shared by design
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

// Exported copy must not carry the original's id
export function standaloneHtmlFor(s, head) {
  var copy = migrateRows(cloneState(s || S.state));
  inlineStateImages(copy);
  delete copy.docId;
  var html = buildPublishHtml(JSON.stringify(copy));
  return head ? withPageHead(html, head) : html;
}

// Function replacer needed; titles may contain $& or $1
export function withPageHead(html, head) {
  function oneLine(v) { return escapeHtml(String(v).replace(/\s+/g, " ").trim()); }
  var headEnd = html.search(/<\/head>/i);
  if (headEnd === -1) return html;
  var top = html.slice(0, headEnd), rest = html.slice(headEnd);
  if (head.title) {
    top = top.replace(/<title>[^<]*<\/title>/i, function () {
      return "<title>" + oneLine(head.title) + "</title>";
    });
  }
  if (head.description) {
    var meta = '<meta name="description" content="' + oneLine(head.description) + '">';
    var had = false;
    top = top.replace(/<meta name="description" content="[^"]*">/i, function () { had = true; return meta; });
    if (!had) top = top.replace(/<\/title>/i, function (m) { return m + "\n" + meta; });
  }
  return top + rest;
}

export function __init() {
  PAGE_NONCE = randomHexBytes(16);
}
