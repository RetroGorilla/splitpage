import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import {
  currentProductionIndex,
  healTagRegistry,
  mintTagId,
  productionEntries,
  productionReaders,
  registerProductionTag,
  renameTag
} from "../js/07-production-tags.js";
import { __init as initBroll, brollEntries, newBrollRecord, updateBrollBadge } from "../js/08c-broll.js";
import { htmlToPlainText } from "../js/14-export.js";
import { brollEntries as readBrollEntries } from "../core/production/broll.ts";

initBroll();

const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const row = (id, audioText, visualText) => ({ id, status: "todo", audioText, visualText });
const shot = (id, name, extra) => Object.assign({
  id, name, desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "script"
}, extra || {});

function load(over) {
  S.state = migrateRows(Object.assign({ schema: 2, title: "Shims", docId: "d" + "6".repeat(32), rows: [], comments: [] }, over));
  return S.state;
}

const countingIds = () => {
  let n = 0;
  return { id: (p) => p + "mint" + String(++n).padStart(4, "0"), docId: () => "d" + "0".repeat(32) };
};

test("registerProductionTag adds a name once per category, whatever its spelling", () => {
  const s = load({ rows: [], productionTags: [] });
  registerProductionTag("prop", "Kettle");
  registerProductionTag("prop", "  kettle ");
  registerProductionTag("prop", "KETTLE");
  registerProductionTag("location", "Kettle");
  assert.deepEqual(s.productionTags.map((t) => [t.cat, t.name]), [["prop", "Kettle"], ["location", "Kettle"]]);
});

test("registerProductionTag refuses a blank or whitespace-only name (#298)", () => {
  const s = load({ rows: [], productionTags: [] });
  for (const name of ["", "   ", "\t\n", " ", "   ", "​", "‌", "‍", "⁠", "­", " ​ ‍⁠­\t ", null, undefined]) {
    registerProductionTag("prop", name);
  }
  assert.deepEqual(s.productionTags, []);
  registerProductionTag("prop", "!!");
  assert.deepEqual(s.productionTags.map((t) => t.name), ["!!"]);
  s.productionTags.length = 0;
  registerProductionTag("prop", " Kettle ");
  assert.deepEqual(s.productionTags.map((t) => t.name), [" Kettle "]);
});

test("renaming a prop renames it on every shot that needs it, not only the first", () => {
  const s = load({
    rows: [row("r1", "", "")],
    productionTags: [{ id: "t_kettle", cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" }],
    brollShots: [
      shot("b1", "steam", { props: [{ id: "t_kettle", name: "Kettle" }] }),
      shot("b2", "pour", { origin: "list" }),
      shot("b3", "whistle", { props: [{ id: "", name: "kettle" }] }),
      shot("b4", "cup", { props: [{ id: "t_kettle", name: "Kettle" }] })
    ]
  });
  assert.ok(renameTag("prop", "Kettle", "Copper kettle"));
  assert.deepEqual(s.brollShots.map((r) => r.props), [
    [{ id: "t_kettle", name: "Copper kettle" }],
    [],
    [{ id: "t_kettle", name: "Copper kettle" }],
    [{ id: "t_kettle", name: "Copper kettle" }]
  ]);
});

test("brollEntries with no argument repairs, as the badge counts through it; true reads only", () => {
  const s = load({
    rows: [row("r1", "Steam rises.", "B-roll: Steam<br>B-roll: The Pour")],
    brollShots: [shot("b_pour", "the pour")]
  });
  assert.deepEqual(brollEntries(true).map((e) => e.name), ["Steam", "The Pour"]);
  assert.deepEqual(s.brollShots.map((r) => [r.id, r.name]), [["b_pour", "the pour"]]);
  brollEntries();
  assert.deepEqual(s.brollShots.map((r) => r.name), ["The Pour", "Steam"]);
  assert.equal(s.brollShots[1].audioRef, "Steam rises.");
});

test("drawing the b-roll badge counts the unshot shots and repairs the record as it does", () => {
  const s = load({ rows: [row("r1", "", "B-roll: Steam<br>B-roll: Hands<br>B-roll: Cup")], brollShots: [shot("b_cup", "cup", { status: "shot" })] });
  const badge = document.createElement("span");
  badge.id = "broll-badge";
  badge.hidden = true;
  document.body.appendChild(badge);
  try {
    updateBrollBadge();
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, "2");
    assert.deepEqual(s.brollShots.map((r) => [r.name, r.status]), [["Cup", "shot"], ["Steam", "unshot"], ["Hands", "unshot"]]);
  } finally {
    badge.remove();
  }
});

test("a shot the core plan creates and one newBrollRecord stores serialise alike, keys in the same order", () => {
  const s = load({ rows: [row("r1", "Waves on the " + tag("location", "Pier") + ".", "B-roll: drone sweep<br>low and slow")] });
  const read = readBrollEntries(s, productionReaders, countingIds(), htmlToPlainText, true);
  assert.equal(read.plan.create.length, 1);
  const planned = read.plan.create[0].shot;
  const { id, name, desc, audioRef, location } = planned;
  const stored = newBrollRecord({ id, name, desc, audioRef, location });
  assert.equal(JSON.stringify(planned), JSON.stringify(stored));
  assert.deepEqual(Object.keys(planned), Object.keys(newBrollRecord({})));
  assert.deepEqual(Object.keys(planned),
    ["id", "name", "desc", "status", "reshoot", "notes", "owner", "audioRef", "location", "props", "origin"]);
});

test("after a heal the cached core index keeps the ids it was derived with, while the entries shown carry the new ones", () => {
  load({ rows: [row("r1", "Put the " + tag("prop", "kettle") + " on.", "")], productionTags: [] });
  S.state.productionTags = [];
  assert.deepEqual(productionEntries().map((e) => e.id), [null]);
  assert.equal(healTagRegistry(), 1);
  assert.deepEqual(productionEntries().map((e) => e.id), [mintTagId("prop", "kettle")]);
  assert.deepEqual(currentProductionIndex().entries.map((e) => e.id), [null]);
  assert.deepEqual(currentProductionIndex().unregistered, []);
});
