/* Document identity (02b-doc-id.js): the hash, the derivations built on
 * it, the ingress rules and the duplicate verdict.
 *
 * Ported from the pure half of tests/22-doc-id.txt, which drove these
 * through window.__splitpageFormats.sha256Hex / .deriveDocId / .mergedDocId
 * / .decideDuplicateLoser (#67). What stays in that browser suite is
 * everything with a page behind it: the Save As fork, reassignDocId's
 * "never writes the user's file" guarantee, the BroadcastChannel duplicate
 * flow and every id assertion made about a real File > Open.
 *
 * HANDOFF invariant #37: sha256Hex and deriveDocId are FROZEN. A legacy
 * file with no id of its own gets one derived from its content, and a
 * duplicate copy gets a replacement derived the same way — so any change
 * to the output re-identifies every such document and splits its version
 * history in two on the next open. The vectors below are the pin.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideDuplicateLoser,
  deriveDocId,
  docIdEmbeddedIn,
  mergedDocId,
  migrateDocument,
  normalizeDocId,
  sha256Hex
} from "../js/02b-doc-id.js";
import { migrateRows } from "../js/02-state.js";

const ID_A = "d" + "1".repeat(32);
const ID_B = "d" + "2".repeat(32);
const ID_C = "d" + "3".repeat(32);
const ID_D = "d" + "4".repeat(32);

test("SHA-256 vectors (FROZEN, HANDOFF invariant #37)", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  /* The standard 56-byte vector, which straddles the padding boundary the
     hand-written block loop gets wrong first if it is ever touched. */
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  /* Non-ASCII: the hash is over UTF-8 BYTES, and this file's own encoder
     has to agree with TextEncoder byte for byte, or the same document gets
     two ids depending on which browser opened it. Vectors taken from
     node:crypto, which is a third opinion rather than a restatement of
     either. */
  assert.equal(sha256Hex("日本"),
    "cf2abf0c5be326cb922a70f8163f91079c4d9aa8655c60ead89ad545c9de2e92");
  assert.equal(sha256Hex("héllo → 日本"),
    "8e346e7e5984149a3f22192ed3c43eb61cd00558adc16d98b1811913d230696b");
  /* A lone surrogate: encoded as U+FFFD, the way TextEncoder does it. */
  assert.equal(sha256Hex("a\ud800b"), sha256Hex("a\ufffdb"));
});

test("deriveDocId is the frozen, domain-separated wrapper", () => {
  /* Golden value recorded from the implementation (22-doc-id.txt). */
  assert.equal(deriveDocId("splitpage-file", "{}"), "d2a0ba3956fe408d5a1dc4b5791283f16");
  assert.equal(deriveDocId("splitpage-file", "{}"), "d" + sha256Hex("splitpage-file\n{}").slice(0, 32));
  /* Domain separation: the same text under two domains must never collide,
     or a file whose content happens to read like a server id would inherit
     that server document's history. */
  assert.notEqual(deriveDocId("splitpage-file", "x"), deriveDocId("splitpage-server-doc", "x"));
  assert.notEqual(deriveDocId("splitpage-file", "x"), deriveDocId("splitpage-dup", "x"));
  assert.match(deriveDocId("splitpage-dup", ID_A + "\nfile:a.md"), /^d[0-9a-f]{32}$/);
});

test("normalizeDocId treats anything but the canonical shape as absent", () => {
  /* Never trimmed, lower-cased or otherwise repaired: the desktop builds a
     folder name out of this. */
  assert.equal(normalizeDocId(ID_A), ID_A);
  assert.equal(normalizeDocId("../../x"), "");
  assert.equal(normalizeDocId(("d" + "a".repeat(32)).toUpperCase()), "");
  assert.equal(normalizeDocId(" " + ID_A), "");
  assert.equal(normalizeDocId(ID_A + "0"), "");
  assert.equal(normalizeDocId("d" + "1".repeat(31)), "");
  assert.equal(normalizeDocId(42), "");
  assert.equal(normalizeDocId(null), "");
  assert.equal(normalizeDocId("<img>"), "");
});

test("a hostile or missing id is re-minted; a valid one is kept", () => {
  /* Ported verbatim from 22-doc-id.txt's h() cases, which cloned the live
     state; the id rule has nothing to do with which document it is. */
  const h = (v) => migrateRows({ title: "T", rows: [], docId: v }).docId;
  for (const hostile of ["../../x", ("d" + "a".repeat(32)).toUpperCase(), 42, "<img>", "", null]) {
    const out = h(hostile);
    assert.match(out, /^d[0-9a-f]{32}$/, "re-minted from " + JSON.stringify(hostile));
    assert.notEqual(out, hostile);
  }
  assert.equal(h("d" + "0".repeat(32)), "d" + "0".repeat(32));
});

test("docIdEmbeddedIn only says yes to a valid id", () => {
  assert.equal(docIdEmbeddedIn({ docId: ID_A }), true);
  assert.equal(docIdEmbeddedIn({ docId: "../../x" }), false);
  assert.equal(docIdEmbeddedIn({}), false);
  assert.equal(docIdEmbeddedIn(null), false);
});

