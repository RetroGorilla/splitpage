import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { flushEdits, noteEdit, redo, trackDocument, undo } from "../js/12a-undo.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const person = (id, name) => ({ id, name });
const tag = (id, name, owner) => ({ id, cat: "prop", name, owner: owner || "", notes: "", status: "needed" });
const shot = (id, name, owner) => ({ id, name, owner: owner || "" });
const ownerOf = (list, name) => (list.find((e) => e.name === name) || {}).owner;

function boot() {
  S.state = migrateRows({ schema: 2, title: "Fold", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
  ] });
  S.state.people.push(person("pM", "Ada"));
  S.state.productionTags.push(tag("t_kettle", "Kettle", ""));
  S.state.brollShots.push(shot("bs_pier", "Pier", ""));
  trackDocument();
}

function assign(list, name, owner) {
  list.find((e) => e.name === name).owner = owner;
  noteEdit();
  flushEdits();
}

function fold() {
  S.state.people = [person("pT", "ada")];
}

test("redo of an owner assignment after a merge folded the person lands on the surviving same-named person (#391)", () => {
  boot();
  assign(S.state.productionTags, "Kettle", "pM");
  assert.equal(undo().ok, true);
  fold();
  assert.equal(redo().ok, true);
  assert.equal(ownerOf(S.state.productionTags, "Kettle"), "pT");
  assert.equal(ownerOf(migrateRows(clone(S.state)).productionTags, "Kettle"), "pT");
});

test("redo through two entries after a fold assigns the surviving person, then clears (#391)", () => {
  boot();
  assign(S.state.brollShots, "Pier", "pM");
  assign(S.state.brollShots, "Pier", "");
  assert.equal(undo().ok, true);
  assert.equal(undo().ok, true);
  fold();
  assert.equal(redo().ok, true);
  assert.equal(ownerOf(S.state.brollShots, "Pier"), "pT");
  assert.equal(redo().ok, true);
  assert.equal(ownerOf(S.state.brollShots, "Pier"), "");
  assert.equal(undo().ok, true);
  assert.equal(ownerOf(S.state.brollShots, "Pier"), "pT");
});

test("redo of a b-roll owner assignment after a fold lands on the surviving person (#391)", () => {
  boot();
  assign(S.state.brollShots, "Pier", "pM");
  assert.equal(undo().ok, true);
  fold();
  assert.equal(redo().ok, true);
  assert.equal(ownerOf(S.state.brollShots, "Pier"), "pT");
});

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Ada", "Bo", "Cy"];
const ITEMS = [["productionTags", "Kettle"], ["productionTags", "Lamp"], ["brollShots", "Pier"], ["brollShots", "Dock"]];

function boot2() {
  S.state = migrateRows({ schema: 2, title: "Prop", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
  ] });
  S.state.productionTags.push(tag("t_kettle", "Kettle", ""), tag("t_lamp", "Lamp", ""));
  S.state.brollShots.push(shot("bs_pier", "Pier", ""), shot("bs_dock", "Dock", ""));
  trackDocument();
}

function nameMap() {
  const names = {};
  S.state.people.forEach((p) => { names[p.id] = p.name; });
  const out = {};
  ITEMS.forEach(([list, name]) => {
    const owner = ownerOf(S.state[list], name);
    out[name] = owner ? names[owner] || "?dangling:" + owner : "";
  });
  out.__people = S.state.people.map((p) => p.name).sort().join(",");
  return JSON.stringify(out);
}

function foldPerson(name) {
  const mineP = S.state.people.find((p) => p.name === name && p.id.startsWith("pM_"));
  if (!mineP) return false;
  const base = clone(S.state);
  base.people = base.people.filter((p) => p.id !== mineP.id);
  [].concat(base.productionTags, base.brollShots).forEach((e) => { if (e.owner === mineP.id) e.owner = ""; });
  const theirs = clone(base);
  theirs.people.push(person("pT_" + name, name));
  const merged = mergeStates(clone(base), clone(S.state), theirs).merged;
  S.state.people = merged.people;
  S.state.productionTags = merged.productionTags;
  S.state.brollShots = merged.brollShots;
  return true;
}

test("seeded: every undo and redo across assignments, crew changes and folds lands on a state that existed (#391)", () => {
  let undos = 0, redos = 0, folds = 0, refused = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const pick = (list) => list[Math.floor(r() * list.length)];
    boot2();
    const snaps = [nameMap()];
    let k = 0;
    const label = "seed " + seed;
    const commit = () => {
      noteEdit();
      flushEdits();
      snaps.length = k + 1;
      snaps.push(nameMap());
      k++;
    };
    const check = (what) => {
      const got = nameMap();
      assert.equal(got, snaps[k], label + " " + what + " k=" + k);
      assert.ok(!got.includes("dangling"), label + " " + what);
    };
    for (let step = 0; step < 25; step++) {
      const op = r();
      if (op < 0.3) {
        const [list, name] = pick(ITEMS);
        const owner = pick(["", ...S.state.people.map((p) => p.id)]);
        const item = S.state[list].find((e) => e.name === name);
        if (item.owner === owner) continue;
        item.owner = owner;
        commit();
      } else if (op < 0.45) {
        const n = pick(NAMES);
        if (S.state.people.some((p) => p.name === n)) continue;
        S.state.people.push(person("pM_" + n + "_" + step, n));
        commit();
      } else if (op < 0.55) {
        if (!S.state.people.length) continue;
        const p = pick(S.state.people);
        S.state.people = S.state.people.filter((x) => x.id !== p.id);
        [].concat(S.state.productionTags, S.state.brollShots).forEach((e) => { if (e.owner === p.id) e.owner = ""; });
        commit();
      } else if (op < 0.7) {
        if (foldPerson(pick(NAMES))) { folds++; snaps[k] = nameMap(); }
      } else if (op < 0.85) {
        if (k === 0) continue;
        const res = undo();
        if (!res.ok) { refused++; continue; }
        undos++;
        k--;
        check("undo");
      } else {
        if (k === snaps.length - 1) continue;
        const res = redo();
        if (!res.ok) { refused++; continue; }
        redos++;
        k++;
        check("redo");
      }
    }
  }
  assert.equal(refused, 0, "no undo or redo refused");
  assert.ok(undos > 300 && redos > 150 && folds > 100, JSON.stringify({ undos, redos, folds }));
});
