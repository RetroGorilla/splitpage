import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { changedBetween, createUndoHistory, diffStates } from "../application/editing/undo/history.ts";
import { cellRuns } from "./_cell-runs.mjs";

const person = (id, name) => ({ id, name });
const item = (id, name, owner = "") => ({ id, name, owner, notes: "" });

function setup(people) {
  const live = { rows: [], people, productionTags: [], brollShots: [item("dock", "Dock"), item("quay", "Quay")] };
  const history = createUndoHistory(cellRuns);
  function edit(change) {
    const before = structuredClone(live);
    change(live);
    history.record(diffStates(before, live), 0);
  }
  function remoteNotes() {
    const before = structuredClone(live);
    live.brollShots[1].notes = "Incoming notes";
    history.forget(changedBetween(before, live));
  }
  return { live, history, edit, remoteNotes };
}

test("people replay: undo then redo never restores an already removed person (#529)", () => {
  const { live, history, edit, remoteNotes } = setup([person("cy", "Cy")]);
  edit((s) => s.people.push(person("bo", "Bo")));
  edit((s) => { s.brollShots[0].owner = "bo"; });
  edit((s) => { s.people.pop(); s.brollShots[0].owner = ""; });
  remoteNotes();
  assert.deepEqual(history.sizes(), { undo: 1, redo: 0 });
  const before = structuredClone(live);
  assert.equal(history.undo(live).ok, true);
  assert.deepEqual(live, before);
  assert.deepEqual(history.sizes(), { undo: 0, redo: 0 });
  assert.equal(history.redo(live).empty, true);
  assert.deepEqual(live, before);
});

test("people replay: a merged no-op people step keeps the entry's other edits (#529)", () => {
  const { live, history, edit, remoteNotes } = setup([person("cy", "Cy")]);
  live.title = "Before";
  edit((s) => { s.people.push(person("bo", "Bo")); s.title = "After"; });
  edit((s) => { s.brollShots[0].owner = "bo"; });
  edit((s) => { s.people.pop(); s.brollShots[0].owner = ""; });
  remoteNotes();
  const before = structuredClone(live);
  assert.equal(history.undo(live).ok, true);
  assert.equal(live.title, "Before");
  assert.deepEqual(live.people, before.people);
  assert.equal(history.redo(live).ok, true);
  assert.deepEqual(live, before);
});

test("people replay: seeded crew edits, assignments and incoming notes round trip (#529)", () => {
  let replays = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    let random = seed;
    const pick = (n) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
    const { live, history, edit, remoteNotes } = setup([]);
    for (let turn = 0; turn < 30; turn++) {
      const op = pick(6);
      if (op === 0) {
        const name = ["Ada", "Bo", "Cy"][pick(3)];
        if (!live.people.some((p) => p.name === name)) edit((s) => s.people.push(person(`${seed}-${turn}`, name)));
      } else if (op === 1 && live.people.length) {
        const gone = live.people[pick(live.people.length)].id;
        edit((s) => {
          s.people = s.people.filter((p) => p.id !== gone);
          s.brollShots.forEach((e) => { if (e.owner === gone) e.owner = ""; });
        });
      } else if (op === 2) {
        const owner = ["", ...live.people.map((p) => p.id)][pick(live.people.length + 1)];
        edit((s) => { s.brollShots[0].owner = owner; });
      } else if (op === 3) {
        live.brollShots[1].notes = "";
        remoteNotes();
      } else {
        const dir = op === 4 ? "undo" : "redo";
        const before = structuredClone(live);
        const result = history[dir](live);
        if (!result.ok) { assert.equal(result.empty, true); continue; }
        replays++;
        if (JSON.stringify(live) === JSON.stringify(before)) continue;
        assert.equal(history[dir === "undo" ? "redo" : "undo"](live).ok, true);
        assert.deepEqual(live, before, `seed ${seed}, turn ${turn}, ${dir}`);
        assert.equal(history[dir](live).ok, true);
      }
    }
  }
  assert.ok(replays > 1000, `${replays} replays`);
});

test("people replay: same-name owner remapping survives repeated undo and redo (#529)", () => {
  const { live, history, edit, remoteNotes } = setup([person("old-cy", "Cy")]);
  edit((s) => { s.people = []; });
  edit((s) => { s.people.push(person("new-cy", "Cy")); s.brollShots[0].owner = "new-cy"; });
  remoteNotes();
  assert.deepEqual(history.sizes(), { undo: 1, redo: 0 });
  const before = structuredClone(live);
  for (let round = 0; round < 3; round++) {
    assert.equal(history.undo(live).ok, true);
    assert.deepEqual(live.people, [person("old-cy", "Cy")]);
    assert.equal(live.brollShots[0].owner, "old-cy");
    assert.equal(history.redo(live).ok, true);
    assert.deepEqual(live, before);
  }
});
