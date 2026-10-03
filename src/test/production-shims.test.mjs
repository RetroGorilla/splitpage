import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import {
  currentProductionIndex,
  deletePerson,
  healTagRegistry,
  mintTagId,
  productionEntries,
  productionIndexStats,
  productionReaders,
  registerProductionTag,
  renameTag
} from "../js/07-production-tags.js";
import { deriveProductionIndex } from "../core/production/tags.ts";
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

test("deleting a person clears them as the owner of production items and b-roll shots at once (#305)", () => {
  const s = load({
    rows: [row("r1", "", "")],
    people: [{ id: "p1", name: "Ada" }, { id: "p2", name: "Sam" }],
    productionTags: [
      { id: "t_kettle", cat: "prop", name: "Kettle", owner: "p1", notes: "", status: "needed" },
      { id: "t_ladder", cat: "prop", name: "Ladder", owner: "p2", notes: "", status: "needed" }
    ],
    brollShots: [shot("b1", "steam", { owner: "p1" }), shot("b2", "pour", { owner: "p2" }), shot("b3", "cup")]
  });
  deletePerson("p1");
  assert.deepEqual(s.people.map((p) => p.id), ["p2"]);
  assert.deepEqual(s.productionTags.map((t) => t.owner), ["", "p2"]);
  assert.deepEqual(s.brollShots.map((b) => b.owner), ["", "p2", ""]);
  const reloaded = migrateRows(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(reloaded.brollShots.map((b) => b.owner), s.brollShots.map((b) => b.owner), "the next load changes nothing more");
  assert.deepEqual(reloaded.productionTags.map((t) => t.owner), s.productionTags.map((t) => t.owner));
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

test("after a heal the cached core index carries the new ids, as the entries shown do (#326)", () => {
  load({ rows: [row("r1", "Put the " + tag("prop", "kettle") + " on.", "")], productionTags: [] });
  S.state.productionTags = [];
  assert.deepEqual(productionEntries().map((e) => e.id), [null]);
  assert.equal(healTagRegistry(), 1);
  assert.deepEqual(productionEntries().map((e) => e.id), [mintTagId("prop", "kettle")]);
  assert.deepEqual(currentProductionIndex().entries.map((e) => e.id), [mintTagId("prop", "kettle")]);
  assert.deepEqual(currentProductionIndex().unregistered, []);
});

test("after a heal the cached index is what a fresh derivation of the healed document gives, without re-deriving (#326)", () => {
  load({
    rows: [
      row("r1", "Put the " + tag("prop", "kettle") + " on. " + tag("sound", "SFX: whistle"), "Wide on the " + tag("location", "kitchen")),
      row("r2", tag("cast", "Ada") + " pours. " + tag("prop", "Mug"), tag("prop", "kettle") + " " + tag("vfx", "steam"))
    ]
  });
  S.state.productionTags = [
    { id: "t_kitchen", cat: "location", name: "Kitchen", owner: "", notes: "", status: "have" },
    { id: "t_ladder", cat: "prop", name: "Ladder", owner: "", notes: "n", status: "needed" }
  ];
  const shown = productionEntries();
  const derivedBefore = productionIndexStats().derived;
  assert.equal(healTagRegistry(), 5);
  assert.equal(productionIndexStats().derived, derivedBefore, "the heal re-derived the index");
  const fresh = deriveProductionIndex(S.state, productionReaders);
  assert.deepEqual(currentProductionIndex(), fresh);
  assert.deepEqual(productionEntries().map((e) => [e.key, e.id]), fresh.entries.map((e) => [e.key, e.id]));
  assert.deepEqual(shown.map((e) => e.id), fresh.entries.map((e) => e.id), "an entry already handed out keeps its old id");
  assert.equal(healTagRegistry(), 0);
  assert.equal(productionIndexStats().derived, derivedBefore);
});

test("seeded documents: after a heal both index views agree with a fresh derivation (#326)", () => {
  const cats = ["prop", "location", "cast", "vfx", "gear"];
  const names = ["kettle", "Kettle", "mug", "pier", "Ada", "steam", "drone", "lamp"];
  let seed = 326;
  const rand = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) % n;
  };
  let healedRounds = 0;
  for (let round = 0; round < 60; round++) {
    const rows = [];
    for (let r = 0; r < 1 + rand(4); r++) {
      const cell = () => {
        let html = "";
        for (let k = 0; k < rand(4); k++) html += "x " + tag(cats[rand(cats.length)], names[rand(names.length)]) + " ";
        return html;
      };
      rows.push(row("r" + r, cell(), cell()));
    }
    const productionTags = [];
    for (let t = 0; t < rand(4); t++) {
      const cat = cats[rand(cats.length)], name = names[rand(names.length)];
      productionTags.push({ id: "t_" + round + "_" + t, cat, name, owner: "", notes: "", status: "needed" });
    }
    load({ rows });
    S.state.productionTags = productionTags;
    productionEntries();
    if (healTagRegistry()) healedRounds++;
    const fresh = deriveProductionIndex(S.state, productionReaders);
    const label = "round " + round;
    assert.deepEqual(currentProductionIndex(), fresh, label);
    assert.deepEqual(productionEntries().map((e) => [e.key, e.id, e.name, e.orphaned]),
      fresh.entries.map((e) => [e.key, e.id, e.name, e.orphaned]), label);
  }
  assert.ok(healedRounds >= 30, "only " + healedRounds + " rounds healed anything");
});
