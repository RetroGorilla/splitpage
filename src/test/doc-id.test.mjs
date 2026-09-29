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
  sha256Bytes,
  sha256Hex
} from "../js/02b-doc-id.js";
import { createHash } from "node:crypto";
import { migrateRows } from "../js/02-state.js";

const ID_A = "d" + "1".repeat(32);
const ID_B = "d" + "2".repeat(32);
const ID_C = "d" + "3".repeat(32);
const ID_D = "d" + "4".repeat(32);

test("SHA-256 vectors (FROZEN, HANDOFF invariant #37)", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  assert.equal(sha256Hex("日本"),
    "cf2abf0c5be326cb922a70f8163f91079c4d9aa8655c60ead89ad545c9de2e92");
  assert.equal(sha256Hex("héllo → 日本"),
    "8e346e7e5984149a3f22192ed3c43eb61cd00558adc16d98b1811913d230696b");
  assert.equal(sha256Hex("a\ud800b"), sha256Hex("a\ufffdb"));
});

test("sha256Bytes: the NIST FIPS 180-2 byte vectors (#82, image content addresses)", () => {
  const bytes = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  assert.equal(sha256Bytes(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Bytes(bytes("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Bytes(bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  assert.equal(sha256Bytes(bytes("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno" +
    "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
  // Whole blocks straight from caller array, padding-only tail
  assert.equal(sha256Bytes(new Uint8Array(1000000).fill(0x61)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("sha256Bytes agrees with node:crypto at every padding boundary, and on views", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  for (let n = 0; n <= 200; n++) {
    const b = new Uint8Array(n).map(rnd);
    assert.equal(sha256Bytes(b), createHash("sha256").update(b).digest("hex"), "length " + n);
  }
  const big = new Uint8Array(300).map(rnd);
  // View hashes only its own bytes, not the buffer
  const view = big.subarray(37, 37 + 150);
  assert.equal(sha256Bytes(view), createHash("sha256").update(view).digest("hex"));
  assert.equal(sha256Bytes(Array.from(view)), sha256Bytes(view));
});

test("sha256Hex is sha256Bytes over UTF-8 — the split changed no string's hash", () => {
  for (const s of ["", "abc", "日本", "héllo → 日本", "x".repeat(1000), "splitpage-file\n{}"]) {
    assert.equal(sha256Hex(s), sha256Bytes(new TextEncoder().encode(s)), JSON.stringify(s));
    assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"));
  }
});

test("deriveDocId is the frozen, domain-separated wrapper", () => {
  assert.equal(deriveDocId("splitpage-file", "{}"), "d2a0ba3956fe408d5a1dc4b5791283f16");
  assert.equal(deriveDocId("splitpage-file", "{}"), "d" + sha256Hex("splitpage-file\n{}").slice(0, 32));
  assert.notEqual(deriveDocId("splitpage-file", "x"), deriveDocId("splitpage-server-doc", "x"));
  assert.notEqual(deriveDocId("splitpage-file", "x"), deriveDocId("splitpage-dup", "x"));
  assert.match(deriveDocId("splitpage-dup", ID_A + "\nfile:a.md"), /^d[0-9a-f]{32}$/);
});

test("normalizeDocId treats anything but the canonical shape as absent", () => {
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
  const raw = { title: "Legacy", rows: [{ id: "r1", audioText: "one" }] };
  const seed = JSON.stringify(raw);
  const out = migrateDocument(JSON.parse(seed), { kind: "file" });
  assert.equal(out.docId, deriveDocId("splitpage-file", seed));
  assert.equal(migrateDocument(JSON.parse(seed), { kind: "file" }).docId, out.docId);
  const other = { title: "Legacy!", rows: [{ id: "r1", audioText: "one" }] };
  assert.notEqual(migrateDocument(other, { kind: "file" }).docId, out.docId);
});

test("a legacy file with a picture keeps its id: the seed is read before the image is interned (#82)", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const seed = JSON.stringify({ title: "Legacy", rows: [{ id: "r1", audioText: "one", visualImage: png }] });
  const out = migrateDocument(JSON.parse(seed), { kind: "file" });
  assert.equal(out.docId, deriveDocId("splitpage-file", seed));
  assert.ok(out.rows[0].imageRef && !("visualImage" in out.rows[0]), "and the picture did become a ref");
  const refSeed = JSON.stringify(out.rows[0].imageRef);
  assert.notEqual(deriveDocId("splitpage-file", seed.replace('"visualImage":"' + png + '"', '"imageRef":' + refSeed)), out.docId);
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
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_D }, { docId: ID_A }), ID_D);
  assert.equal(mergedDocId(null, { docId: ID_A }, { docId: ID_B }), ID_B);
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_B }, { docId: ID_C }), ID_C);
});

test("mergedDocId never lets an invalid side win over a valid one", () => {
  assert.equal(mergedDocId(null, { docId: ID_A }, { docId: "../../x" }), ID_A);
  assert.equal(mergedDocId(null, { docId: "../../x" }, { docId: ID_B }), ID_B);
  assert.equal(mergedDocId({ docId: ID_A }, { docId: ID_A }, { docId: null }), ID_A);
  assert.equal(mergedDocId(null, {}, {}), "");
});

test("decideDuplicateLoser: pure, and symmetric", () => {
  const claim = (over) => Object.assign({ docId: ID_A, home: "file:a.md", at: 100, nonce: "n1" }, over);

  assert.equal(decideDuplicateLoser(claim(), claim({ home: "file:b.md", at: 200, nonce: "n2" })).nonce, "n2");
  assert.equal(decideDuplicateLoser(claim(), claim({ docId: ID_B, home: "file:b.md", at: 200, nonce: "n2" })), null);
  assert.equal(decideDuplicateLoser(claim(), claim({ at: 200, nonce: "n2" })), null);
  assert.equal(decideDuplicateLoser(claim({ nonce: "nX" }), claim({ home: "file:b.md", nonce: "nX" })), null);
  assert.equal(decideDuplicateLoser(claim({ nonce: "aaa" }), claim({ home: "file:b.md", nonce: "bbb" })).nonce, "bbb");

  const a = claim({ nonce: "aaa" }), b = claim({ home: "file:b.md", at: 200, nonce: "bbb" });
  assert.equal(decideDuplicateLoser(a, b), decideDuplicateLoser(b, a));

  assert.equal(decideDuplicateLoser(null, claim()), null);
  assert.equal(decideDuplicateLoser(claim(), "not an object"), null);
});
