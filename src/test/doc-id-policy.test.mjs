/* shared/doc-id-policy.js — who gives a document id up when two documents
 * turn out to be holding the same one, and what the replacement is (#76).
 *
 * TWO AUTHORITIES, one rule set. A browser tab decides over a same-origin
 * BroadcastChannel (decideDuplicateLoser, driven by src/js/02b-doc-id.js);
 * the desktop app decides in the main process, over a claim table across
 * every window and tab (chooseDuplicateLoser, driven by desktop/main.js's
 * DOC-CLAIMS). Each sees different evidence, so each keeps its own inputs —
 * what they may never differ on is the replacement id, and that is one
 * derivation here.
 *
 * SYMMETRY IS THE PROPERTY. If the two sides of a pair ever named different
 * losers, BOTH tabs would give the shared id up: both would show the "this
 * file is a copy" toast, and the history under the original id would be
 * copied to two derived ids and owned by neither. Every verdict case below
 * asks the same pair both ways round.
 *
 * NO _dom.mjs IMPORT, deliberately — see history-policy.test.mjs's header.
 * This module is required by Electron's main process, bundled into the page
 * and imported here, so it may not need a DOM, an Electron or an __init().
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  DOC_ID_RE,
  chooseDuplicateLoser,
  decideDuplicateLoser,
  docIdFromSha256Hex,
  duplicateReplacementInput,
  normalizeDocId
} from "../../shared/doc-id-policy.js";

const ID = "d" + "a".repeat(32);
const ID2 = "d" + "b".repeat(32);

/* A browser claim (02b-doc-id.js's currentDocIdClaim) and a main-process
   claim (main.js's recordDocClaim) — the two shapes, spelled out. */
const tab = (over) => Object.assign({ docId: ID, home: "file:a.md", at: 1000, nonce: "n1" }, over);
const claim = (over) => Object.assign({ docId: ID, homeKey: "file:c:\\x\\a.md", seq: 1 }, over);

/* Both verdict functions must name the SAME claim whichever order they are
   asked in — the object, not a copy of it. */
function loserBothWays(fn, a, b) {
  const first = fn(a, b);
  const second = fn(b, a);
  assert.equal(first, second, "the verdict is not symmetric");
  return first;
}

test("normalizeDocId accepts the canonical shape and nothing else", () => {
  assert.equal(normalizeDocId(ID), ID);
  assert.equal(normalizeDocId("d" + "0123456789abcdef".repeat(2)), "d" + "0123456789abcdef".repeat(2));
  /* Never trimmed, lower-cased or otherwise repaired into something valid:
     the desktop builds a history folder name out of this. */
  assert.equal(normalizeDocId("D" + "a".repeat(32)), "");
  assert.equal(normalizeDocId("d" + "A".repeat(32)), "");
  assert.equal(normalizeDocId(" " + ID), "");
  assert.equal(normalizeDocId(ID + " "), "");
  assert.equal(normalizeDocId("d" + "a".repeat(31)), "");
  assert.equal(normalizeDocId("d" + "a".repeat(33)), "");
  assert.equal(normalizeDocId("_older"), "", "the Older bucket is not reachable by naming it");
  assert.equal(normalizeDocId(null), "");
  assert.equal(normalizeDocId(undefined), "");
  assert.equal(normalizeDocId(12), "");
  assert.equal(normalizeDocId({ toString: () => ID }), "", "an object that looks like one is not one");
});

test("DOC_ID_RE is the same test, exported for the places that need the regex", () => {
  assert.ok(DOC_ID_RE.test(ID));
  assert.ok(!DOC_ID_RE.test("_older"));
  /* Not sticky or global: a regex with /g carries lastIndex between calls,
     and main.js tests one of these per document report. */
  assert.equal(DOC_ID_RE.flags, "");
  assert.ok(DOC_ID_RE.test(ID), "a second test of the same string still passes");
});

/* ---- the browser's verdict ---- */

