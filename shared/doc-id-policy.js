"use strict";

var DOC_ID_RE = /^d[0-9a-f]{32}$/;

// Untrusted input; build folder name from it, never repair.
function normalizeDocId(v) {
  return (typeof v === "string" && DOC_ID_RE.test(v)) ? v : "";
}

// Changing input or truncation re-identifies unsaved copies; split history.
function duplicateReplacementInput(fromId, homeKey) {
  return "splitpage-dup\n" + String(fromId) + "\n" + String(homeKey);
}

function docIdFromSha256Hex(hex) {
  return "d" + String(hex).slice(0, 32);
}

// Must stay symmetric; later adopter loses, nonce breaks ties.
function decideDuplicateLoser(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return null;
  var id = normalizeDocId(a.docId);
  if (!id || id !== normalizeDocId(b.docId)) return null;
  if (String(a.nonce) === String(b.nonce)) return null;
  if (String(a.home) === String(b.home)) return null;
  var at = Number(a.at) || 0, bt = Number(b.at) || 0;
  if (at !== bt) return at > bt ? a : b;
  return String(a.nonce) > String(b.nonce) ? a : b;
}

// Birthtime unusable: atomic-write renames reset it on NTFS.
function chooseDuplicateLoser(a, b) {
  if (!a || !b || !a.docId || a.docId !== b.docId) return null;
  if (a.homeKey === b.homeKey) return null;
  var aServer = String(a.homeKey).indexOf("server:") === 0;
  var bServer = String(b.homeKey).indexOf("server:") === 0;
  if (aServer && bServer) return null;
  if (aServer !== bServer) return aServer ? b : a;
  return a.seq > b.seq ? a : b;
}

module.exports = {
  DOC_ID_RE,
  chooseDuplicateLoser,
  decideDuplicateLoser,
  docIdFromSha256Hex,
  duplicateReplacementInput,
  normalizeDocId
};
