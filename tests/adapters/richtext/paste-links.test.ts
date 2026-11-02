import test from "node:test";
import assert from "node:assert/strict";
import { cleanPastedHref, cleanPastedLinks } from "../../../src/adapters/richtext/paste-links.ts";
import { adapterWith, fakePorts } from "./fakes.ts";
import { toHtml } from "../../../src/core/text/html.ts";

test("only the approved parameter names are removed, including repeated and encoded names", () => {
  const names = ["utm_source", "utm_medium", "utm_custom", "utm_", "fbclid", "gclid", "mc_eid", "mc_cid", "msclkid", "UTM_SOURCE", "%75tm_source", "fb%63lid"];
  for (const name of names) {
    for (const param of [name, name + "=", name + "=a", name + "=a&" + name + "=b"]) {
      assert.equal(cleanPastedHref("https://e.test/Path?" + param + "#frag"), "https://e.test/Path#frag");
      assert.equal(cleanPastedHref("https://e.test/?a=1&" + param + "&b=%2f+X#frag"), "https://e.test/?a=1&b=%2f+X#frag");
    }
  }
});

test("untouched URL components keep their exact spelling and order", () => {
  const head = "HTTPS://USER:pass@EXAMPLE.COM:443/%7e/utm_source";
  const tail = "b=%2f+X&a=%20&a=2&empty=&flag&nested=https%3A%2F%2Fshop.test%2F%3Futm_source%3Dmail#?utm_source=x";
  assert.equal(cleanPastedHref(head + "?" + tail), head + "?" + tail);
  assert.equal(cleanPastedHref(head + "?utm_source=x&" + tail), head + "?" + tail);
  assert.equal(cleanPastedHref("https://e.test/?utm_source=x&&a=1&"), "https://e.test/?&a=1&");
  assert.equal(cleanPastedHref("https://e.test/?a=1#?utm_source=x"), "https://e.test/?a=1#?utm_source=x");
});

test("recognized signature parameter names preserve the entire signed URL", () => {
  for (const name of ["Signature", "Key-Pair-Id", "Policy", "X-Amz-Signature", "X-Goog-Signature", "%53ignature", "x-goog-signature"]) {
    for (const param of [name, name + "=", name + "=signed%2f+bytes"]) {
      for (const query of [param + "&utm_source=mail&keep=1", "keep=1&utm_source=mail&" + param]) {
        const href = "HTTPS://EXAMPLE.COM:443/%7e?" + query + "#part";
        assert.equal(cleanPastedHref(href), href, href);
        assert.equal(cleanPastedHref(cleanPastedHref(href)), href);
      }
    }
  }
});

test("signature names in paths, values, fragments or longer parameter names do not prevent cleanup", () => {
  const href = "https://e.test/Signature?not_Signature=1&X-Amz-Signature_extra=2&next=Policy&ref=X-Goog-Signature&utm_source=mail#Key-Pair-Id";
  assert.equal(cleanPastedHref(href), href.replace("&utm_source=mail", ""));
});

test("names containing a tracking name and values containing tracking syntax are left alone", () => {
  const href = "https://e.test/utm_source?not_utm_source=1&fbclidx=2&gclid_extra=3&mc_eid_extra=4&msclkid_extra=5&ref=utm_source=x";
  assert.equal(cleanPastedHref(href), href);
});

test("malformed URLs and non-http schemes are unchanged", () => {
  for (const href of [
    "https://[broken/?utm_source=x", "https://?utm_source=x", "https:///bad host/?utm_source=x", "https:///e.test/?utm_source=x",
    "https://e.test:99999/?utm_source=x", "https://e.test/%GG?utm_source=x", "https://e.test/?bad%ZZ=1&utm_source=x",
    "https://e.test/?bad%E0=1&utm_source=x", "https://e.test/\\path?utm_source=x", "https://e.test/\n?utm_source=x",
    "https://e.test/a b?utm_source=x", "/relative?utm_source=x", "//e.test/?utm_source=x",
    "mailto:a@e.test?utm_source=x", "ftp://e.test/?utm_source=x", "javascript:alert(1)?utm_source=x", ""
  ]) assert.equal(cleanPastedHref(href), href, href);
});

test("the paste cleaner changes hrefs alone without mutating input and preserves fixed points", () => {
  const rich = adapterWith(fakePorts());
  const original = rich.decode('<a href="https://e.test/?a=%2f&amp;utm_source=mail#part"><b>Read</b></a>');
  const cell = cleanPastedLinks(original);
  assert.equal(cell[0]?.marks.href, "https://e.test/?a=%2f#part");
  assert.equal(original[0]?.marks.href, "https://e.test/?a=%2f&utm_source=mail#part");
  assert.equal(cell[0]?.marks.b, true);
  assert.equal(cell[0]?.text, "Read");
  assert.deepEqual(cleanPastedLinks(cell), cell);
  const stored = toHtml(cell);
  assert.equal(rich.sanitize(stored), stored);
});

test("cleaning adjacent links leaves a normalized cell", () => {
  const cell = cleanPastedLinks([
    { text: "One", marks: { href: "https://e.test/?utm_source=one" } },
    { text: "Two", marks: { href: "https://e.test/?utm_source=two" } }
  ]);
  assert.deepEqual(cell, [{ text: "OneTwo", marks: { href: "https://e.test/" } }]);
});

test("seeded query permutations preserve unknown bytes and reach a fixed point", () => {
  let seed = 424;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const approved = ["utm_source", "fbclid", "gclid", "mc_eid", "mc_cid", "msclkid"];
  for (let sample = 0; sample < 2000; sample++) {
    const params: string[] = [], kept: string[] = [];
    for (let i = 0, count = next() % 20 + 1; i < count; i++) {
      const tracking = next() % 3 === 0;
      const name = tracking ? approved[next() % approved.length] : "keep" + i;
      const param = name + "=" + ["%2f+X", "utm_source=mail", "", "a%26b%3Dc"][next() % 4];
      params.push(param);
      if (!tracking) kept.push(param);
    }
    const prefix = "HTTPS://EXAMPLE.COM:443/%7e/";
    const href = prefix + "?" + params.join("&") + "#utm_source=fragment";
    const expected = prefix + (kept.length ? "?" + kept.join("&") : "") + "#utm_source=fragment";
    const clean = cleanPastedHref(href);
    assert.equal(clean, expected, "sample " + sample);
    assert.equal(cleanPastedHref(clean), clean);
  }
});
