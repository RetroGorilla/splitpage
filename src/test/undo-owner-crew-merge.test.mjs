import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { flushEdits, noteEdit, noteRemoteChange, redo, trackDocument, undo } from "../js/12a-undo.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const person = (id, name) => ({ id, name });
const tag = (id, name, owner) => ({ id, cat: "prop", name, owner: owner || "", notes: "", status: "needed" });
const shot = (id, name, owner) => ({ id, name, owner: owner || "" });
const ownerOf = (list, name) => (list.find((e) => e.name === name) || {}).owner;

function boot(names) {
  S.state = migrateRows({ schema: 2, title: "Crew", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
  ] });
  names.forEach((n) => S.state.people.push(person("p_" + n, n)));
  S.state.productionTags.push(tag("t_kettle", "Kettle", ""));
  S.state.brollShots.push(shot("bs_dock", "Dock", ""));
  trackDocument();
}

function commit() {
  noteEdit();
  flushEdits();
}

function removePerson(id) {
  S.state.people = S.state.people.filter((p) => p.id !== id);
  [].concat(S.state.productionTags, S.state.brollShots).forEach((e) => { if (e.owner === id) e.owner = ""; });
  commit();
}

function remoteCrew(mutate) {
  const next = clone(S.state);
  mutate(next);
  noteRemoteChange(next);
  S.state = next;
}

function dangling() {
  const ids = new Set(S.state.people.map((p) => p.id));
  return [].concat(S.state.productionTags, S.state.brollShots)
    .filter((e) => e.owner && !ids.has(e.owner)).map((e) => e.name + ":" + e.owner);
}

test("redo of an older assignment after a crew-changing merge forgot the removal does not re-assign the removed person (#476)", () => {
  boot(["Ada", "Cy"]);
  const dock = S.state.brollShots.find((e) => e.name === "Dock");
  dock.owner = "p_Ada";
  commit();
  removePerson("p_Ada");
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "");
  remoteCrew((st) => st.people.push(person("p_Di", "Di")));
  assert.equal(undo().ok, true);
  assert.equal(redo().ok, true);
  assert.deepEqual(dangling(), []);
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "");
  assert.equal(ownerOf(migrateRows(clone(S.state)).brollShots, "Dock"), "");
});

test("the same holds for a production tag (#476)", () => {
  boot(["Ada", "Cy"]);
  S.state.productionTags.find((e) => e.name === "Kettle").owner = "p_Ada";
  commit();
  removePerson("p_Ada");
  remoteCrew((st) => st.people.push(person("p_Di", "Di")));
  assert.equal(undo().ok, true);
  assert.equal(redo().ok, true);
  assert.deepEqual(dangling(), []);
});

test("redo still assigns a person who is in the crew (#476)", () => {
  boot(["Ada", "Cy"]);
  S.state.brollShots.find((e) => e.name === "Dock").owner = "p_Cy";
  commit();
  assert.equal(undo().ok, true);
  remoteCrew((st) => st.people.push(person("p_Di", "Di")));
  assert.equal(redo().ok, true);
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "p_Cy");
});

