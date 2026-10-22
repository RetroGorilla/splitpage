import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { flushEdits, noteEdit, noteRemoteChange, redo, trackDocument, undo } from "../js/12a-undo.js";
import { startTestSession } from "./_session.mjs";
import { appSessionDeps } from "./_app-session.mjs";
import { loadTestDocument } from "./_document.mjs";

startTestSession(appSessionDeps());

const clone = (v) => JSON.parse(JSON.stringify(v));
const person = (id, name) => ({ id, name });
const tag = (id, name, owner) => ({ id, cat: "prop", name, owner: owner || "", notes: "", status: "needed" });
const shot = (id, name, owner) => ({ id, name, owner: owner || "" });
const ownerOf = (list, name) => (list.find((e) => e.name === name) || {}).owner;

function boot(names) {
  loadTestDocument(migrateRows({ schema: 2, title: "Crew", comments: [], rows: [
    { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
  ] }));
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
  loadTestDocument(next);
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
  const res = redo();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 1);
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
  const res = redo();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, undefined);
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

test("undo of an entry that only added a person clears the item a collaborator gave that person (#476)", () => {
  boot(["Cy"]);
  S.state.people.push(person("p_Ada", "Ada"));
  commit();
  remoteCrew((st) => { st.brollShots.find((e) => e.name === "Dock").owner = "p_Ada"; });
  const res = undo();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 1);
  assert.deepEqual(S.state.people.map((p) => p.name), ["Cy"]);
  assert.deepEqual(dangling(), []);
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "");
  const again = redo();
  assert.equal(again.ok, true);
  assert.equal(again.cleared, undefined);
  assert.deepEqual(S.state.people.map((p) => p.name), ["Cy", "Ada"]);
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "p_Ada", "redo gives back what the undo cleared");
  const twice = undo();
  assert.equal(twice.ok, true);
  assert.equal(twice.cleared, 1, "the second undo clears it again and says so");
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "");
});

for (const list of ["brollShots", "productionTags"]) {
  test("redo of my own unassignment lands after a crew-only undo cleared a collaborator's owner, in " + list + " (#476 review)", () => {
    loadTestDocument(migrateRows({ schema: 2, title: "Crew", comments: [], rows: [
      { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
    ] }));
    S.state.people.push(person("p_Cy", "Cy"));
    const item = list === "brollShots" ? shot : (id, name, owner) => tag(id, name, owner);
    S.state[list].push(item("i_dock", "Dock", ""), item("i_pier", "Pier", "p_Cy"));
    trackDocument();
    S.state.people.push(person("p_Ada", "Ada"));
    commit();
    remoteCrew((st) => { st[list].find((e) => e.name === "Dock").owner = "p_Ada"; });
    S.state[list].find((e) => e.name === "Pier").owner = "";
    commit();
    assert.equal(undo().ok, true);
    assert.equal(ownerOf(S.state[list], "Pier"), "p_Cy");
    assert.equal(undo().cleared, 1);
    assert.equal(ownerOf(S.state[list], "Dock"), "");
    assert.equal(redo().ok, true);
    assert.equal(ownerOf(S.state[list], "Dock"), "p_Ada");
    const res = redo();
    assert.equal(res.ok, true);
    assert.equal(res.cleared, undefined);
    assert.equal(ownerOf(S.state[list], "Pier"), "", "my unassignment is applied");
    assert.equal(ownerOf(S.state[list], "Dock"), "p_Ada");
    assert.deepEqual(dangling(), []);
  });
}

test("redo of an entry that only removed a person clears the tag a collaborator gave that person meanwhile (#476)", () => {
  boot(["Ada", "Cy"]);
  S.state.people = S.state.people.filter((p) => p.id !== "p_Ada");
  commit();
  assert.equal(undo().ok, true);
  remoteCrew((st) => {
    st.productionTags.find((e) => e.name === "Kettle").owner = "p_Ada";
    st.brollShots.find((e) => e.name === "Dock").owner = "p_Cy";
  });
  const res = redo();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 1);
  assert.deepEqual(dangling(), []);
  assert.equal(ownerOf(S.state.productionTags, "Kettle"), "");
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "p_Cy", "an owner still in the crew is kept");
});

