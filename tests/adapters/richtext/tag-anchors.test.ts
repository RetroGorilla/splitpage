import { test } from "node:test";
import assert from "node:assert/strict";
import { retagTagAnchors } from "../../../src/adapters/richtext/tag-anchors.ts";
import { jsdomParser } from "./jsdom.mjs";

const Parser: new () => DOMParser = jsdomParser();
const bodyOf = (html: string): HTMLElement => new Parser().parseFromString(html, "text/html").body;
const tag = (cat: string, name: string, content: string): string =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}">${content}</span>`;

test("renames matching anchors and preserves their content and other names", () => {
  const body = bodyOf(tag("prop", "Mug", "<em>first</em>") + tag("prop", "Mug", "second") + tag("prop", "Kettle", "other"));
  assert.equal(retagTagAnchors(body, "prop", "mug", "Tea Cup"),
    tag("prop", "Tea Cup", "<em>first</em>") + tag("prop", "Tea Cup", "second") + tag("prop", "Kettle", "other"));
  assert.equal(body.querySelectorAll('[data-tag-name="Tea Cup"]').length, 2);
});

test("unwraps matching anchors while preserving every child and its order", () => {
  const body = bodyOf("before " + tag("prop", "Mug", "a<em>b</em><strong>c</strong>d") + tag("prop", "Mug", "") + " after");
  const child = body.querySelector("em");
  assert.equal(retagTagAnchors(body, "prop", "mug", null), "before a<em>b</em><strong>c</strong>d after");
  assert.equal(body.querySelector("em"), child);
  assert.equal(body.querySelectorAll(".tag-anchor").length, 0);
});

test("leaves other categories and elements without the tag-anchor class untouched", () => {
  const other = tag("gear", "Mug", "gear");
  const plain = '<span data-tag-cat="prop" data-tag-name="Mug">plain</span>';
  for (const toName of ["Cup", null]) {
    const body = bodyOf(tag("prop", "Mug", "prop") + other + plain);
    assert.equal(retagTagAnchors(body, "prop", "mug", toName),
      (toName === null ? "prop" : tag("prop", "Cup", "prop")) + other + plain);
  }
});

test("matches names after trimming, case folding and collapsing whitespace", () => {
  for (const toName of ["New Name", null]) {
    const body = bodyOf(tag("prop", "  TEA\t \nCup  ", "cup"));
    assert.equal(retagTagAnchors(body, "prop", "tea cup", toName),
      toName === null ? "cup" : tag("prop", "New Name", "cup"));
  }
});