test("migrateDocument derives a file's id from its bytes, not from today's migration", () => {
  /* The same untouched legacy file must get the same id on every open, or
     its history starts over every launch. */
  const raw = { title: "Legacy", rows: [{ id: "r1", audioText: "one" }] };
  const seed = JSON.stringify(raw);
  const out = migrateDocument(JSON.parse(seed), { kind: "file" });
  assert.equal(out.docId, deriveDocId("splitpage-file", seed));
  /* Deterministic, not random. */
  assert.equal(migrateDocument(JSON.parse(seed), { kind: "file" }).docId, out.docId);
  /* One byte different is a different document. */
  const other = { title: "Legacy!", rows: [{ id: "r1", audioText: "one" }] };
  assert.notEqual(migrateDocument(other, { kind: "file" }).docId, out.docId);
});

test("migrateDocument keeps an id the file already carries", () => {
  const out = migrateDocument({ docId: ID_A, title: "T", rows: [] }, { kind: "file" });
  assert.equal(out.docId, ID_A);
});

test("migrateDocument's server origin: the known id wins, then the derived one", () => {
  const known = migrateDocument({ title: "T", rows: [] },
    { kind: "server", serverId: "srv-1", fallbackId: ID_B });
  assert.equal(known.docId, ID_B);

  const derived = migrateDocument({ title: "T", rows: [] }, { kind: "server", serverId: "srv-1" });
  assert.equal(derived.docId, deriveDocId("splitpage-server-doc", "srv-1"));

  /* No server id to derive from means no shared name to agree on: keep the
     random id rather than letting every such document collide on hash(""). */
  const nothing = migrateDocument({ title: "T", rows: [] }, { kind: "server" });
  assert.match(nothing.docId, /^d[0-9a-f]{32}$/);
  assert.notEqual(nothing.docId, deriveDocId("splitpage-server-doc", ""));
});

test("migrateDocument with nothing to derive from keeps migrateRows' random id", () => {
  const a = migrateDocument({ title: "T", rows: [] }, { kind: "fresh" });
  const b = migrateDocument({ title: "T", rows: [] }, { kind: "fresh" });
  assert.match(a.docId, /^d[0-9a-f]{32}$/);
  assert.notEqual(a.docId, b.docId);
});

test("mergedDocId truth table", () => {
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_A }, { docId: ID_A }), ID_A);
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_A }, { docId: ID_D }), ID_D);
  /* Only I moved off base — a Save As fork I just made is the newer identity. */
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_D }, { docId: ID_A }), ID_D);
  assert.equal(mergedDocId(null, { docId: ID_A }, { docId: ID_B }), ID_B);
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_B }, { docId: ID_C }), ID_C);
});

test("mergedDocId never lets an invalid side win over a valid one", () => {
  /* An empty result makes migrateRows mint a random id, splitting the
     history — so a junk value on one side must lose to a real id. */
  assert.equal(mergedDocId(null, { docId: ID_A }, { docId: "../../x" }), ID_A);
  assert.equal(mergedDocId(null, { docId: "../../x" }, { docId: ID_B }), ID_B);
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_A }, { docId: null }), ID_A);
  assert.equal(mergedDocId(null, {}, {}), "");
});

test("decideDuplicateLoser: pure, and symmetric", () => {
  const claim = (over) => Object.assign({ docId: ID_A, home: "file:a.md", at: 100, nonce: "n1" }, over);

  /* The later adopter loses: the earlier one has had the id longer. */
  assert.equal(decideDuplicateLoser(claim(), claim({ home: "file:b.md", at: 200, nonce: "n2" })).nonce, "n2");
  /* Different documents are not a duplicate at all. */
  assert.equal(decideDuplicateLoser(claim(), claim({ docId: ID_B, home: "file:b.md", at: 200, nonce: "n2" })), null);
  /* Same home: it is the same document in two tabs, not two copies. */
  assert.equal(decideDuplicateLoser(claim(), claim({ at: 200, nonce: "n2" })), null);
  /* Same nonce: this page hearing its own claim back. */
  assert.equal(decideDuplicateLoser(claim({ nonce: "nX" }), claim({ home: "file:b.md", nonce: "nX" })), null);
  /* A tie on `at` falls to the nonce, so both tabs reach the same verdict. */
  assert.equal(decideDuplicateLoser(claim({ nonce: "aaa" }), claim({ home: "file:b.md", nonce: "bbb" })).nonce, "bbb");

  /* Symmetry, stated as the property rather than as one example: whichever
     order the two claims arrive in, the same claim has to give up its id —
     or both tabs re-id, or neither does. */
  const a = claim({ nonce: "aaa" }), b = claim({ home: "file:b.md", at: 200, nonce: "bbb" });
  assert.equal(decideDuplicateLoser(a, b), decideDuplicateLoser(b, a));

  assert.equal(decideDuplicateLoser(null, claim()), null);
  assert.equal(decideDuplicateLoser(claim(), "not an object"), null);
});