test("decideDuplicateLoser: the later adopter gives the id up", () => {
  const early = tab({ at: 1000, nonce: "n1", home: "file:a.md" });
  const late = tab({ at: 2000, nonce: "n2", home: "file:b.md" });
  assert.equal(loserBothWays(decideDuplicateLoser, early, late), late);
});

test("decideDuplicateLoser: an exact tie falls to the nonce, not to chance", () => {
  const a = tab({ at: 1000, nonce: "aaa", home: "file:a.md" });
  const b = tab({ at: 1000, nonce: "bbb", home: "file:b.md" });
  assert.equal(loserBothWays(decideDuplicateLoser, a, b), b, "the higher nonce loses");
});

test("decideDuplicateLoser: not every pair is a duplicate", () => {
  /* One tab hearing its own claim come back. */
  assert.equal(decideDuplicateLoser(tab({}), tab({})), null, "same nonce: it is me");
  /* Two views of one file — the name is all a browser tab can compare, so
     this is the same document, not a copy. */
  assert.equal(loserBothWays(decideDuplicateLoser,
    tab({ nonce: "n1" }), tab({ nonce: "n2" })), null, "same home");
  /* Different documents entirely. */
  assert.equal(loserBothWays(decideDuplicateLoser,
    tab({ nonce: "n1" }), tab({ docId: ID2, nonce: "n2", home: "file:b.md" })), null);
});

test("decideDuplicateLoser: an id that is not an id decides nothing", () => {
  assert.equal(decideDuplicateLoser(null, tab({})), null);
  assert.equal(decideDuplicateLoser(tab({}), undefined), null);
  assert.equal(decideDuplicateLoser("claim", tab({})), null);
  assert.equal(loserBothWays(decideDuplicateLoser,
    tab({ docId: "nonsense", nonce: "n1" }),
    tab({ docId: "nonsense", nonce: "n2", home: "file:b.md" })), null,
  "two tabs agreeing on rubbish is not a shared identity");
});

/* ---- the desktop's verdict ---- */

test("chooseDuplicateLoser: the tab that adopted the identity later is the copy", () => {
  const first = claim({ seq: 1, homeKey: "file:c:\\x\\a.md" });
  const second = claim({ seq: 2, homeKey: "file:c:\\x\\b.md" });
  assert.equal(loserBothWays(chooseDuplicateLoser, first, second), second);
});

test("chooseDuplicateLoser: a local file loses to a server document, whatever the seq", () => {
  /* The server copy is the one other people are also editing. */
  const server = claim({ seq: 9, homeKey: "server:host|doc1" });
  const file = claim({ seq: 1, homeKey: "file:c:\\x\\a.md" });
  assert.equal(loserBothWays(chooseDuplicateLoser, server, file), file);
});

test("chooseDuplicateLoser: two server homes on one id are one document", () => {
  assert.equal(loserBothWays(chooseDuplicateLoser,
    claim({ seq: 1, homeKey: "server:host|doc1" }),
    claim({ seq: 2, homeKey: "server:other|doc1" })), null,
  "a server id is shared by design");
});

test("chooseDuplicateLoser: one home, one document, and no id, no verdict", () => {
  assert.equal(loserBothWays(chooseDuplicateLoser, claim({ seq: 1 }), claim({ seq: 2 })), null,
    "the same path open twice is the same document");
  assert.equal(loserBothWays(chooseDuplicateLoser,
    claim({}), claim({ docId: ID2, homeKey: "file:c:\\x\\b.md" })), null);
  assert.equal(chooseDuplicateLoser(null, claim({})), null);
  assert.equal(chooseDuplicateLoser(claim({}), null), null);
  assert.equal(loserBothWays(chooseDuplicateLoser,
    claim({ docId: "" }), claim({ docId: "", homeKey: "file:c:\\x\\b.md" })), null,
  "a tab with no id cannot collide with one");
});

