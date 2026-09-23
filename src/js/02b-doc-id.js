import { S } from "./_state.js";
import { home } from "./_home.js";
import { buildPublishHtml, migrateRows } from "./02-state.js";
import { inlineStateImages } from "./02c-blobs.js";
import { cloneState } from "./03-sync.js";
import { copyHistory, historyDocumentChanged } from "./03a-history-store.js";
import { plainText } from "./04-richtext.js";
import { showToast } from "./12-dirty-toast.js";
import { onServerDoc } from "./13-hosted.js";
/* The identity rules the desktop main process has to agree with: what a
   valid id looks like, which of two claims on one id gives it up, and the
   exact string a replacement id is derived from (#76). */
import {
  decideDuplicateLoser,
  docIdFromSha256Hex,
  duplicateReplacementInput,
  normalizeDocId
} from "../../shared/doc-id-policy.js";
export { decideDuplicateLoser, normalizeDocId };

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
var PAGE_NONCE;

/* ================= document identity =================

   Every document carries `state.docId`: "d" + 32 lowercase hex. It is what
   version history, crash-safe drafts and the desktop's duplicate check key
   on, so it has to mean "this script" and survive everything a script goes
   through — a Save, a merge, a restored snapshot, a trip through Markdown.

   Where it travels: .splitpage files, the .md data block, the server's
   doc.state, snapshots, stashes and drafts. Where it never goes: the seed
   (build.mjs refuses a seed-state.json that carries one, because every
   fresh copy of the app would then share one identity), #state-data, and
   the Standalone HTML export (standaloneHtmlFor deletes it — that export is
   a copy you hand to someone, not the document itself).

   The one rule everything below follows: a MISSING id must fail unique,
   never shared. Two documents that accidentally share an id share a
   version history, and restoring "an earlier version" would then hand you
   someone else's script. So an absent or hostile id is re-minted at random
   unless there is a deterministic reason to pick one (a legacy file's own
   content, a server document's own id), and SCHEMA_VERSION is not bumped
   for any of this — bumping it would re-run legacyMdToHtml over every
   already-migrated file (02-state.js). */

/* DOC_ID_RE and normalizeDocId are shared/doc-id-policy.js's, imported and
   re-exported at the top of this file (#76): the main process validates the
   same shape before it builds a history folder name out of an id. */

export function randomHexBytes(n) {
  var bytes = new Uint8Array(n), i;
  var c = window.crypto || window.msCrypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    /* Every browser this app runs in has getRandomValues, even on a
       plain-HTTP LAN host (it is not gated on a secure context the way
       crypto.subtle is). The fallback only exists so a missing API degrades
       to "probably unique" instead of throwing during boot. */
    for (i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  var hex = "";
  for (i = 0; i < n; i++) hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return hex;
}

export function mintDocId() {
  return "d" + randomHexBytes(16);
}

/* ---- SHA-256 ----

   FROZEN (HANDOFF invariant #37). A legacy file that carries no id gets one
   derived from its own content through this function, and a duplicate
   copy gets a replacement id derived the same way. Any change to the
   output — a different encoding, a different truncation, a "faster"
   library that disagrees on one edge case — silently re-identifies every
   one of those documents, which splits each one's version history in two
   on the next open. The vectors in 22-doc-id.txt pin it.

   Why hand-written and synchronous: crypto.subtle.digest is async (the
   ingress paths that need an id are synchronous, and making them async
   would reorder every open), and it does not exist at all on a page served
   over plain HTTP to another machine on the LAN, which is exactly how
   --host serves this app. */
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

/* UTF-8 without TextEncoder, matching it byte for byte — including a lone
   surrogate, which TextEncoder encodes as U+FFFD. The hash is over BYTES,
   so both paths must agree or the same file would get two ids depending on
   which browser opened it. */
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

/* One 64-byte block of `src`, starting at `off`, folded into H. `src` is
   anything indexable holding byte values — the caller's own Uint8Array, a
   plain array from utf8BytesManual, or the padded tail below — so a large
   input is hashed where it lies instead of being copied first. */
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

/* SHA-256 of raw bytes, as 64 lowercase hex (#82: the content address of an
   image blob). The same core as sha256Hex — which is FROZEN — split out so
   an image is hashed without a detour through a string; sha256Hex is this
   over the string's UTF-8, and its vectors pin that the split changed
   nothing. Synchronous for the reasons above: the migration that interns a
   legacy data: URI runs inside migrateRows, and crypto.subtle is absent on
   a plain-HTTP LAN page anyway. */
export function sha256Bytes(bytes) {
  var len = bytes.length;
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var w = new Int32Array(64);
  var full = len - (len % 64), off, t;
  for (off = 0; off < full; off += 64) sha256Block(H, w, bytes, off);
  /* The padded tail: what is left of the message, 0x80, zeros, and the
     message length in bits as a 64-bit big-endian integer — one block, or
     two when the length no longer fits behind the leftover bytes. len * 8
     is exact in a double for anything a browser can hold; the high word is
     taken by division so nothing is lost to 32-bit bitwise truncation. */
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

/* FROZEN, for the same reason as sha256Hex. `domain` keeps the three
   derivations ('splitpage-file', 'splitpage-server-doc', 'splitpage-dup')
   from ever colliding with each other: a file whose content happens to be
   a server id's text must not inherit that server document's history. */
export function deriveDocId(domain, text) {
  return "d" + sha256Hex(String(domain) + "\n" + String(text)).slice(0, 32);
}

/* ---- ingress and merge ---- */

export function docIdEmbeddedIn(raw) {
  return !!normalizeDocId(raw && typeof raw === "object" ? raw.docId : null);
}

/* The one way an outside document becomes state AND gets an identity.
   migrateRows alone would give a legacy file a random id on every open —
   the same untouched file would look like a new document each time and
   its history would start over every launch. So when the raw object has
   no valid id of its own, pick one deterministically from what we know:

     file    the raw content, serialized BEFORE migrateRows touches it (so
             the id depends on the file's bytes, not on today's migration)
     server  the id the caller already knew for this document, else one
             derived from the server's own document id
     fresh   nothing to derive from: keep migrateRows' random id

   A file that does carry a valid id keeps it, whatever else it says. */
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
    /* No server id to derive from means no shared name to agree on — keep
       the random id rather than letting every such document collide on
       the hash of "". */
    if (fallback) s.docId = fallback;
    else if (serverId) s.docId = deriveDocId("splitpage-server-doc", serverId);
  }
  return s;
}

