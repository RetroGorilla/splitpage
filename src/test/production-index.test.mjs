/* The production index (07-production-tags.js, #84): productionEntries()
 * as a pure read of one lazily derived index, and healTagRegistry() as the
 * explicit step that used to be a side effect of that read.
 *
 * Needs a DOM because reading the tags out of a field parses it (see
 * _dom.mjs); needs no page — `S.state` is set directly.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import {
  healTagRegistry,
  mintTagId,
  productionEntries,
  productionIndexStats,
  resetProductionIndexStats
} from "../js/07-production-tags.js";

const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;

function load(over) {
  S.state = migrateRows(Object.assign({ schema: 2, title: "T", rows: [], comments: [] }, over));
  resetProductionIndexStats();
}

test("reading the breakdown never writes the registry; healTagRegistry does, without changing what it reads", () => {
  load({ rows: [{ id: "r1", audioText: "Put the " + tag("prop", "kettle") + " on." }] });
  /* a live tag whose registry entry has gone — a paste from another
     document, a merge — as the running app can meet it */
  S.state.productionTags = [];
  const before = productionEntries();
  assert.deepEqual(before.map((e) => [e.key, e.orphaned, e.status]), [["prop kettle", false, "needed"]]);
  assert.deepEqual(S.state.productionTags, [], "a read wrote the registry");

  assert.equal(healTagRegistry(), 1);
  assert.deepEqual(S.state.productionTags, [{ id: mintTagId("prop", "kettle"), cat: "prop", name: "kettle", owner: "", notes: "", status: "needed" }]);
  /* the same entries, now carrying the id the heal gave the item */
  assert.deepEqual(productionEntries(), before);
  assert.equal(productionEntries()[0].id, mintTagId("prop", "kettle"));
  assert.equal(productionIndexStats().derived, 1, "healing re-derived the index");
  assert.equal(healTagRegistry(), 0);
});

test("the index is kept through prose edits and re-derived by any change to what it reads", () => {
  load({
    rows: [
      { id: "r1", audioText: "Put the " + tag("prop", "kettle") + " on." },
      { id: "r2", visualText: "Wide on the " + tag("location", "kitchen") }
    ]
  });
  productionEntries();
  assert.equal(productionIndexStats().derived, 1);

  /* words around a tag, in either field */
  S.state.rows[0].audioText = "Now put the " + tag("prop", "kettle") + " on, slowly.";
  S.state.rows[1].visualText = "Close on the " + tag("location", "kitchen");
  productionEntries();
  productionEntries();
  assert.equal(productionIndexStats().derived, 1);

  /* a tag added */
  S.state.rows[0].audioText += " " + tag("prop", "mug");
  assert.ok(productionEntries().some((e) => e.name === "mug"));
  assert.equal(productionIndexStats().derived, 2);

  /* a registry field */
  S.state.productionTags[0].status = "have";
  assert.equal(productionEntries().find((e) => e.name === "kettle").status, "have");
  assert.equal(productionIndexStats().derived, 3);

  /* the rows' order — every mention carries its scene's index */
  S.state.rows.reverse();
  assert.equal(productionEntries().find((e) => e.name === "kettle").mentions[0].rowIndex, 1);
  assert.equal(productionIndexStats().derived, 4);

  /* a different document altogether */
  const entries = productionEntries();
  S.state = JSON.parse(JSON.stringify(S.state));
  assert.deepEqual(productionEntries().map((e) => e.key), entries.map((e) => e.key));
  assert.equal(productionIndexStats().derived, 5);
});

test("the array a caller gets is its own", () => {
  load({ rows: [{ id: "r1", audioText: tag("prop", "a") + " " + tag("prop", "b") }] });
  const mine = productionEntries();
  mine.reverse();
  mine.push({ key: "junk" });
  assert.deepEqual(productionEntries().map((e) => e.key), ["prop a", "prop b"]);
});