test("a redo that only changes the crew keeps an owner the same-name remap points at a crew member (#476)", () => {
  boot(["Cy"]);
  S.state.people.push(person("p_Ada", "Ada"));
  commit();
  assert.equal(undo().ok, true);
  S.state.people.push(person("pT_ada", "ADA"));
  S.state.brollShots.find((e) => e.name === "Dock").owner = "pT_ada";
  const res = redo();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, undefined);
  assert.deepEqual(dangling(), []);
  assert.deepEqual(S.state.people.map((p) => p.id), ["p_Cy", "p_Ada"]);
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "p_Ada");
});

test("a crew-only redo that clears one owner and re-points another records both, so its undo goes back exactly (#476 review)", () => {
  boot(["Cy"]);
  S.state.people.push(person("p_Ada", "Ada"));
  commit();
  assert.equal(undo().ok, true);
  S.state.people.push(person("pT_ada", "ADA"));
  S.state.brollShots.find((e) => e.name === "Dock").owner = "pT_ada";
  S.state.brollShots.push(shot("bs_pier", "Pier", "p_Gone"));
  const res = redo();
  assert.equal(res.ok, true);
  assert.equal(res.cleared, 1);
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "p_Ada");
  assert.equal(ownerOf(S.state.brollShots, "Pier"), "");
  assert.deepEqual(dangling(), []);
  const back = undo();
  assert.equal(back.ok, true);
  assert.deepEqual(S.state.people.map((p) => p.id), ["p_Cy"]);
  assert.deepEqual(S.state.brollShots.map((b) => b.owner), ["", ""]);
  assert.deepEqual(dangling(), []);
  assert.equal(redo().ok, true);
  assert.equal(ownerOf(S.state.brollShots, "Dock"), "p_Ada");
  assert.deepEqual(dangling(), []);
});

test("an undo that only changes the crew announces the items it unassigned (#476)", () => {
  const seen = [];
  const listener = (e) => seen.push(e.detail.count);
  document.addEventListener("undo-owner-cleared", listener);
  try {
    boot(["Cy"]);
    S.state.people.push(person("p_Ada", "Ada"));
    commit();
    remoteCrew((st) => {
      st.brollShots.find((e) => e.name === "Dock").owner = "p_Ada";
      st.productionTags.find((e) => e.name === "Kettle").owner = "p_Ada";
    });
    assert.equal(undo().ok, true);
    assert.deepEqual(seen, [2]);
  } finally {
    document.removeEventListener("undo-owner-cleared", listener);
  }
});

