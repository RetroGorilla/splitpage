"use strict";

type SharedDuplicateIdentityClaim = { docId?: unknown; nonce?: unknown; home?: unknown; at?: unknown };
type SharedDuplicateFileClaim = { docId?: unknown; homeKey?: unknown; seq: number };

const DOC_ID_RE = /^d[0-9a-f]{32}$/;

function normalizeDocId(v: unknown) {
  return (typeof v === "string" && DOC_ID_RE.test(v)) ? v : "";
}

function duplicateReplacementInput(fromId: unknown, homeKey: unknown) {
  return "splitpage-dup\n" + String(fromId) + "\n" + String(homeKey);
}

function docIdFromSha256Hex(hex: unknown) {
  return "d" + String(hex).slice(0, 32);
}

function decideDuplicateLoser<A extends SharedDuplicateIdentityClaim, B extends SharedDuplicateIdentityClaim>(a: A | null | undefined, b: B | null | undefined): A | B | null {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return null;
  const id = normalizeDocId(a.docId);
  if (!id || id !== normalizeDocId(b.docId)) return null;
  if (String(a.nonce) === String(b.nonce)) return null;
  if (String(a.home) === String(b.home)) return null;
  const at = Number(a.at) || 0;
  const bt = Number(b.at) || 0;
  if (at !== bt) return at > bt ? a : b;
  return String(a.nonce) > String(b.nonce) ? a : b;
}

function chooseDuplicateLoser<A extends SharedDuplicateFileClaim, B extends SharedDuplicateFileClaim>(a: A | null | undefined, b: B | null | undefined): A | B | null {
  if (!a || !b || !a.docId || a.docId !== b.docId) return null;
  if (a.homeKey === b.homeKey) return null;
  const aServer = String(a.homeKey).indexOf("server:") === 0;
  const bServer = String(b.homeKey).indexOf("server:") === 0;
  if (aServer && bServer) return null;
  if (aServer !== bServer) return aServer ? b : a;
  return a.seq > b.seq ? a : b;
}

export {
  DOC_ID_RE,
  chooseDuplicateLoser,
  decideDuplicateLoser,
  docIdFromSha256Hex,
  duplicateReplacementInput,
  normalizeDocId
};
