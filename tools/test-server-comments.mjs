import { createRequire } from "node:module";


const require = createRequire(import.meta.url);
const comments = require("../server/comments.js");
const { htmlTokens, attrValue } = require("../server/html-tokens.js");
const { codePointPrefix } = require("../server/text.js");

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + " — got " + a + ", expected " + e);
  console.log("  FAIL " + name + " — got " + a + ", expected " + e);
}

eq("a code point prefix never splits a surrogate pair", codePointPrefix("a\u{1F600}b", 2), "a\u{1F600}");
eq("an id outside the whitelist is dropped", [comments.commentIdOf("ok_1-x"), comments.commentIdOf("no spaces"), comments.commentIdOf("")], ["ok_1-x", "", ""]);
eq("a name loses tags, controls and trailing space", comments.commentName("<b>Ann</b>\u0001 ", 80), "Ann");
eq("a comment without a row or title target is refused", comments.cleanComment({ id: "c1", body: "x" }, 5, "me"), null);
eq("a comment takes the fallback author and starts unresolved", (() => {
  const c = comments.cleanComment({ id: "c1", rowId: "r1", body: "hi", field: "visualText" }, 5, "me");
  return [c.author, c.resolved, c.anchorId, c.field, c.createdAt, c.kind];
})(), ["me", false, "c1", "visualText", 5, "anchor"]);
eq("a reply without a body is refused", comments.cleanReply({ id: "p1", body: "" }, 5, "me"), null);
eq("html tokens carry names and attributes", htmlTokens('<p class="a">x</p>').map((t) => t.kind + ":" + (t.name || t.text)), ["open:p", "text:x", "close:p"]);
eq("an attribute value is read in any quoting", [attrValue('a="1"', "a"), attrValue("a='2'", "a"), attrValue("a=3", "a")], ["1", "2", "3"]);

const row = { id: "r1", visualText: "<p>hello</p>", audioText: "" };
const state = { rows: [row] };
eq("an anchor whose text matches is stored on the row", [comments.placeAnchor(state, { field: "visualText", rowId: "r1", html: '<p><span class="cmt-anchor" data-cmt="c1">hello</span></p>' }, "c1", "me", 9), row.updatedBy, row.updatedAt], ["ok", "me", 9]);
eq("an anchor over changed text is stale", comments.placeAnchor(state, { field: "visualText", rowId: "r1", html: "<p>other</p>" }, "c2", "me", 10), "stale");
eq("an unknown row is stale and a missing anchor is none", [comments.placeAnchor(state, { field: "visualText", rowId: "zz", html: "x" }, "c3", "me", 1), comments.placeAnchor(state, undefined, "c3", "me", 1)], ["stale", "none"]);
eq("a non-object or wrong-field anchor is bad", [comments.placeAnchor(state, "x", "c", "me", 1), comments.placeAnchor(state, { field: "title", rowId: "r1", html: "" }, "c", "me", 1)], ["bad", "bad"]);

if (failures.length) {
  console.log("\n" + failures.length + " FAILED");
  process.exit(1);
}
console.log("\nALL PASS - " + passed + " server comment checks");
