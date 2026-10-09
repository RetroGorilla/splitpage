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
const shot = (id, name, owner) => ({ id, name, owner: owner || "", notes: "" });
const itemOf = (st, list, name) => st[list].find((e) => e.name === name);
const ownerOf = (list, name) => itemOf(S.state, list, name).owner;
const crew = () => S.state.people.map((p) => p.name);

function commit() {
  noteEdit();
  flushEdits();
}

function remote(mutate) {
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

function foldedCrewEntry(list) {
  S.state = migrateRows({ schema: 2, title: "Crew", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
  ] });
  S.state.people.push(person("p_Cy", "Cy"));
  const item = list === "brollShots" ? shot : tag;
  S.state[list].push(item("i_dock", "Dock", ""), item("i_quay", "Quay", ""), item("i_pier", "Pier", ""));
  trackDocument();
  S.state.people.push(person("p_Ada", "Ada"));
  commit();
  remote((st) => { itemOf(st, list, "Dock").owner = "p_Ada"; });
  assert.equal(undo().cleared, 1);
  assert.equal(ownerOf(list, "Dock"), "");
  assert.equal(redo().ok, true);
  assert.equal(ownerOf(list, "Dock"), "p_Ada");
}

for (const list of ["brollShots", "productionTags"]) {
  test("a collaborator's edit to another item keeps a crew-only entry that undo and redo folded an owner into, in " + list + " (#518)", () => {
    foldedCrewEntry(list);
    remote((st) => { itemOf(st, list, "Quay").notes = "from them"; });
    const back = undo();
    assert.equal(back.empty, undefined, "adding Ada can still be undone");
    assert.equal(back.ok, true);
    assert.equal(back.cleared, 1);
    assert.deepEqual(crew(), ["Cy"]);
    assert.equal(ownerOf(list, "Dock"), "");
    assert.equal(itemOf(S.state, list, "Quay").notes, "from them", "the collaborator's edit stays");
    assert.deepEqual(dangling(), []);
    const again = redo();
    assert.equal(again.ok, true);
    assert.deepEqual(crew(), ["Cy", "Ada"]);
    assert.equal(ownerOf(list, "Dock"), "p_Ada");
    assert.equal(itemOf(S.state, list, "Quay").notes, "from them");
  });

  test("a collaborator's edit to the item the fold changed still forgets the entry, in " + list + " (#518)", () => {
    foldedCrewEntry(list);
    remote((st) => { itemOf(st, list, "Dock").notes = "from them"; });
    assert.equal(undo().empty, true);
    assert.deepEqual(crew(), ["Cy", "Ada"]);
    assert.equal(ownerOf(list, "Dock"), "p_Ada");
  });

  test("the folded owner change leaves alone an owner that my own later step set and a collaborator's edit made permanent, in " + list + " (#518)", () => {
    foldedCrewEntry(list);
    itemOf(S.state, list, "Dock").owner = "p_Cy";
    commit();
    remote((st) => { itemOf(st, list, "Quay").notes = "from them"; });
    const back = undo();
    assert.equal(back.ok, true);
    assert.equal(back.cleared, undefined);
    assert.deepEqual(crew(), ["Cy"]);
    assert.equal(ownerOf(list, "Dock"), "p_Cy");
    assert.equal(itemOf(S.state, list, "Quay").notes, "from them");
    assert.equal(redo().ok, true);
    assert.deepEqual(crew(), ["Cy", "Ada"]);
    assert.equal(ownerOf(list, "Dock"), "p_Cy");
    assert.equal(undo().ok, true);
    assert.equal(undo().empty, true);
  });

  test("redo gives back an owner a collaborator gave another item after the fold, which the undo cleared, in " + list + " (#518 review B1)", () => {
    foldedCrewEntry(list);
    remote((st) => { itemOf(st, list, "Quay").owner = "p_Ada"; });
    const back = undo();
    assert.equal(back.ok, true);
    assert.equal(back.cleared, 2);
    assert.equal(ownerOf(list, "Dock"), "");
    assert.equal(ownerOf(list, "Quay"), "");
    assert.equal(redo().ok, true);
    assert.equal(ownerOf(list, "Dock"), "p_Ada");
    assert.equal(ownerOf(list, "Quay"), "p_Ada", "the collaborator's assignment comes back");
    assert.equal(undo().cleared, 2);
    assert.equal(redo().ok, true);
    assert.equal(ownerOf(list, "Quay"), "p_Ada");
  });

  test("redo gives back an item a collaborator added for that person after the fold, in " + list + " (#518 review B1)", () => {
    foldedCrewEntry(list);
    const item = list === "brollShots" ? shot : tag;
    remote((st) => { st[list].push(item("i_wharf", "Wharf", "p_Ada")); });
    assert.equal(undo().cleared, 2);
    assert.equal(ownerOf(list, "Wharf"), "");
    assert.equal(redo().ok, true);
    assert.equal(ownerOf(list, "Dock"), "p_Ada");
    assert.equal(ownerOf(list, "Wharf"), "p_Ada");
  });

  test("redo gives back my own later assignment that a collaborator's edit made permanent and the undo cleared, in " + list + " (#518 review B1)", () => {
    foldedCrewEntry(list);
    itemOf(S.state, list, "Pier").owner = "p_Ada";
    commit();
    remote((st) => { itemOf(st, list, "Quay").notes = "from them"; });
    assert.equal(undo().cleared, 2);
    assert.equal(ownerOf(list, "Pier"), "");
    assert.equal(redo().ok, true);
    assert.equal(ownerOf(list, "Dock"), "p_Ada");
    assert.equal(ownerOf(list, "Pier"), "p_Ada");
    assert.equal(itemOf(S.state, list, "Quay").notes, "from them");
  });

  test("redo does not give back an owner I cleared myself after the fold, in " + list + " (#518 review B2)", () => {
    foldedCrewEntry(list);
    itemOf(S.state, list, "Dock").owner = "";
    commit();
    remote((st) => { itemOf(st, list, "Quay").notes = "from them"; });
    const back = undo();
    assert.equal(back.ok, true);
    assert.equal(back.cleared, undefined);
    assert.deepEqual(crew(), ["Cy"]);
    assert.equal(ownerOf(list, "Dock"), "");
    assert.equal(redo().ok, true);
    assert.deepEqual(crew(), ["Cy", "Ada"]);
    assert.equal(ownerOf(list, "Dock"), "", "undo then redo is a round trip");
  });

  test("a collaborator's edit to another item that arrives through a merge keeps the entry, in " + list + " (#518)", () => {
    foldedCrewEntry(list);
    const synced = clone(S.state);
    const theirs = clone(synced);
    itemOf(theirs, list, "Quay").notes = "from them";
    const merged = mergeStates(clone(synced), clone(S.state), theirs).merged;
    remote((st) => { st[list] = merged[list]; });
    const back = undo();
    assert.equal(back.ok, true);
    assert.equal(back.cleared, 1);
    assert.deepEqual(crew(), ["Cy"]);
    assert.equal(ownerOf(list, "Dock"), "");
    assert.equal(itemOf(S.state, list, "Quay").notes, "from them");
  });
}