test("an undo that only changes the crew announces its cleared items without a jsdom error (#503)", () => {
  const failures = [];
  const onError = (e) => { failures.push(e.message); e.preventDefault(); };
  window.addEventListener("error", onError);
  try {
    boot(["Cy"]);
    S.state.people.push(person("p_Ada", "Ada"));
    commit();
    remoteCrew((st) => {
      st.brollShots.find((e) => e.name === "Dock").owner = "p_Ada";
      st.productionTags.find((e) => e.name === "Kettle").owner = "p_Ada";
    });
    assert.equal(undo().ok, true);
    assert.deepEqual(failures, []);
  } finally {
    window.removeEventListener("error", onError);
  }
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
  loadTestDocument(next);
  return true;
}

function nameOfOwner(st, list, name) {
  const owner = ownerOf(st[list], name);
  if (!owner) return "";
  const p = st.people.find((x) => x.id === owner);
  return p ? p.name.toLowerCase() : "?dangling:" + owner;
}

function remoteItems(synced, mutate) {
  const mine = clone(S.state);
  const theirs = clone(synced);
  mutate(theirs);
  const merged = mergeStates(clone(synced), clone(mine), clone(theirs)).merged;
  const mineIds = new Set(mine.people.map((p) => p.id));
  const mineOnly = ITEMS.filter(([l, n]) => {
    const was = nameOfOwner(synced, l, n);
    return nameOfOwner(mine, l, n) !== was && nameOfOwner(theirs, l, n) === was;
  });
  const lost = mineOnly.filter(([l, n]) => nameOfOwner(merged, l, n) !== nameOfOwner(mine, l, n))
    .map(([l, n]) => n + ": " + nameOfOwner(mine, l, n) + " became " + nameOfOwner(merged, l, n));
  const ownerDeleted = mineOnly.filter(([l, n]) => {
    const was = ownerOf(synced[l], n);
    return was && !mineIds.has(was) && ownerOf(mine[l], n);
  }).length;
  const next = clone(S.state);
  next.people = merged.people;
  next.productionTags = merged.productionTags;
  next.brollShots = merged.brollShots;
  noteRemoteChange(next);
  loadTestDocument(next);
  return { lost, ownerDeleted, reassigned: mineOnly.filter(([l, n]) => nameOfOwner(mine, l, n)).length };
}

let ownItems = 0;

function ownStepsLanded(steps, pre) {
  const missed = [];
  const nameIn = (st, s, id) => id && ((s.owners && s.owners[id]) || (st.people.find((p) => p.id === id) || {}).name || "?" + id).trim().toLowerCase();
  steps.forEach((s) => {
    if (s.op !== "docField" || (s.key !== "productionTags" && s.key !== "brollShots")) return;
    const before = new Map((s.before || []).map((e) => [e.id, e.owner || ""]));
    (s.after || []).forEach((e) => {
      const want = e.owner || "";
      if (!before.has(e.id) || before.get(e.id) === want) return;
      const was = pre[s.key].find((x) => x.id === e.id);
      if (!was || (was.owner || "") !== before.get(e.id) && nameIn(pre, s, was.owner || "") !== nameIn(pre, s, before.get(e.id))) return;
      const live = S.state[s.key].find((x) => x.id === e.id);
      if (!live) return;
      ownItems++;
      const name = nameIn(S.state, s, want);
      const to = name ? S.state.people.find((p) => p.name.trim().toLowerCase() === name) : null;
      const expect = to ? to.id : "";
      if ((live.owner || "") !== expect) missed.push(e.name + ": " + (live.owner || "") + " not " + expect);
    });
  });
  return missed;
}

test("seeded: through noteRemoteChange, with crew-changing, item-assigning and mixed-case merges, undo and redo never refuse, never dangle and land on a value the item held (#476, #353)", () => {
  let undos = 0, redos = 0, folds = 0, crewMerges = 0, refused = 0, remoteAssigns = 0, arrivals = 0, crewOnly = 0, cleared = 0, ownerDeleted = 0, reassigned = 0;
  ownItems = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const pick = (list) => list[Math.floor(r() * list.length)];
    loadTestDocument(migrateRows({ schema: 2, title: "Prop", comments: [], rows: [
      { id: "r1", visualText: "one", audioText: "Alpha", status: "todo" }
    ] }));
    S.state.productionTags.push(tag("t_kettle", "Kettle", ""), tag("t_lamp", "Lamp", ""));
    S.state.brollShots.push(shot("bs_pier", "Pier", ""), shot("bs_dock", "Dock", ""));
    trackDocument();
    let synced = clone(S.state);
    const seen = {};
    ITEMS.forEach(([, n]) => { seen[n] = new Set([""]); });
    const note = () => ITEMS.forEach(([l, n]) => seen[n].add(ownerNameOf(l, n)));
    const label = "seed " + seed;
    for (let step = 0; step < 30; step++) {
      const op = r();
      if (op < 0.2) {
        const [list, name] = pick(ITEMS);
        const owner = pick(["", ...S.state.people.map((p) => p.id)]);
        const item = S.state[list].find((e) => e.name === name);
        if (item.owner === owner) continue;
        item.owner = owner;
        commit();
        note();
      } else if (op < 0.32) {
        const n = pick(NAMES);
        if (S.state.people.some((p) => p.name.toLowerCase() === n.toLowerCase())) continue;
        S.state.people.push(person("pM_" + n + "_" + step, n));
        commit();
      } else if (op < 0.4) {
        if (!S.state.people.length) continue;
        const gone = pick(S.state.people).id;
        const owned = ITEMS.filter(([l, n]) => ownerOf(S.state[l], n) === gone);
        removePerson(gone);
        if (owned.length && S.state.people.length && r() < 0.7) {
          const heir = pick(S.state.people).id;
          owned.forEach(([l, n]) => { S.state[l].find((e) => e.name === n).owner = heir; });
          commit();
        }
        note();
      } else if (op < 0.47) {
        if (mergeFold(pick(NAMES), r() < 0.5)) { folds++; synced = clone(S.state); note(); }
      } else if (op < 0.6) {
        const [list, name] = pick(ITEMS);
        let res;
        if (r() < 0.6) {
          remoteAssigns++;
          res = remoteItems(synced, (st) => { st[list].find((e) => e.name === name).owner = pick(["", ...st.people.map((p) => p.id)]); });
        } else {
          arrivals++;
          const n = pick(NAMES), id = "pT_" + n + "_" + step;
          const shout = r() < 0.5;
          res = remoteItems(synced, (st) => {
            const had = st.people.find((p) => p.name.toLowerCase() === n.toLowerCase());
            if (!had) st.people.push(person(id, shout ? n.toUpperCase() : n));
            st[list].find((e) => e.name === name).owner = had ? had.id : id;
          });
        }
        assert.deepEqual(res.lost, [], label + " merge kept my assignments");
        ownerDeleted += res.ownerDeleted;
        reassigned += res.reassigned;
        synced = clone(S.state);
        note();
      } else if (op < 0.68) {
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
        synced = clone(S.state);
        note();
      } else if (op < 0.85) {
        const pre = clone(S.state);
        const res = undo();
        if (res.empty) continue;
        if (!res.ok) { refused++; continue; }
        undos++;
        if (res.steps.every((s) => s.op === "docField" && s.key === "people")) crewOnly++;
        cleared += res.cleared || 0;
        assert.deepEqual(dangling(), [], label + " undo");
        assert.deepEqual(ownStepsLanded(res.steps, pre), [], label + " undo applied its own owner changes");
        ITEMS.forEach(([l, n]) => assert.ok(seen[n].has(ownerNameOf(l, n)), label + " undo " + n + "=" + ownerNameOf(l, n)));
      } else {
        const pre = clone(S.state);
        const res = redo();
        if (res.empty) continue;
        if (!res.ok) { refused++; continue; }
        redos++;
        if (res.steps.every((s) => s.op === "docField" && s.key === "people")) crewOnly++;
        cleared += res.cleared || 0;
        assert.deepEqual(dangling(), [], label + " redo");
        assert.deepEqual(ownStepsLanded(res.steps, pre), [], label + " redo applied its own owner changes");
        ITEMS.forEach(([l, n]) => assert.ok(seen[n].has(ownerNameOf(l, n)), label + " redo " + n + "=" + ownerNameOf(l, n)));
      }
    }
  }
  assert.equal(refused, 0, "no undo or redo refused");
  const counts = { undos, redos, folds, crewMerges, remoteAssigns, arrivals, crewOnly, cleared, ownerDeleted, reassigned, ownItems };
  assert.ok(undos > 300 && redos > 100 && folds > 100 && crewMerges > 100, JSON.stringify(counts));
  assert.ok(remoteAssigns > 100 && arrivals > 100 && crewOnly > 300 && cleared > 20 && ownerDeleted > 20 && reassigned > 150 && ownItems > 500, JSON.stringify(counts));
});

test("an undo or redo that clears an owner announces it, one that does not stays silent (#476)", () => {
  const seen = [];
  const listener = (e) => seen.push(e.detail.count);
  document.addEventListener("undo-owner-cleared", listener);
  try {
    boot(["Ada", "Cy"]);
    S.state.brollShots.find((e) => e.name === "Dock").owner = "p_Ada";
    commit();
    removePerson("p_Ada");
    remoteCrew((st) => st.people.push(person("p_Di", "Di")));
    assert.equal(undo().ok, true);
    assert.deepEqual(seen, []);
    assert.equal(redo().ok, true);
    assert.deepEqual(seen, [1]);
  } finally {
    document.removeEventListener("undo-owner-cleared", listener);
  }
});