test("undo of an entry that removed a person after a same-named fold leaves no dangling owner (#476)", () => {
  boot(["Ada"]);
  S.state.brollShots.find((e) => e.name === "Dock").owner = "p_Ada";
  commit();
  removePerson("p_Ada");
  S.state.people = [person("pT", "ada")];
  assert.equal(undo().ok, true);
  assert.deepEqual(dangling(), []);
  assert.equal(redo().ok, true);
  assert.deepEqual(dangling(), []);
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

function ownerNameOf(list, name) {
  const owner = ownerOf(S.state[list], name);
  if (!owner) return "";
  const p = S.state.people.find((x) => x.id === owner);
  return p ? p.name.toLowerCase() : "?dangling:" + owner;
}

function mergeFold(name, mixedCase) {
  const mine = S.state.people.find((p) => p.name === name);
  if (!mine) return false;
  const base = clone(S.state);
  base.people = base.people.filter((p) => p.id !== mine.id);
  [].concat(base.productionTags, base.brollShots).forEach((e) => { if (e.owner === mine.id) e.owner = ""; });
  const theirs = clone(base);
  theirs.people.push(person("pT_" + name, mixedCase ? name.toUpperCase() : name));
  const merged = mergeStates(clone(base), clone(S.state), theirs).merged;
  const next = clone(S.state);
  next.people = merged.people;
  next.productionTags = merged.productionTags;
  next.brollShots = merged.brollShots;
  noteRemoteChange(next);
  S.state = next;
  return true;
}

test("seeded: through noteRemoteChange, with crew-changing and mixed-case merges, undo and redo never refuse, never dangle and land on a value the item held (#476)", () => {
  let undos = 0, redos = 0, folds = 0, crewMerges = 0, refused = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const pick = (list) => list[Math.floor(r() * list.length)];
    S.state = migrateRows({ schema: 2, title: "Prop", comments: [], rows: [
      { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
    ] });
    S.state.productionTags.push(tag("t_kettle", "Kettle", ""), tag("t_lamp", "Lamp", ""));
    S.state.brollShots.push(shot("bs_pier", "Pier", ""), shot("bs_dock", "Dock", ""));
    trackDocument();
    const seen = {};
    ITEMS.forEach(([, n]) => { seen[n] = new Set([""]); });
    const note = () => ITEMS.forEach(([l, n]) => seen[n].add(ownerNameOf(l, n)));
    const label = "seed " + seed;
    for (let step = 0; step < 30; step++) {
      const op = r();
      if (op < 0.25) {
        const [list, name] = pick(ITEMS);
        const owner = pick(["", ...S.state.people.map((p) => p.id)]);
        const item = S.state[list].find((e) => e.name === name);
        if (item.owner === owner) continue;
        item.owner = owner;
        commit();
        note();
      } else if (op < 0.4) {
        const n = pick(NAMES);
        if (S.state.people.some((p) => p.name.toLowerCase() === n.toLowerCase())) continue;
        S.state.people.push(person("pM_" + n + "_" + step, n));
        commit();
      } else if (op < 0.5) {
        if (!S.state.people.length) continue;
        removePerson(pick(S.state.people).id);
        note();
      } else if (op < 0.6) {
        if (mergeFold(pick(NAMES), r() < 0.5)) { folds++; note(); }
      } else if (op < 0.7) {
        crewMerges++;
        const n = pick(NAMES);
        remoteCrew((st) => {
          if (r() < 0.5 && st.people.length) {
            const gone = pick(st.people);
            st.people = st.people.filter((p) => p.id !== gone.id);
            [].concat(st.productionTags, st.brollShots).forEach((e) => { if (e.owner === gone.id) e.owner = ""; });
          } else if (!st.people.some((p) => p.name.toLowerCase() === n.toLowerCase())) {
            st.people.push(person("pT_" + n + "_" + step, n));
          }
        });
        note();
      } else if (op < 0.85) {
        const res = undo();
        if (res.empty) continue;
        if (!res.ok) { refused++; continue; }
        undos++;
        assert.deepEqual(dangling(), [], label + " undo");
        ITEMS.forEach(([l, n]) => assert.ok(seen[n].has(ownerNameOf(l, n)), label + " undo " + n + "=" + ownerNameOf(l, n)));
      } else {
        const res = redo();
        if (res.empty) continue;
        if (!res.ok) { refused++; continue; }
        redos++;
        assert.deepEqual(dangling(), [], label + " redo");
        ITEMS.forEach(([l, n]) => assert.ok(seen[n].has(ownerNameOf(l, n)), label + " redo " + n + "=" + ownerNameOf(l, n)));
      }
    }
  }
  assert.equal(refused, 0, "no undo or redo refused");
  assert.ok(undos > 300 && redos > 100 && folds > 100 && crewMerges > 100, JSON.stringify({ undos, redos, folds, crewMerges }));
});
