import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { presentFindRanges } from "./present-ranges.ts";

test("Present search spans formatting and words, preserves Unicode offsets and excludes non-script UI", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const content = win.document.createElement("div");
  content.innerHTML = '<div class="prompter-empty">needle</div><div class="prompter-line"><span class="w">😀Nee</span><strong><span class="w">dle</span></strong> <span class="w">again.</span></div><div class="prompter-line">needle again.</div>';
  try {
    const before = content.innerHTML;
    assert.deepEqual(presentFindRanges(content, "needle again", false).map(range => range.toString()), ["Needle again", "needle again"]);
    assert.deepEqual(presentFindRanges(content, "Needle", true).map(range => range.toString()), ["Needle"]);
    assert.deepEqual(presentFindRanges(content, "😀Nee", true).map(range => range.toString()), ["😀Nee"]);
    assert.equal(presentFindRanges(content, "again.needle", false).length, 0);
    assert.equal(presentFindRanges(content, "", false).length, 0);
    assert.equal(presentFindRanges(content, String.fromCharCode(0xd800), false).length, 0);
    assert.equal(content.innerHTML, before);
  } finally { win.close(); }
});

test("Present search treats punctuation literally and returns non-overlapping matches in reading order", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const content = win.document.createElement("div");
  content.innerHTML = '<div class="prompter-line">a+b a+b aaaa<br>break</div>';
  try {
    assert.deepEqual(presentFindRanges(content, "a+b", false).map(range => range.startOffset), [0, 4]);
    assert.deepEqual(presentFindRanges(content, "aa", false).map(range => range.startOffset), [8, 10]);
    assert.equal(presentFindRanges(content, "aaaabreak", false).length, 0);
  } finally { win.close(); }
});

test("Present search includes displayed tag words and stage directions without editing either", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const content = win.document.createElement("div");
  content.innerHTML = '<div class="prompter-line">Bring <span class="tag-anchor" contenteditable="false">gaffer tape</span> <span class="stage-dir">hold still</span></div>';
  const before = content.innerHTML;
  try {
    assert.equal(presentFindRanges(content, "gaffer tape", false)[0]?.toString(), "gaffer tape");
    assert.equal(presentFindRanges(content, "hold still", false)[0]?.toString(), "hold still");
    assert.equal(content.innerHTML, before);
  } finally { win.close(); }
});
