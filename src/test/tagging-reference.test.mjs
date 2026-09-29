import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PLAIN_TAG_KEYWORDS } from "../js/07b-plain-tags.js";

const html = readFileSync(new URL("../page.html", import.meta.url), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");
const card = doc.getElementById("tagging-help");

test("the card lists every name-and-colon keyword the tagger takes, in its category", () => {
  const rows = [...card.querySelectorAll(".tagging-help-words .tagging-help-row")];
  const listed = {};
  rows.forEach((row) => {
    const cat = row.querySelector(".tag-sample").getAttribute("data-tag-cat");
    row.querySelectorAll("code").forEach((c) => {
      const m = /^([A-Za-z]+):$/.exec(c.textContent);
      assert.ok(m, "a keyword and its colon: " + c.textContent);
      const k = m[1].toLowerCase();
      assert.ok(!(k in listed), k + " listed once");
      listed[k] = cat;
    });
  });
  assert.deepEqual(listed, PLAIN_TAG_KEYWORDS);
});

test("each bracket row shows a sample in the category its brackets make", () => {
  const pairs = { "[": "prop", "{": "location", "~": "vfx", "<": "gear" };
  const rows = [...card.querySelectorAll(".tagging-help-list:not(.tagging-help-words):not(.tagging-help-keys) .tagging-help-row")]
    .filter((r) => r.querySelector("code"));
  assert.deepEqual(rows.map((r) => pairs[r.querySelector("code").textContent.charAt(0)]),
    rows.map((r) => r.querySelector(".tag-sample").getAttribute("data-tag-cat")));
  assert.equal(rows.length, 4);
});
