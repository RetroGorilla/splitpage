import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

globalThis.location = new URL("https://splitpage.test/index.html?freeze-caches=1");

const { S } = await import("../js/_state.js");
const { migrateRows } = await import("../js/02-state.js");
const { healTagRegistry, productionIndexStats, resetProductionIndexStats } = await import("../js/07-production-tags.js");
const { productionIndex } = await import("../legacy/production-index-bridge.ts");
const { currentDocument } = await import("../legacy/session-bridge.ts");
const { mintTagId } = await import("../core/document/tags.ts");
const { productionReaders } = await import("../legacy/document-ports.ts");
const { TAG_CATEGORIES } = await import("../core/production/looks.ts");
const { cellOf } = await import("../legacy/richtext.ts");
const { cacheSeal, freezeCachesAsked } = await import("../legacy/cache-freeze.ts");
const { deepLock } = await import("../core/document/freeze.ts");
const { runInThisContext } = await import("node:vm");
const sloppyWrite = (body) => runInThisContext("(function (o) { " + body + " })");
const { deriveProductionIndex } = await import("../core/production/tags.ts");
const { seededHealRounds } = await import("./_heal-rounds.mjs");
const { loadTestDocument } = await import("./_document.mjs");

const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const row = (id, audioText, visualText) => ({ id, status: "todo", audioText, visualText });

function load(rows, productionTags) {
  loadTestDocument(migrateRows({ schema: 2, title: "Frozen", docId: "d" + "7".repeat(32), rows, comments: [] }));
  S.state.productionTags = productionTags;
  resetProductionIndexStats();
}

function frozenThrough(value) {
  const seen = new Set();
  const open = [];
  (function walk(v, path) {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (!Object.isFrozen(v)) open.push(path);
    for (const [k, x] of Object.entries(v)) walk(x, path + "." + k);
  })(value, "value");
  return open;
}

test("the flag is read from the page's query: freeze-caches=1 and nothing else turns it on", () => {
  assert.equal(cacheSeal, deepLock);
  assert.equal(freezeCachesAsked("?freeze-caches=1"), true);
  assert.equal(freezeCachesAsked("?wizard=1&freeze-caches=1"), true);
  assert.equal(freezeCachesAsked(""), false);
  assert.equal(freezeCachesAsked("?freeze-caches=0"), false);
  assert.equal(freezeCachesAsked("?freeze-caches"), false);
  assert.equal(freezeCachesAsked("?freeze-caches=true"), false);
});

test("with the flag, the cell reader and every production reader hand out deep-frozen values, and a write throws a TypeError", () => {
  const html = "<strong>Put</strong> the " + tag("prop", "kettle") + " on.<br>B-roll: steam " + tag("prop", "mug") +
    '<br><span class="audio-cue">SFX: whistle</span>';
  const values = {
    cell: cellOf(html),
    tags: productionReaders.tagsInField(html),
    cues: productionReaders.cueNamesInField(html),
    broll: productionReaders.brollInField(html),
    props: productionReaders.brollPropsInField(html)
  };
  for (const [name, value] of Object.entries(values)) {
    assert.ok(value.length > 0, name + " read something");
    assert.deepEqual(frozenThrough(value), [], name + " is frozen all the way down");
    assert.throws(() => { value.push(value[0]); }, TypeError, name);
  }
  assert.throws(() => { values.cell[0].text = "x"; }, TypeError);
  assert.throws(() => { values.cell[0].marks.b = undefined; }, TypeError);
  assert.throws(() => { values.tags[0].name = "x"; }, TypeError);
  assert.throws(() => { values.broll[0].desc = "x"; }, TypeError);
  assert.throws(() => { values.props[0].push("x"); }, TypeError);
  assert.equal(cellOf(html), values.cell);
  assert.equal(productionReaders.tagsInField(html), values.tags);
});

test("with the flag, the index and the entries it presents are deep-frozen, and a write throws a TypeError", () => {
  load([row("r1", "Put the " + tag("prop", "kettle") + " on.", "Wide on the " + tag("location", "kitchen"))],
    [{ id: "t_kettle", cat: "prop", name: "kettle", owner: "", notes: "", status: "needed" }]);
  const entries = productionIndex().entries(currentDocument());
  const index = productionIndex().current(currentDocument());
  assert.deepEqual(frozenThrough(index), []);
  entries.forEach((e) => assert.deepEqual(frozenThrough(e), [], e.key));
  assert.throws(() => { index.entries[0].id = "x"; }, TypeError);
  assert.throws(() => { index.rowSig[1] = "x"; }, TypeError);
  assert.throws(() => { index.unregistered.push({}); }, TypeError);
  assert.throws(() => { entries[0].id = "x"; }, TypeError);
  assert.throws(() => { entries[0].mentions.push({}); }, TypeError);
  entries.reverse();
  entries.push({ key: "junk" });
  assert.deepEqual(productionIndex().entries(currentDocument()).map((e) => e.key), ["prop kettle", "location kitchen"], "the array a caller gets is still its own");
});