/* mergeStates' docId. Equal ids stay. If only I changed it since base
   (theirs is still base's), mine is the newer identity (a Save As fork I
   just made). Anything else takes theirs: it is the published truth, the
   same side mergeStates already starts from for row order. An invalid
   value on one side never wins over a valid one on the other — an empty
   result would make migrateRows mint a random id and split the history. */
export function mergedDocId(base, mine, theirs) {
  var m = normalizeDocId(mine && mine.docId);
  var t = normalizeDocId(theirs && theirs.docId);
  if (m === t) return m;
  if (base && t === normalizeDocId(base.docId)) return m || t;
  return t || m;
}

/* After a merge replaced `state`, the id may have changed under us (theirs
   won). The history this view has been writing under the old id belongs
   to the same script, so it follows the document to its new id. */
export function noteMergedDocId(prevId) {
  prevId = normalizeDocId(prevId);
  if (!S.state || !prevId || prevId === S.state.docId) return;
  copyDocHistorySafe(prevId, S.state.docId);
  syncDocIdentity();
}

/* Restoring a snapshot changes the CONTENT, never the identity: an entry
   copied in from another document's history (or saved before a Save As
   fork) carries a different id, and adopting it would silently move this
   document into that other history. The only place a restore keeps the id. */
export function adoptRestoredState(snap) {
  var keep = normalizeDocId(S.state && S.state.docId);
  S.state = migrateRows(cloneState(snap));
  if (keep) S.state.docId = keep;
  return S.state;
}

/* ---- identity state ---- */

/* Whether this id has ever left the page — a file was opened or saved, a
   server document loaded or published, a draft restored with its header.
   Save As forks a new id only when this is true: an id nobody else has
   seen can simply travel with the first save, but one already on disk
   would otherwise end up in two files at once. False after a pristine
   boot or a detached draft copy. */
S.docIdWrittenOut = false;
/* When the current docId|home pair was adopted, in ms. The browser
   duplicate check lets the EARLIER adopter keep the id. */
var identityAdoptedAt = 0;
var lastIdentityKey = "";
var docIdEventLog = [];
var docIdCopyWarned = false;

/* Carries version history from one id to another. Never throws and never
   blocks a save: losing the history copy is bad, losing the save it rode
   along with is far worse. copyHistory arrives with the history store
   (03a-history-store.js); until then this only records the event. */
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
      showToast("Couldn't copy this document's version history to its new identity. " +
        "Earlier versions are still kept under the old one.", "warn");
    } catch (e) { /* a toast is a courtesy */ }
  }
  try {
    var p = copyHistory(from, to);
    if (p && typeof p.then === "function") {
      p.then(function (r) { if (r && r.ok === false) warn(); }, warn);
    }
  } catch (e) { warn(); }
}

