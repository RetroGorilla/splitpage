import { mintTagId } from "../core/document/tags.ts";
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../js/02-state.js";
import { healTagRegistry, productionIndexStats, resetProductionIndexStats } from "../js/07-production-tags.js";
import { productionIndex } from "../legacy/production-index-bridge.ts";
import { currentDocument } from "../legacy/session-bridge.ts";
import { loadTestDocument } from "./_document.mjs";

const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;

function load(over) {
  loadTestDocument(migrateRows(Object.assign({ schema: 2, title: "T", rows: [], comments: [] }, over)));
  resetProductionIndexStats();
}

test("reading the breakdown never writes the registry; healTagRegistry does, without changing what it reads", () => {
  load({ rows: [{ id: "r1", audioText: "Put the " + tag("prop", "kettle") + " on." }] });
  currentDocument().productionTags = [];
  const before = productionIndex().entries(currentDocument());
  assert.deepEqual(before.map((e) => [e.key, e.orphaned, e.status]), [["prop kettle", false, "needed"]]);
  assert.deepEqual(currentDocument().productionTags, [], "a read wrote the registry");

  assert.equal(healTagRegistry(), 1);
  assert.deepEqual(currentDocument().productionTags, [{ id: mintTagId("prop", "kettle"), cat: "prop", name: "kettle", owner: "", notes: "", status: "needed" }]);
  assert.deepEqual(productionIndex().entries(currentDocument()).map((e) => Object.assign({}, e, { id: null })), before);
  assert.equal(productionIndex().entries(currentDocument())[0].id, mintTagId("prop", "kettle"));
  assert.equal(before[0].id, null, "the entry handed out before the heal keeps the id it was handed out with");
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
  productionIndex().entries(currentDocument());
  assert.equal(productionIndexStats().derived, 1);

  currentDocument().rows[0].audioText = "Now put the " + tag("prop", "kettle") + " on, slowly.";
  currentDocument().rows[1].visualText = "Close on the " + tag("location", "kitchen");
  productionIndex().entries(currentDocument());
  productionIndex().entries(currentDocument());
  assert.equal(productionIndexStats().derived, 1);

  currentDocument().rows[0].audioText += " " + tag("prop", "mug");
  assert.ok(productionIndex().entries(currentDocument()).some((e) => e.name === "mug"));
  assert.equal(productionIndexStats().derived, 2);

  currentDocument().productionTags[0].status = "have";
  assert.equal(productionIndex().entries(currentDocument()).find((e) => e.name === "kettle").status, "have");
  assert.equal(productionIndexStats().derived, 3);

  currentDocument().rows.reverse();
  assert.equal(productionIndex().entries(currentDocument()).find((e) => e.name === "kettle").mentions[0].rowIndex, 1);
  assert.equal(productionIndexStats().derived, 4);

  const entries = productionIndex().entries(currentDocument());
  loadTestDocument(JSON.parse(JSON.stringify(currentDocument())));
  assert.deepEqual(productionIndex().entries(currentDocument()).map((e) => e.key), entries.map((e) => e.key));
  assert.equal(productionIndexStats().derived, 5);
});

test("the array a caller gets is its own", () => {
  load({ rows: [{ id: "r1", audioText: tag("prop", "a") + " " + tag("prop", "b") }] });
  const mine = productionIndex().entries(currentDocument());
  mine.reverse();
  mine.push({ key: "junk" });
  assert.deepEqual(productionIndex().entries(currentDocument()).map((e) => e.key), ["prop a", "prop b"]);
});
