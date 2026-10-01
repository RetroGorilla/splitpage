import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  deriveDocId,
  docIdEmbeddedIn,
  mediaCommentId,
  mergedDocId,
  sha256Bytes,
  sha256Hex,
  utf8Bytes,
  withPageHead
} from "../../../src/core/document/ids.ts";

const ID_A = "d" + "1".repeat(32);
const ID_B = "d" + "2".repeat(32);
const ID_C = "d" + "3".repeat(32);

const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

const SAMPLES = [
  "",
  "abc",
  "héllo → 日本",
  "😀𝒳𝄞",
  String.fromCharCode(0xd800),
  String.fromCharCode(0xdc00),
  "abc" + String.fromCharCode(0xd83d),
  String.fromCharCode(0xde00) + "abc",
  String.fromCharCode(0xde00, 0xd83d),
  String.fromCharCode(0xd83d) + "😀",
  String.fromCharCode(0x7f, 0x80, 0x7ff, 0x800, 0xffff),
  String.fromCodePoint(0x10000, 0x10ffff),
  String.fromCharCode(0, 1, 0x1f) + "a\r\nb"
];

test("the frozen SHA-256 vectors hold for strings and bytes", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  assert.equal(sha256Hex("日本"), "cf2abf0c5be326cb922a70f8163f91079c4d9aa8655c60ead89ad545c9de2e92");
  assert.equal(sha256Hex("héllo → 日本"), "8e346e7e5984149a3f22192ed3c43eb61cd00558adc16d98b1811913d230696b");
  assert.equal(sha256Bytes(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Bytes(ascii("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno" +
    "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
  assert.equal(sha256Bytes(new Uint8Array(1000000).fill(0x61)),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("utf8Bytes writes a Uint8Array of exactly the UTF-8 bytes, a lone surrogate becoming U+FFFD", () => {
  for (const s of SAMPLES) {
    const bytes = utf8Bytes(s);
    assert.ok(bytes instanceof Uint8Array, JSON.stringify(s));
    assert.deepEqual([...bytes], [...Buffer.from(s, "utf8")], JSON.stringify(s));
  }
  assert.deepEqual([...utf8Bytes("a" + String.fromCharCode(0xd800) + "b")], [0x61, 0xef, 0xbf, 0xbd, 0x62]);
});

test("sha256Hex hashes the UTF-8 bytes, and never needs TextEncoder", () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    get() { throw new Error("core read TextEncoder"); }
  });
  try {
    for (const s of SAMPLES) {
      assert.equal(sha256Hex(s), createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex"), JSON.stringify(s));
    }
  } finally {
    if (had) Object.defineProperty(globalThis, "TextEncoder", had);
  }
});

test("sha256Hex coerces its argument with String()", () => {
  assert.equal(sha256Hex(42), sha256Hex("42"));
  assert.equal(sha256Hex(null), sha256Hex("null"));
  assert.equal(sha256Hex(undefined), sha256Hex("undefined"));
});

test("sha256Bytes takes any array of bytes and every padding boundary", () => {
  for (let n = 0; n <= 130; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    const want = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256Bytes(bytes), want, "length " + n);
    assert.equal(sha256Bytes(Array.from(bytes)), want, "array of length " + n);
  }
});

test("deriveDocId is the frozen, domain-separated id", () => {
  assert.equal(deriveDocId("splitpage-file", "{}"), "d2a0ba3956fe408d5a1dc4b5791283f16");
  assert.equal(deriveDocId("splitpage-file", "{}"), "d" + sha256Hex("splitpage-file\n{}").slice(0, 32));
  assert.notEqual(deriveDocId("splitpage-file", "x"), deriveDocId("splitpage-server-doc", "x"));
  assert.match(deriveDocId("splitpage-dup", ID_A), /^d[0-9a-f]{32}$/);
});

test("docIdEmbeddedIn only says yes to an object carrying a valid id", () => {
  assert.equal(docIdEmbeddedIn({ docId: ID_A }), true);
  assert.equal(docIdEmbeddedIn({ docId: ID_A.toUpperCase() }), false);
  assert.equal(docIdEmbeddedIn({ docId: "../../x" }), false);
  assert.equal(docIdEmbeddedIn({}), false);
  assert.equal(docIdEmbeddedIn(null), false);
  assert.equal(docIdEmbeddedIn(ID_A), false);
  assert.equal(docIdEmbeddedIn(0), false);
});

test("mergedDocId: the side that changed the id wins, theirs when both did", () => {
  const doc = (docId: unknown) => ({ docId });
  assert.equal(mergedDocId(doc(ID_A), doc(ID_A), doc(ID_A)), ID_A);
  assert.equal(mergedDocId(doc(ID_A), doc(ID_B), doc(ID_A)), ID_B);
  assert.equal(mergedDocId(doc(ID_A), doc(ID_A), doc(ID_B)), ID_B);
  assert.equal(mergedDocId(doc(ID_A), doc(ID_B), doc(ID_C)), ID_C);
  assert.equal(mergedDocId(null, doc(ID_B), doc(ID_C)), ID_C);
  assert.equal(mergedDocId(null, doc(ID_B), doc("bad")), ID_B);
  assert.equal(mergedDocId(doc(ID_A), doc("bad"), doc(ID_A)), ID_A);
  assert.equal(mergedDocId(doc(ID_A), doc("bad"), doc("worse")), "");
  assert.equal(mergedDocId(doc(ID_A), null, undefined), "");
});

test("mediaCommentId hashes the row, the field and the media key into a stable comment id", () => {
  const want = "cm" + createHash("sha256").update("splitpage-cell-media\nr1\nvisualText\nimg:" + "a".repeat(64), "utf8").digest("hex").slice(0, 24);
  assert.equal(mediaCommentId("r1", "visualText", "img:" + "a".repeat(64)), want);
  assert.match(want, /^cm[0-9a-f]{24}$/);
  assert.notEqual(mediaCommentId("r1", "audioText", "video:https://x.test"), mediaCommentId("r1", "visualText", "video:https://x.test"));
});

const SHELL = "<!doctype html><html><head>\n<title>Splitpage</title>\n" +
  '<meta name="description" content="old">\n</head><body><title>not this</title></body></html>';

test("withPageHead sets the page title and description on one escaped line, inside the head only", () => {
  assert.equal(withPageHead(SHELL, { title: "  A <b>\n script ", description: 'Says "hi" & more' }),
    "<!doctype html><html><head>\n<title>A &lt;b&gt; script</title>\n" +
    '<meta name="description" content="Says &quot;hi&quot; &amp; more">\n</head><body><title>not this</title></body></html>');
  assert.equal(withPageHead(SHELL, {}), SHELL);
  assert.equal(withPageHead(SHELL, { title: "", description: "" }), SHELL);
  assert.equal(withPageHead("<p>no head</p>", { title: "x" }), "<p>no head</p>");
});

test("withPageHead adds a description after the title when the page has none", () => {
  const bare = "<html><HEAD><TITLE>t</TITLE></HEAD></html>";
  assert.equal(withPageHead(bare, { description: "d" }), '<html><HEAD><TITLE>t</TITLE>\n<meta name="description" content="d"></HEAD></html>');
  assert.equal(withPageHead(bare, { title: "$& $1" }), "<html><HEAD><title>$&amp; $1</title></HEAD></html>");
});