/* Where this document lives, as far as identity is concerned — read off
   the one home record (_home.js), so only one answer can hold at a time.
   A foreign file opened for round-trip export is not an identity home: its
   document was minted fresh on open and has never been anywhere, the same
   as a blank one (loadFileIntoEditor, 18-local-files.js). */
function docHomeKey() {
  if (home.kind === "server") return "server:" + home.id;
  if (home.kind === "file") {
    return "file:" + ((home.handle && home.handle.name) || home.name || "");
  }
  return "none:" + PAGE_NONCE;
}

/* The one "a different document is now current" hook. It is cheap and
   idempotent on purpose — it is called from the invariant #20 save-state
   funnel, i.e. on every markDirty — and does its work only when the id or
   the home actually changed, so typing never touches history or the
   channel. */
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

/* ---- duplicates ---- */

/* Two open files with one id (a file copied in Explorer, both open) would
   share one version history. The copy gets a new id.

   It never writes the user's file (orchestrator override §1, the same rule
   as invariant #41 for drafts): no markDirty, no autosave, whatever the
   document kind. A file the user did not touch must not be rewritten — and
   re-synced by OneDrive — just because a copy was detected. The new id
   reaches disk with the user's next save; until then the replacement is
   deterministic (the caller derives it from the old id and this home), so
   the copy gets the same id every time both are open and its history
   stays in one place. */
export function reassignDocId(toId, opts) {
  opts = opts || {};
  toId = normalizeDocId(toId);
  var fromId = normalizeDocId(opts.fromId);
  if (!toId || !fromId || toId === fromId || !S.state || S.state.docId !== fromId) return false;
  /* A server document's id is shared by everyone who opens it by design;
     two tabs on one server document are the same document, not copies. */
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

/* The browser's best-effort duplicate check, over a same-origin
   BroadcastChannel. Desktop never uses it: there the main process owns a
   claim table across every tab and window (DOC-CLAIMS), and two
   authorities would race each other into re-iding both copies.

   Protocol: a tab whose document has a FILE home posts
   {type:'claim', docId, home:'file:<name>', at, nonce, title} whenever its
   identity changes. Another tab holding the same id under a different home
   computes the same decideDuplicateLoser() verdict; the loser re-ids
   itself, and a winner that received a claim answers with a 'here' so a
   loser that spoke first still learns about it. Only file homes take part
   — a server document's id is legitimately shared, and an unsaved "none"
   home carries a random id nothing else can hold. The name is all a
   browser tab can compare, so two same-named files in different folders
   read as one file and are left alone: best effort, never a false re-id
   of the one file open twice. */
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

/* decideDuplicateLoser — which of two tabs' claims on one id has to give it
   up, pure and symmetric so both tabs reach the same verdict — is
   shared/doc-id-policy.js's (#76), next to the main process's own rule.
   Imported and re-exported at the top of this file. */

function onDocIdentityMessage(msg) {
  if (S.DESKTOP || !msg || typeof msg !== "object") return;
  if (msg.type !== "claim" && msg.type !== "here") return;
  if (msg.nonce === PAGE_NONCE) return;
  var mine = currentDocIdClaim("here");
  if (!mine) return;
  /* Another tab's message is untrusted input like any other: rebuilt from
     plain values before it is compared or shown. */
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
    /* The replacement id, byte-identical to the one desktop/main.js derives
       for the same pair: one shared input string, one shared truncation,
       this module's own frozen sha256 (invariant #37). */
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

/* ---- export ---- */

/* The Standalone HTML export is a copy handed to someone else, not this
   document: carrying the id would make every such copy a duplicate of the
   original the moment it is opened next to it. */
export function standaloneHtmlFor(s) {
  var copy = migrateRows(cloneState(s || S.state));
  /* its pictures inline, like a .splitpage file (#82): the copy stands on
     its own. buildFileData awaits ensureBytes before this runs. */
  inlineStateImages(copy);
  delete copy.docId;
  return buildPublishHtml(JSON.stringify(copy));
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  /* Identifies THIS page load. Not a document id — it only separates "no
     home yet" documents in two different tabs from each other in
     docHomeKey(), and names this tab in the browser duplicate check. */
  PAGE_NONCE = randomHexBytes(16);
}
