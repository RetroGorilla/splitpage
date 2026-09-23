"use strict";
/* ---------------------------------------------------------------------
 * shared/doc-id-policy.js: document identity, and who gives an id up when
 * two documents turn out to be holding the same one (issue #76).
 *
 * Every document carries `state.docId`: "d" + 32 lowercase hex (invariant
 * #35). It is what version history, crash-safe drafts and the desktop's
 * duplicate check key on. Copy a file in Explorer, open both copies, and
 * there are suddenly two documents claiming one identity: every snapshot
 * either takes would land in the other's history.
 *
 * TWO AUTHORITIES, ONE RULE SET. The browser decides over a same-origin
 * BroadcastChannel (src/js/02b-doc-id.js); the desktop decides in the main
 * process, over a claim table across every window and tab (desktop/main.js,
 * DOC-CLAIMS), and the browser's channel check is deliberately disabled
 * under DESKTOP — two authorities racing would re-id BOTH copies. The
 * evidence each one has is different (a tab knows a file's NAME and when it
 * adopted the identity; the main process knows the resolved PATH and the
 * order the tabs claimed in), so the two verdict functions below stay
 * separate and keep their own inputs. What they must never differ on is the
 * REPLACEMENT id, and that is one function here.
 *
 * CommonJS, pure, and importable from the browser bundle, Electron's main
 * process and node --test alike — see history-policy.js's header for why
 * that is the format and what the package.json beside it is for.
 * --------------------------------------------------------------------- */

/* The id arrives from untrusted places (a pasted file, a server, another
   tab), and the desktop builds a folder name out of it, so anything that is
   not exactly the canonical shape is treated as absent — never trimmed,
   lower-cased or otherwise "repaired" into something valid. */
var DOC_ID_RE = /^d[0-9a-f]{32}$/;

function normalizeDocId(v) {
  return (typeof v === "string" && DOC_ID_RE.test(v)) ? v : "";
}

/* ---- the replacement identity ----

   A copy that loses adopts a DERIVED id rather than a random one, and never
   rewrites the user's file to record it (orchestrator override §1, the same
   rule as invariant #41 for drafts): a file nobody touched must not be
   rewritten — and re-synced by OneDrive — just because a copy of it was
   detected. The new id reaches disk with the user's next save. Until then
   the same pair of copies must get the same answer on every relaunch and in
   both authorities, or the copy's history would scatter across a new id each
   time.

   So both sides hash EXACTLY this string and take the first 32 hex of the
   sha256 — the browser with its own frozen sha256 (invariant #37, the
   vectors in 22-doc-id.txt pin it), the main process with node's crypto.
   Changing either the input or the truncation re-identifies every copy that
   has not been saved since, and splits its history. */
function duplicateReplacementInput(fromId, homeKey) {
  return "splitpage-dup\n" + String(fromId) + "\n" + String(homeKey);
}

/* "d" + the first 32 hex of a sha256 digest. Shared so that the two callers
   cannot disagree about how many characters they take or what they prefix. */
function docIdFromSha256Hex(hex) {
  return "d" + String(hex).slice(0, 32);
}

/* ---- the browser's verdict (BroadcastChannel) ----

   Pure, and symmetric: both tabs must reach the same verdict from the same
   two claims, or both would re-id (or neither). Returns the claim that has
   to give its id up, or null when the pair is not a duplicate at all. The
   later adopter loses — the earlier one has had the id longer and more
   likely owns the history under it; a tie falls to the nonce.

   A claim is {docId, home, at, nonce, title}. Only FILE homes ever take
   part: a server document's id is legitimately shared, and an unsaved "none"
   home carries a random id nothing else can hold. The name is all a browser
   tab can compare, so two same-named files in different folders read as one
   file and are left alone — best effort, never a false re-id of the one file
   open twice. */
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

/* ---- the desktop's verdict (DOC-CLAIMS) ----

   Pure, and symmetric for the same reason. A claim is {docId, homeKey, seq}:
   homeKey is "server:<key>" or "file:<resolved path, lower-cased on win32>",
   and seq is strictly increasing for the life of the main process — a higher
   seq means "adopted this identity later".

   Birthtime is NOT consulted, and there is no longer a branch for it (#76).
   The idea was that on win32 birthtime is a real creation time, so of two
   identical files the one that came into existence later is the copy. It
   does not survive contact with the filesystem: atomicWrite() saves by
   writing `.<name>.tmp-xxxx` next to the document and renaming it over the
   original, and NTFS here does NOT carry the destination's creation time
   across that rename (the "file tunnelling" behaviour the rule was counting
   on). Measured on Windows 11: every save-in-place moved birthtimeMs forward
   by exactly the elapsed time. That is not merely useless, it inverts the
   answer — save the ORIGINAL after someone copied it and the original now
   looks younger than the copy, so the rule would name the document the user
   has been working in as the loser. The seq tie-break is the honest answer,
   and it is symmetric for free. */
function chooseDuplicateLoser(a, b) {
  if (!a || !b || !a.docId || a.docId !== b.docId) return null;
  /* One home, one document. Nothing to split. */
  if (a.homeKey === b.homeKey) return null;
  var aServer = String(a.homeKey).indexOf("server:") === 0;
  var bServer = String(b.homeKey).indexOf("server:") === 0;
  /* Two server documents sharing an id are the SAME document opened twice
     (or two connections to it) — that is what a server id means. */
  if (aServer && bServer) return null;
  /* A server document against a local file: the server copy is the one other
     people are also editing, so the local file is the copy that gets re-id'd.
     (In practice this is a file saved down from a server document.) */
  if (aServer !== bServer) return aServer ? b : a;
  /* Two files, and nothing on disk tells them apart: the tab that adopted
     the identity later is the newcomer. */
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
