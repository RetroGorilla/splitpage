import { test } from "node:test";
import assert from "node:assert/strict";
import { projection } from "../../../src/core/text/runs.ts";
import { adapterWith, fakePorts } from "./fakes.ts";

const rt = adapterWith(fakePorts());
const GRIN = "\u{1F600}";
const x = (n: number): string => "x".repeat(n);
const tagged = (name: string, inner: string): string =>
  `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="${name}" contenteditable="false">${inner}</span>`;

test("a stored tag name is cut by code point, so an emoji across 80 stays whole (#344)", () => {
  assert.equal(rt.sanitize(tagged(x(79) + GRIN + "z", "mug")), tagged(x(79) + GRIN, "mug"));
  assert.equal(rt.sanitize(tagged(x(79) + " y", "mug")), tagged(x(79), "mug"));
});

test("a stored tag name loses a half left by an earlier cut (#344)", () => {
  assert.equal(rt.sanitize(tagged(x(79) + "\uD83D", "mug")), tagged(x(79), "mug"));
});

test("stored text holds no lone surrogate, so the cell and its reading agree on every position (#344)", () => {
  assert.equal(rt.sanitize("a\uD83Db \uDE00c " + GRIN), "ab c " + GRIN);
  assert.equal(rt.sanitize("<b>\uD83D</b>x"), "<strong></strong>x");
  assert.equal(rt.sanitize("a\uD83D<!-- gone -->\uDE00b"), "a" + GRIN + "b", "a pair split only by dropped markup is whole again");
  for (const html of ["x\uD800y \uDC00z <b>\uD83D</b>", "a\uD83D<!-- gone -->\uDE00b", tagged(x(79) + "\uD83D", "m\uDE00ug")]) {
    const stored = rt.sanitize(html);
    assert.equal(rt.sanitize(stored), stored, "the stored form is its own fixed point");
    assert.equal(projection(rt.decode(stored)), projection(rt.decode(html)));
    assert.equal(projection(rt.decode(stored)), rt.inertBody(stored).textContent, "the reading of a cell is its text");
  }
});
