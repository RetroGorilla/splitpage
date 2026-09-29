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

const tab = (over) => Object.assign({ docId: ID, home: "file:a.md", at: 1000, nonce: "n1" }, over);
const claim = (over) => Object.assign({ docId: ID, homeKey: "file:c:\\x\\a.md", seq: 1 }, over);

function loserBothWays(fn, a, b) {
  const first = fn(a, b);
  const second = fn(b, a);
  assert.equal(first, second, "the verdict is not symmetric");
  return first;
}

test("normalizeDocId accepts the canonical shape and nothing else", () => {
  assert.equal(normalizeDocId(ID), ID);
  assert.equal(normalizeDocId("d" + "0123456789abcdef".repeat(2)), "d" + "0123456789abcdef".repeat(2));
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
  assert.equal(DOC_ID_RE.flags, "");
  assert.ok(DOC_ID_RE.test(ID), "a second test of the same string still passes");
});

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
  assert.equal(decideDuplicateLoser(tab({}), tab({})), null, "same nonce: it is me");
  assert.equal(loserBothWays(decideDuplicateLoser,
    tab({ nonce: "n1" }), tab({ nonce: "n2" })), null, "same home");
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

test("chooseDuplicateLoser: the tab that adopted the identity later is the copy", () => {
  const first = claim({ seq: 1, homeKey: "file:c:\\x\\a.md" });
  const second = claim({ seq: 2, homeKey: "file:c:\\x\\b.md" });
  assert.equal(loserBothWays(chooseDuplicateLoser, first, second), second);
});

test("chooseDuplicateLoser: a local file loses to a server document, whatever the seq", () => {
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
  // atomicWrite rename moves NTFS birthtime; only seq is trusted (#76)
  const a = claim({ seq: 1, homeKey: "file:c:\\x\\a.md", birthtimeMs: 2_000_000 });
  const b = claim({ seq: 2, homeKey: "file:c:\\x\\b.md", birthtimeMs: 1_000_000 });
  assert.equal(loserBothWays(chooseDuplicateLoser, a, b), b);
  const bare = (c) => ({ docId: c.docId, homeKey: c.homeKey, seq: c.seq });
  assert.equal(chooseDuplicateLoser(bare(a), bare(b)).seq, 2);
});

test("duplicateReplacementInput is the exact string both sides hash", () => {
  assert.equal(duplicateReplacementInput(ID, "file:c:\\x\\a.md"),
    "splitpage-dup\n" + ID + "\nfile:c:\\x\\a.md");
  assert.equal(duplicateReplacementInput(ID, "file:a.md"),
    "splitpage-dup" + "\n" + (ID + "\n" + "file:a.md"));
});

test("docIdFromSha256Hex: 'd' plus the first 32 hex, and nothing else", () => {
  const digest = "0123456789abcdef".repeat(4);
  assert.equal(docIdFromSha256Hex(digest), "d" + "0123456789abcdef".repeat(2));
  assert.ok(DOC_ID_RE.test(docIdFromSha256Hex(digest)), "the result is a usable docId");
});

test("the derived replacement id is FROZEN (invariant #37)", () => {
  const derive = (from, home) => docIdFromSha256Hex(
    crypto.createHash("sha256").update(duplicateReplacementInput(from, home), "utf8").digest("hex"));
  assert.equal(derive(ID, "file:c:\\x\\a.md"), "d463f90f8e18c903e9c205ac24871b208");
  assert.equal(derive(ID, "file:/home/u/a.md"), "ded0da7fc4d8b0b62e80b01c07fb23cad");
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
