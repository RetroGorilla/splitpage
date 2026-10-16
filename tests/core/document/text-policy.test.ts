import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  legacyMdToHtml,
  plainName,
  plainText,
  safeHref,
  safeId,
  safeImageSrc,
  storedImageAttributes,
  storedImageHtml,
  storedImageMarkup
} from "../../../src/core/document/text-policy.ts";
import type { StoredImageRef } from "../../../src/core/document/text-policy.ts";
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

test("only a string or a number is text: anything else is empty, and an object with no usable toString or valueOf doesn't throw (#408)", () => {
  const odd: unknown[] = [true, false, [1, "<b>2</b>"], { a: 1 }, JSON.parse('{"toString":1}'), JSON.parse('{"valueOf":null,"toString":null}')];
  for (const v of odd) {
    assert.equal(plainText(v), "", String(typeof v));
    assert.equal(plainName(v), "Anonymous", String(typeof v));
  }
  const ids = countingIds();
  assert.deepEqual(odd.map((v) => safeId(v, "c", ids)), odd.map((_, i) => "c-minted-" + (i + 1)));
  assert.equal(plainText(0), "0");
  assert.equal(plainText(-1.5), "-1.5");
  assert.equal(safeId(0, "c", ids), "0");
});

test("plainName trims what its cut leaves at the end (#406)", () => {
  assert.equal(plainName("x".repeat(79) + " y"), "x".repeat(79));
  assert.equal(plainName("  " + "x".repeat(80) + " y"), "x".repeat(80));
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

test("the stored image tag is written from one attribute list, with the size only when all of it is there", () => {
  const full = { sha256: SHA, width: 640, height: 480, mime: "image/png" };
  assert.deepEqual(storedImageAttributes(full),
    [["class", "comment-img"], ["data-blob", SHA], ["data-w", "640"], ["data-h", "480"], ["data-mime", "image/png"]]);
  assert.equal(storedImageMarkup(full), storedImageHtml(full));
  assert.deepEqual(storedImageAttributes({ sha256: SHA }), [["class", "comment-img"], ["data-blob", SHA]]);
  assert.equal(storedImageMarkup({ sha256: SHA }), '<img class="comment-img" data-blob="' + SHA + '">');
  assert.equal(storedImageMarkup({ sha256: SHA, width: 640, mime: "image/png" }), storedImageMarkup({ sha256: SHA }));
  assert.equal(storedImageMarkup({ sha256: SHA, width: 0, height: 480, mime: "image/png" }), storedImageMarkup({ sha256: SHA }));
});

test("storedImageMarkup escapes every attribute value, so no field can open an attribute or a tag", () => {
  const hostile = `x" onerror="alert('1')" <b>&amp;`;
  const escaped = "x&quot; onerror=&quot;alert('1')&quot; &lt;b&gt;&amp;amp;";
  for (const field of ["sha256", "width", "height", "mime"] as const) {
    const ref = { sha256: SHA, width: 640, height: 480, mime: "image/png", [field]: hostile } as unknown as StoredImageRef;
    const v = { sha256: SHA, width: "640", height: "480", mime: "image/png", [field]: escaped };
    assert.equal(storedImageMarkup(ref),
      '<img class="comment-img" data-blob="' + v.sha256 + '" data-w="' + v.width + '" data-h="' + v.height + '" data-mime="' + v.mime + '">', field);
    assert.equal(storedImageMarkup(ref).split('"').length, 11, field);
    assert.ok(storedImageAttributes(ref).some(([, value]) => value === hostile), field + " stays raw in the attribute list");
  }
  assert.equal(storedImageMarkup({ sha256: hostile }), '<img class="comment-img" data-blob="' + escaped + '">');
});

test("escapeHtml escapes the four characters an attribute or text needs, and nothing else", () => {
  assert.equal(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; 'Jerry'&lt;/a&gt;");
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(undefined), "undefined");
});

test("legacyMdToHtml reads the old markdown and the inline tags it allowed", () => {
  assert.equal(legacyMdToHtml("**b** and *i* and ~~s~~"), "<strong>b</strong> and <em>i</em> and <s>s</s>");
  assert.equal(legacyMdToHtml("<u>under</u> <mark>lit</mark> <STRONG>x</STRONG>"), "<u>under</u> <mark>lit</mark> <strong>x</strong>");
  assert.equal(legacyMdToHtml("a<br/>b<br >c\nd"), "a<br>b<br>c<br>d");
  assert.equal(legacyMdToHtml("<em>open"), "&lt;em&gt;open");
  assert.equal(legacyMdToHtml("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
  assert.equal(legacyMdToHtml("[go](https://x.test/?a=1&b=2)"), '<a href="https://x.test/?a=1&amp;b=2" target="_blank" rel="noopener">go</a>');
  assert.equal(legacyMdToHtml("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
  assert.equal(legacyMdToHtml(null), "");
  assert.equal(legacyMdToHtml(7), "");
});
