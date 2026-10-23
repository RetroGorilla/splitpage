import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml } from "../js/04-richtext.js";
import { cellOf } from "../legacy/richtext.ts";
import { projection } from "../core/text/runs.ts";
import { bulkTagCell } from "../js/07-production-tags.js";
import { bulkTagRows } from "../application/commands/bulk-tags.ts";
import { loadTestDocument } from "./_document.mjs";

loadTestDocument({ rows: [], productionTags: [] });

const KEY = '<span class="broll-key" data-broll-id="b1" contenteditable="false">B-roll:</span>';
const tagSpan = (cat, name, words) =>
  '<span class="tag-anchor" data-tag-cat="' + cat + '" data-tag-name="' + name + '" contenteditable="false">' + words + "</span>";

test("every whole-word mention is tagged, keeping its own casing", () => {
  const res = bulkTagCell("A drone, the Drone and drones.", "drone", "gear", "drone", false, false);
  assert.equal(res.hits, 2);
  assert.equal(res.html,
    "A " + tagSpan("gear", "drone", "drone") + ", the " + tagSpan("gear", "drone", "Drone") + " and drones.");
  assert.equal(sanitizeHtml(res.html), res.html);
});

test("whole words only: tape never inside tapestry", () => {
  const res = bulkTagCell("tapestry, tape, retape", "tape", "prop", "tape", false, false);
  assert.equal(res.hits, 1);
  assert.equal(res.skipped, 0);
  assert.equal(res.inTags, 0);
});

test("Aa narrows to the exact case", () => {
  const res = bulkTagCell("Drone drone DRONE", "Drone", "gear", "Drone", true, true);
  assert.equal(res.hits, 1);
  assert.equal(res.skipped, 0);
});

test("already tagged mentions are counted, not tagged again", () => {
  const html = tagSpan("gear", "drone", "drone") + " and a drone";
  const res = bulkTagCell(html, "drone", "gear", "drone", false, false);
  assert.equal(res.hits, 1);
  assert.equal(res.inTags, 1);
  assert.equal((res.html.match(/tag-anchor/g) || []).length, 2);
});

test("a match across formatting is one tag; the bold stays; the markup is sound", () => {
  const res = bulkTagCell("a dr<strong>one</strong> here", "drone", "gear", "drone", false, false);
  assert.equal(res.hits, 1);
  assert.equal((res.html.match(/tag-anchor/g) || []).length, 1);
  assert.match(res.html, /<strong>one<\/strong>/);
  assert.equal(projection(cellOf(res.html)), "a drone here");
  assert.equal(sanitizeHtml(res.html), res.html);
});

test("across a b-roll key, a link or a comment's edge is skipped and counted", () => {
  assert.deepEqual(
    (({ hits, skipped }) => ({ hits, skipped }))(bulkTagCell('<a href="https://e.x/">drone</a> drone', "drone", "gear", "drone", false, false)),
    { hits: 1, skipped: 1 });
  const edge = bulkTagCell('red <span class="cmt-anchor" data-cmt="c1">mug</span>', "red mug", "prop", "red mug", false, true);
  assert.equal(edge.hits, 0);
  assert.equal(edge.skipped, 1);
  const key = bulkTagCell("drone " + KEY + " drone", "drone", "gear", "drone", false, true);
  assert.equal(key.hits, 2);
});

test("count only changes nothing; an empty needle does nothing", () => {
  const html = "drone drone";
  assert.deepEqual(bulkTagCell(html, "drone", "gear", "drone", false, true), { hits: 2, inTags: 0, skipped: 0, html });
  assert.deepEqual(bulkTagCell(html, "   ", "gear", "", false, false), { hits: 0, inTags: 0, skipped: 0, html });
});

test("bulkTagRows: the Visual column only, changed rows stamped, the rest untouched", () => {
  const rows = [
    { id: "a", visualText: "A drone shot.", audioText: "The drone hums." },
    { id: "b", visualText: "No match here.", audioText: "" },
    { id: "c", visualText: tagSpan("gear", "drone", "Drone") + " again, drone", audioText: "" }
  ];
  const before = JSON.parse(JSON.stringify(rows));
  const counted = bulkTagRows(rows, "drone", "gear", "drone", false, true);
  assert.deepEqual(counted, { hits: 2, inTags: 1, skipped: 0 });
  assert.deepEqual(rows, before);
  const done = bulkTagRows(rows, "drone", "gear", "drone", false, false);
  assert.deepEqual(done, { hits: 2, inTags: 1, skipped: 0 });
  assert.equal(rows[0].audioText, "The drone hums.");
  assert.match(rows[0].visualText, /tag-anchor/);
  assert.ok(rows[0].updatedAt);
  assert.deepEqual(rows[1], before[1]);
  assert.ok(rows[2].updatedAt);
  assert.deepEqual(bulkTagRows(rows, "drone", "gear", "drone", false, true), { hits: 0, inTags: 3, skipped: 0 });
});
