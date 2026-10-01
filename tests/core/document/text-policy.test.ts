import { test } from "node:test";
import assert from "node:assert/strict";
import { plainName, plainText, safeHref, safeId, safeImageSrc, storedImageHtml } from "../../../src/core/document/text-policy.ts";
import type { IdSource } from "../../../src/core/document/ports.ts";

const SHA = "ab".repeat(32);
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

function countingIds(): IdSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    id(prefix) { asked.push(prefix); return prefix + "-minted-" + asked.length; },
    docId() { return "d" + "0".repeat(32); }
  };
}

test("safeImageSrc keeps only base64 data URLs of the raster types", () => {
  for (const type of ["png", "jpeg", "jpg", "gif", "webp"]) {
    const src = "data:image/" + type + ";base64,iVBORw0K Gg==";
    assert.equal(safeImageSrc(src), src, type);
  }
  assert.equal(safeImageSrc("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(safeImageSrc("data:image/png;base64,abc!"), null);
  assert.equal(safeImageSrc("DATA:image/png;base64,abc"), null);
  assert.equal(safeImageSrc("https://example.com/a.png"), null);
  assert.equal(safeImageSrc(null), null);
  assert.equal(safeImageSrc(42), null);
});

test("safeHref keeps http, https and mailto links and refuses script and data URLs, past control characters", () => {
  assert.equal(safeHref("  https://example.com/a?b=c  "), "https://example.com/a?b=c");
  assert.equal(safeHref("HTTP://example.com"), "HTTP://example.com");
  assert.equal(safeHref("mailto:someone@example.com"), "mailto:someone@example.com");
  assert.equal(safeHref("MAILTO:someone@example.com"), null);
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("java" + NUL + "script:alert(1)"), null);
  assert.equal(safeHref("java" + TAB + "script:alert(1)"), null);
  assert.equal(safeHref(" JavaScript:alert(1)"), null);
  assert.equal(safeHref("vbscript:msgbox(1)"), null);
  assert.equal(safeHref("data:text/html,<b>x</b>"), null);
  assert.equal(safeHref("/relative/path"), null);
  assert.equal(safeHref("ftp://example.com"), null);
  assert.equal(safeHref(undefined), null);
});

test("plainText drops tags and the C0 controls other than tab, line feed and carriage return", () => {
  assert.equal(plainText("<b>bold</b> and <i>it</i>"), "bold and it");
  const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("");
  assert.equal(plainText("a" + controls + "b"), "a\t\n\rb");
  assert.equal(plainText(String.fromCharCode(0x7f, 0xa0)), String.fromCharCode(0x7f, 0xa0));
  assert.equal(plainText(null), "");
  assert.equal(plainText(undefined), "");
  assert.equal(plainText(12), "12");
});

test("plainName is trimmed plain text of at most 80 characters, else Anonymous", () => {
  assert.equal(plainName("  <b>Sam</b>  "), "Sam");
  assert.equal(plainName("x".repeat(81)), "x".repeat(80));
  assert.equal(plainName("   "), "Anonymous");
  assert.equal(plainName(null), "Anonymous");
});

test("safeId keeps a cleaned id and asks the id source only when nothing is left", () => {
  const ids = countingIds();
  assert.equal(safeId("r1", "r", ids), "r1");
  assert.equal(safeId("a b<c>_-9", "r", ids), "abc_-9");
  assert.equal(safeId(7, "r", ids), "7");
  assert.deepEqual(ids.asked, []);
  assert.equal(safeId("", "c", ids), "c-minted-1");
  assert.equal(safeId(null, "bs", ids), "bs-minted-2");
  assert.equal(safeId("<>", "rp", ids), "rp-minted-3");
  assert.deepEqual(ids.asked, ["c", "bs", "rp"]);
});

test("storedImageHtml is the stored image tag of a valid reference, and nothing otherwise", () => {
  assert.equal(storedImageHtml({ sha256: SHA, width: 640, height: 480, mime: "image/png" }),
    '<img class="comment-img" data-blob="' + SHA + '" data-w="640" data-h="480" data-mime="image/png">');
  assert.equal(storedImageHtml({ sha256: SHA, width: 1, height: 1048576, mime: "image/webp", extra: "x" }),
    '<img class="comment-img" data-blob="' + SHA + '" data-w="1" data-h="1048576" data-mime="image/webp">');
  assert.equal(storedImageHtml({ sha256: SHA, width: 640, height: 480 }), "");
  assert.equal(storedImageHtml({ sha256: SHA.toUpperCase(), width: 640, height: 480, mime: "image/png" }), "");
  assert.equal(storedImageHtml({ sha256: SHA, width: 0, height: 480, mime: "image/png" }), "");
  assert.equal(storedImageHtml({ sha256: SHA, width: 640, height: 480, mime: "image/svg+xml" }), "");
  assert.equal(storedImageHtml(null), "");
  assert.equal(storedImageHtml([SHA]), "");
});