test("chooseDuplicateLoser consults no birthtime — the branch is gone, not off", () => {
  /* The case #76 deleted the rule over: file A was created first and claimed
     the id first (seq 1), but has been SAVED since, and atomicWrite's
     write-a-temp-then-rename moves birthtime forward on NTFS. Trusting
     birthtime would name A — the document the user has been working in — as
     the copy. The seq answers B, and a birthtime in the claim changes
     nothing because nothing reads one. */
  const a = claim({ seq: 1, homeKey: "file:c:\\x\\a.md", birthtimeMs: 2_000_000 });
  const b = claim({ seq: 2, homeKey: "file:c:\\x\\b.md", birthtimeMs: 1_000_000 });
  assert.equal(loserBothWays(chooseDuplicateLoser, a, b), b);
  /* And the same pair with the birthtimes removed answers identically. */
  const bare = (c) => ({ docId: c.docId, homeKey: c.homeKey, seq: c.seq });
  assert.equal(chooseDuplicateLoser(bare(a), bare(b)).seq, 2);
});

/* ---- the replacement identity ---- */

test("duplicateReplacementInput is the exact string both sides hash", () => {
  assert.equal(duplicateReplacementInput(ID, "file:c:\\x\\a.md"),
    "splitpage-dup\n" + ID + "\nfile:c:\\x\\a.md");
  /* The renderer reaches the same bytes as deriveDocId('splitpage-dup',
     fromId + '\n' + home), which is domain + '\n' + text. */
  assert.equal(duplicateReplacementInput(ID, "file:a.md"),
    "splitpage-dup" + "\n" + (ID + "\n" + "file:a.md"));
});

test("docIdFromSha256Hex: 'd' plus the first 32 hex, and nothing else", () => {
  const digest = "0123456789abcdef".repeat(4);
  assert.equal(docIdFromSha256Hex(digest), "d" + "0123456789abcdef".repeat(2));
  assert.ok(DOC_ID_RE.test(docIdFromSha256Hex(digest)), "the result is a usable docId");
});

test("the derived replacement id is FROZEN (invariant #37)", () => {
  /* Pinned vectors. A copy that has not been saved since it was re-id'd must
     get the SAME replacement on every relaunch and from EITHER authority —
     change the input string or the truncation and every such document is
     re-identified and its history splits in two. The same two values come
     out of src/js/02b-doc-id.js's own frozen sha256 (which src/test/
     doc-id.test.mjs pins independently); this is node's crypto reaching them
     the way desktop/main.js does. */
  const derive = (from, home) => docIdFromSha256Hex(
    crypto.createHash("sha256").update(duplicateReplacementInput(from, home), "utf8").digest("hex"));
  assert.equal(derive(ID, "file:c:\\x\\a.md"), "d463f90f8e18c903e9c205ac24871b208");
  assert.equal(derive(ID, "file:/home/u/a.md"), "ded0da7fc4d8b0b62e80b01c07fb23cad");
  /* Different home, different id: that is the whole point — the copy is
     identified by where it lives. */
  assert.notEqual(derive(ID, "file:a.md"), derive(ID, "file:b.md"));
});

test("a require() sees exactly what an import does — this file is CommonJS on purpose", () => {
  const require = createRequire(import.meta.url);
  const cjs = require("../../shared/doc-id-policy.js");
  assert.equal(cjs.chooseDuplicateLoser, chooseDuplicateLoser);
  assert.equal(cjs.decideDuplicateLoser, decideDuplicateLoser);
  assert.equal(cjs.normalizeDocId, normalizeDocId);
  assert.deepEqual(Object.keys(cjs).sort(), [
    "DOC_ID_RE", "chooseDuplicateLoser", "decideDuplicateLoser",
    "docIdFromSha256Hex", "duplicateReplacementInput", "normalizeDocId"
  ]);
});

test("the module needs no DOM, no Electron and no init", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(normalizeDocId(ID), ID);
});
