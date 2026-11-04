import test from "node:test";
import assert from "node:assert/strict";
import { numberHtml } from "./number-html.ts";

test("number markup tightens every dot and escapes text", () => {
  assert.equal(numberHtml("B.8.2"), 'B<span class="number-dot">.</span>8<span class="number-dot">.</span>2');
  assert.equal(numberHtml('<a>"&'), "&lt;a&gt;&quot;&amp;");
});