test("with the flag, sloppy code's plain assignments, deletes and length writes into a cached value throw too", () => {
  load([row("r1", "Put the " + tag("prop", "kettle") + " on.", "")], []);
  const entry = productionIndex().entries(currentDocument())[0];
  const index = productionIndex().current(currentDocument());
  const cell = cellOf("<b>sloppy</b> probe");
  const writes = [
    [entry, "o.id = 'x';"],
    [entry, "delete o.mentions;"],
    [entry, "o.mentions.length = 0;"],
    [index, "o.rowSig[0] = 'x';"],
    [index, "o.tagSig.length = 3;"],
    [cell, "o[0].text = 'x';"],
    [cell, "delete o[0].marks.b;"]
  ];
  writes.forEach(([target, body]) => assert.throws(() => sloppyWrite(body)(target), TypeError, body));
  assert.equal(productionIndex().entries(currentDocument())[0].id, null);
  assert.equal(cellOf("<b>sloppy</b> probe")[0].text, "sloppy");
});

test("with the flag, the shared tag categories an entry points to are not frozen; the entry holds a locked copy", () => {
  load([row("r1", "Put the " + tag("prop", "kettle") + " on.", "")], []);
  const entry = productionIndex().entries(currentDocument())[0];
  assert.ok(Object.isFrozen(entry.cat));
  assert.deepEqual(entry.cat, TAG_CATEGORIES.find((c) => c.id === "prop"));
  assert.equal(TAG_CATEGORIES.some((c) => Object.isFrozen(c)), false);
});

test("with the flag, prose edits keep the index without writing into it", () => {
  load([row("r1", "Put the " + tag("prop", "kettle") + " on.", "")], []);
  const index = productionIndex().current(currentDocument());
  const sig = JSON.stringify(index);
  S.state.rows[0].audioText = "Now put the " + tag("prop", "kettle") + " on, slowly.";
  assert.doesNotThrow(() => productionIndex().entries(currentDocument()));
  assert.equal(productionIndexStats().derived, 1, "a prose edit re-derived the index");
  assert.equal(JSON.stringify(index), sig, "the index handed out before the edit is unchanged");
  assert.equal(productionIndex().current(currentDocument()).rowSig[2], S.state.rows[0].audioText);
  assert.deepEqual(productionIndex().current(currentDocument()), deriveProductionIndex(S.state, productionReaders));
});

test("with the flag, a heal leaves what it handed out alone, and both views take the new ids (#326)", () => {
  load([row("r1", "Put the " + tag("prop", "kettle") + " on.", "Wide on the " + tag("location", "kitchen"))],
    [{ id: "t_kitchen", cat: "location", name: "kitchen", owner: "", notes: "", status: "have" }]);
  const shown = productionIndex().entries(currentDocument());
  const index = productionIndex().current(currentDocument());
  assert.equal(healTagRegistry(), 1);
  assert.equal(productionIndexStats().derived, 1, "the heal re-derived the index");
  assert.deepEqual(shown.map((e) => [e.key, e.id]), [["location kitchen", "t_kitchen"], ["prop kettle", null]]);
  assert.deepEqual(index.entries.map((e) => e.id), ["t_kitchen", null]);
  assert.equal(index.unregistered.length, 1);
  assert.deepEqual(productionIndex().entries(currentDocument()).map((e) => [e.key, e.id]), [["location kitchen", "t_kitchen"], ["prop kettle", mintTagId("prop", "kettle")]]);
  assert.deepEqual(productionIndex().current(currentDocument()), deriveProductionIndex(S.state, productionReaders));
  assert.deepEqual(frozenThrough(productionIndex().current(currentDocument())), []);
  assert.equal(healTagRegistry(), 0);
});

test("with the flag, seeded heals, edits and second heals throw nothing and both views agree with a fresh derivation (#326, #377)", () => {
  const { healedRounds, retitledRounds, idsMoved, refusedRounds, reorderedHeals } = seededHealRounds(0x35, 80);
  assert.ok(healedRounds >= 30, "only " + healedRounds + " rounds healed anything");
  assert.ok(retitledRounds >= 10, "only " + retitledRounds + " rounds retitled a cue");
  assert.ok(idsMoved >= 10, "only " + idsMoved + " second heals gave an entry a new id");
  assert.ok(refusedRounds >= 30, "only " + refusedRounds + " rounds kept a name the registry refuses");
  assert.ok(reorderedHeals >= 30, "only " + reorderedHeals + " heals moved a refused name after the names they took in");
});