test("the folded owner change leaves alone an owner I unassigned later, and does not count it as cleared (#518)", () => {
  S.state = migrateRows({ schema: 2, title: "Crew", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
  ] });
  S.state.people.push(person("p_Cy", "Cy"));
  S.state.brollShots.push(shot("bs_dock", "Dock", ""), shot("bs_quay", "Quay", ""));
  trackDocument();
  S.state.people.push(person("p_Ada", "Ada"));
  commit();
  assert.equal(undo().ok, true);
  S.state.people.push(person("pT_ada", "ADA"));
  itemOf(S.state, "brollShots", "Dock").owner = "pT_ada";
  S.state.brollShots.push(shot("bs_pier", "Pier", "p_Gone"));
  assert.equal(redo().cleared, 1);
  assert.equal(ownerOf("brollShots", "Dock"), "p_Ada");
  itemOf(S.state, "brollShots", "Dock").owner = "";
  commit();
  remote((st) => { itemOf(st, "brollShots", "Quay").notes = "from them"; });
  const back = undo();
  assert.equal(back.ok, true);
  assert.equal(back.cleared, 1, "only Pier, which the undo gave back to a person no longer in the crew");
  assert.deepEqual(crew(), ["Cy"]);
  assert.equal(ownerOf("brollShots", "Dock"), "");
  assert.equal(ownerOf("brollShots", "Pier"), "");
  assert.equal(itemOf(S.state, "brollShots", "Quay").notes, "from them");
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
const ITEMS = [["productionTags", "Kettle"], ["productionTags", "Lamp"], ["brollShots", "Pier"], ["brollShots", "Dock"], ["brollShots", "Quay"]];

function notesOf(st) {
  return JSON.stringify(ITEMS.map(([l, n]) => itemOf(st, l, n).notes));
}

function snapshot(st) {
  return JSON.stringify(ITEMS.map(([l, n]) => [itemOf(st, l, n).owner, itemOf(st, l, n).notes]));
}

function ownerName(l, n) {
  const owner = ownerOf(l, n);
  if (!owner) return "";
  const p = S.state.people.find((x) => x.id === owner);
  return p ? p.name : "?" + owner;
}

test("seeded: with collaborators editing other items, undo and redo of folded owner changes never undo a collaborator's edit, never refuse and never dangle (#518)", () => {
  let replays = 0, overEdits = 0, roundTrips = 0, notesEdits = 0, refused = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const r = rng(seed);
    const pick = (list) => list[Math.floor(r() * list.length)];
    S.state = migrateRows({ schema: 2, title: "Prop", comments: [], rows: [
      { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
    ] });
    S.state.productionTags.push(tag("t_kettle", "Kettle"), tag("t_lamp", "Lamp"));
    S.state.brollShots.push(shot("bs_pier", "Pier"), shot("bs_dock", "Dock"), shot("bs_quay", "Quay"));
    trackDocument();
    const seen = {};
    ITEMS.forEach(([, n]) => { seen[n] = new Set([""]); });
    const note = () => ITEMS.forEach(([l, n]) => seen[n].add(ownerName(l, n)));
    const label = "seed " + seed;
    for (let step = 0; step < 40; step++) {
      const op = r();
      if (op < 0.15) {
        const n = pick(NAMES);
        if (S.state.people.some((p) => p.name === n)) continue;
        S.state.people.push(person("pM_" + n + "_" + step, n));
        commit();
      } else if (op < 0.23) {
        if (!S.state.people.length) continue;
        const gone = pick(S.state.people).id;
        S.state.people = S.state.people.filter((p) => p.id !== gone);
        [].concat(S.state.productionTags, S.state.brollShots).forEach((e) => { if (e.owner === gone) e.owner = ""; });
        commit();
        note();
      } else if (op < 0.33) {
        const [l, n] = pick(ITEMS);
        const owner = pick(["", ...S.state.people.map((p) => p.id)]);
        if (ownerOf(l, n) === owner) continue;
        itemOf(S.state, l, n).owner = owner;
        commit();
        note();
      } else if (op < 0.48) {
        const [l, n] = pick(ITEMS);
        const owner = pick(["", ...S.state.people.map((p) => p.id)]);
        remote((st) => { itemOf(st, l, n).owner = owner; });
        note();
      } else if (op < 0.63) {
        const [l, n] = pick(ITEMS);
        notesEdits++;
        remote((st) => { itemOf(st, l, n).notes = "theirs " + step; });
      } else {
        const pre = clone(S.state);
        const backwards = r() < 0.6;
        const res = backwards ? undo() : redo();
        if (res.empty) continue;
        if (!res.ok) { refused++; continue; }
        const folded = res.steps.filter((s) => s.op === "docField" && s.ownersOnly);
        if (folded.length) replays++;
        if (folded.some((s) => JSON.stringify(pre[s.key]) !== JSON.stringify(s.before))) overEdits++;
        assert.equal(notesOf(S.state), notesOf(pre), label + " step " + step + " kept every collaborator note");
        assert.deepEqual(dangling(), [], label + " step " + step);
        ITEMS.forEach(([l, n]) => assert.ok(seen[n].has(ownerName(l, n)), label + " step " + step + " " + n + "=" + ownerName(l, n)));
        if (folded.length && r() < 0.5) {
          const again = backwards ? redo() : undo();
          assert.equal(again.ok, true, label + " step " + step + " the opposite step applies");
          roundTrips++;
          assert.equal(snapshot(S.state), snapshot(pre), label + " step " + step + " the opposite step puts every owner and note back");
        }
      }
    }
  }
  assert.equal(refused, 0, "no undo or redo refused");
  assert.ok(replays > 300 && overEdits > 50 && roundTrips > 100 && notesEdits > 3000, JSON.stringify({ replays, overEdits, roundTrips, notesEdits }));
});
