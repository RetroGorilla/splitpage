import { mintTagId, registryTagHooks } from "../core/document/tags.ts";
import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { mergeProductionTags, mergeStates } from "../js/03-sync.js";
import { fromHtml, toHtml } from "../js/04c-doc-model.js";
import { ensureTagIds, isTagId, registryEntryById } from "../js/07-production-tags.js";
import { renameTag } from "../application/commands/production-actions.ts";
import { runDocumentEdit, sessionStamps } from "../legacy/session-bridge.ts";
import { retagRewrites } from "../legacy/tag-rewrites.ts";
import { loadTestDocument } from "./_document.mjs";

const span = (cat, name, text) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${text || name}</span>`;
const entry = (cat, name, extra) => Object.assign({ cat, name, owner: "", notes: "", status: "needed" }, extra);

test("an id is minted from the key: same item, same id, whoever mints it", () => {
  const a = mintTagId("prop", "Red mug");
  assert.ok(isTagId(a), a);
  assert.equal(mintTagId("prop", "  red   MUG "), a, "the key normalises case and spacing");
  assert.notEqual(mintTagId("location", "Red mug"), a);
  assert.equal(mintTagId("prop", "Red mug", [{ id: a }]), a + "-2");
  assert.equal(mintTagId("prop", "Red mug", [{ id: a }, { id: a + "-2" }]), a + "-3");
  assert.ok(!isTagId("t:prop:x") && !isTagId("") && !isTagId(null) && !isTagId("t_<x>"));
});

test("ensureTagIds gives every entry a unique valid id, keeping good ones", () => {
  const reg = [entry("prop", "A", { id: "t_keep" }), entry("prop", "B", { id: "t_keep" }), entry("prop", "C", { id: "bad id" }), entry("prop", "D")];
  ensureTagIds(reg);
  assert.equal(reg[0].id, "t_keep");
  assert.equal(reg[1].id, mintTagId("prop", "B"));
  assert.equal(reg[2].id, mintTagId("prop", "C"));
  assert.equal(reg[3].id, mintTagId("prop", "D"));
});

test("migrateRows: every entry, old or back-filled or healed, has an id, and a second pass changes nothing", () => {
  const s = migrateRows({
    schema: 2, title: "T",
    rows: [{ id: "r1", audioText: "Take the " + span("prop", "Kettle") + " to the " + span("location", "Roof") }],
    productionTags: [entry("prop", "Kettle", { owner: "", id: "t_old1" })]
  });
  assert.deepEqual(s.productionTags.map((t) => [t.name, t.id]), [["Kettle", "t_old1"], ["Roof", mintTagId("location", "Roof")]]);
  assert.deepEqual(migrateRows(JSON.parse(JSON.stringify(s))).productionTags, s.productionTags);
  const backFilled = migrateRows({ schema: 2, title: "T", rows: [{ id: "r1", audioText: span("cast", "Ada") }] });
  assert.deepEqual(backFilled.productionTags.map((t) => t.id), [mintTagId("cast", "Ada")]);
});

test("a rename keeps the id, and a rename onto an existing name folds into that entry's id", () => {
  loadTestDocument(migrateRows({
    schema: 2, title: "T",
    rows: [{ id: "r1", audioText: span("prop", "Mug") + " and " + span("prop", "Cup") }]
  }));
  const mugId = S.state.productionTags.find((t) => t.name === "Mug").id;
  const cupId = S.state.productionTags.find((t) => t.name === "Cup").id;
  assert.ok(renameTag("prop", "Mug", "Big mug", { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps }));
  assert.equal(registryEntryById(mugId).name, "Big mug");
  assert.ok(renameTag("prop", "Big mug", "cup", { run: runDocumentEdit, rewrites: retagRewrites, stamps: sessionStamps }));
  assert.equal(registryEntryById(mugId), null);
  assert.equal(registryEntryById(cupId).name, "Cup");
  assert.equal(S.state.productionTags.length, 1);
});

test("merge: a rename on one side and an assignment on the other are one item with both", () => {
  const id = mintTagId("prop", "Mug");
  const base = [entry("prop", "Mug", { id })];
  const mine = [entry("prop", "Coffee mug", { id })];
  const theirs = [entry("prop", "Mug", { id, owner: "p1", status: "have" })];
  assert.deepEqual(mergeProductionTags(base, mine, theirs), [{ id, cat: "prop", name: "Coffee mug", owner: "p1", notes: "", status: "have" }]);
  assert.equal(mergeProductionTags(base, [entry("prop", "A", { id })], [entry("prop", "B", { id })])[0].name, "B");
});

test("merge: deleted on one side and untouched on the other is deleted; renamed on the other is kept", () => {
  const id = mintTagId("prop", "Mug");
  const base = [entry("prop", "Mug", { id })];
  assert.deepEqual(mergeProductionTags(base, [], [entry("prop", "Mug", { id })]), []);
  assert.deepEqual(mergeProductionTags(base, [], [entry("prop", "Cup", { id })]).map((t) => t.name), ["Cup"]);
});

test("merge: two ids for one name fold into one entry, keeping what each side filled in", () => {
  const out = mergeProductionTags([], [entry("prop", "Mug", { id: "t_a", notes: "blue" })],
    [entry("prop", "mug", { id: "t_b", owner: "p1" })]);
  assert.deepEqual(out, [{ id: "t_b", cat: "prop", name: "mug", owner: "p1", notes: "blue", status: "needed" }]);
});

test("merge: an entry an older copy of the app merged without its id still lines up", () => {
  const html = span("prop", "Mug");
  const doc = (tags) => ({ schema: 2, title: "T", rows: [{ id: "r1", visualText: "", audioText: html }], productionTags: tags });
  const base = migrateRows(doc([entry("prop", "Mug")]));
  const mine = migrateRows(doc([entry("prop", "Mug", { notes: "mine" })]));
  const theirs = migrateRows(doc([{ cat: "prop", name: "Mug", owner: "", notes: "", status: "have" }]));
  const merged = mergeStates(base, mine, theirs).merged;
  assert.deepEqual(merged.productionTags, [{ id: mintTagId("prop", "Mug"), cat: "prop", name: "Mug", owner: "", notes: "mine", status: "have" }]);
});

test("registryTagHooks: the document model names a tag by its registry id", () => {
  const reg = ensureTagIds([entry("prop", "Red mug")]);
  const hooks = registryTagHooks(reg);
  const cell = fromHtml("the " + span("prop", "red MUG", "red mug"), hooks);
  assert.equal(cell[1].marks.tag, reg[0].id);
  assert.equal(toHtml(cell, hooks), "the " + span("prop", "Red mug", "red mug"));
  reg[0].name = "Coffee mug";
  assert.equal(toHtml(cell, registryTagHooks(reg)), "the " + span("prop", "Coffee mug", "red mug"));
  const loose = fromHtml(span("prop", "Lamp"), hooks);
  assert.equal(loose[0].marks.tag, "t:prop:Lamp");
  assert.equal(toHtml(loose, hooks), span("prop", "Lamp"));
});
