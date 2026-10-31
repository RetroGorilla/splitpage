import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../src/core/migrate.ts";
import { sectionForScene, sectionGroups } from "../../src/core/document/sections.ts";
import { mergeStateFields } from "../../src/core/merge/states.ts";
import { fakeMigration } from "./migrate-ports.ts";
import { fakePorts } from "./merge/fakes.ts";

interface GroupFixture { id: string; name: string; scenes: string[] }

function documentOf(groups: GroupFixture[]): { rows: { id: string }[]; sections: { id: string; name: string; firstSceneId: string }[] } {
  return {
    rows: groups.flatMap(group => group.scenes.map(id => ({ id }))),
    sections: groups.flatMap(group => group.id && group.scenes[0]
      ? [{ id: group.id, name: group.name, firstSceneId: group.scenes[0] }] : [])
  };
}

test("sections: seeded section operations against scene edits preserve identities and every surviving scene", () => {
  let seed = 3101031;
  const random = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
  let serial = 0;
  const scene = (): string => "r" + serial++;
  for (let trial = 0; trial < 1000; trial++) {
    const base: GroupFixture[] = Array.from({ length: 2 + random(6) }, (_, i) => ({
      id: i ? "s" + i : "", name: "Section " + i, scenes: Array.from({ length: 1 + random(5) }, scene)
    }));
    const sectionSide = structuredClone(base), sceneSide = structuredClone(base);
    const sectionIndex = 1 + random(base.length - 1);
    const chosen = base[sectionIndex];
    assert.ok(chosen);
    const operation = trial % 4;
    if (operation === 0) {
      const [moving] = sectionSide.splice(sectionIndex, 1);
      assert.ok(moving);
      sectionSide.splice(1 + random(sectionSide.length), 0, moving);
    } else if (operation === 1) {
      const group = sectionSide[sectionIndex];
      assert.ok(group);
      group.name = "Renamed " + trial;
    } else if (operation === 2) {
      const [removed] = sectionSide.splice(sectionIndex, 1), previous = sectionSide[sectionIndex - 1];
      assert.ok(removed && previous);
      previous.scenes.push(...removed.scenes);
    } else {
      const group = sectionSide[0];
      assert.ok(group);
      const at = random(group.scenes.length);
      sectionSide.splice(1, 0, { id: "added", name: "Added", scenes: group.scenes.splice(at) });
    }
    for (let edit = 0, count = 1 + random(8); edit < count; edit++) {
      const populated = sceneSide.filter(group => group.scenes.length);
      const source = populated[random(populated.length)];
      assert.ok(source);
      const at = random(source.scenes.length);
      const action = random(4);
      if (action === 0) source.scenes.splice(at, 0, scene());
      else if (action === 1) {
        if (sceneSide.reduce((n, group) => n + group.scenes.length, 0) > 1) source.scenes.splice(at, 1);
      } else if (action === 2) source.scenes.splice(at, 1, scene(), scene());
      else {
        const target = sceneSide[random(sceneSide.length)];
        assert.ok(target);
        const [moved] = source.scenes.splice(at, 1);
        assert.ok(moved);
        target.scenes.splice(random(target.scenes.length + 1), 0, moved);
      }
    }
    const expected = structuredClone(sceneSide);
    if (operation === 0) expected.sort((a, b) => sectionSide.findIndex(group => group.id === a.id) - sectionSide.findIndex(group => group.id === b.id));
    if (operation === 1) {
      const group = expected.find(item => item.id === chosen.id);
      assert.ok(group);
      group.name = "Renamed " + trial;
    }
    if (operation === 2 && sceneSide[sectionIndex]?.scenes[0] === chosen.scenes[0]) {
      const [removed] = expected.splice(sectionIndex, 1);
      const previous = expected.slice(0, sectionIndex).reverse().find(group => !group.id || group.scenes.length);
      assert.ok(removed && previous);
      previous.scenes.push(...removed.scenes);
    }
    const original = documentOf(base), edited = documentOf(sectionSide), other = documentOf(sceneSide);
    for (const [mine, theirs] of [[edited, other], [other, edited]]) {
      const migration = fakeMigration();
      const state = migrateRows(mergeStateFields(migrateRows(structuredClone(original), migration.ports),
        migrateRows(structuredClone(mine), migration.ports), migrateRows(structuredClone(theirs), migration.ports), fakePorts(() => [])).merged, migration.ports);
      const label = "seed 3101031 trial " + trial + " operation " + operation + " reversed " + (mine === other);
      assert.deepEqual(state.rows.map(row => row.id).sort(), other.rows.map(row => row.id).sort(), label + " scene conservation");
      const groups = sectionGroups(state);
      assert.equal(new Set(groups.map(group => group.section.id)).size, groups.length, label + " unique identity");
      assert.ok(groups.every(group => state.rows[group.start]?.id === group.section.firstSceneId && group.end > group.start), label + " first surviving anchor");
      if (operation < 3) {
        const wanted = documentOf(expected);
        assert.deepEqual(state.rows.map(row => row.id), wanted.rows.map(row => row.id), label + " membership and order " + JSON.stringify({ base, sectionSide, sceneSide }));
        assert.deepEqual(state.sections ?? [], wanted.sections, label + " identity and name " + JSON.stringify({ base, sectionSide, sceneSide }));
      } else {
        const first = mine === edited ? sectionSide : sceneSide, second = mine === edited ? sceneSide : sectionSide;
        for (const row of state.rows) {
          const before = base.find(group => group.scenes.includes(row.id))?.id;
          const mineGroup = first.find(group => group.scenes.includes(row.id))?.id;
          const theirGroup = second.find(group => group.scenes.includes(row.id))?.id;
          const expectedGroup = mineGroup === undefined ? theirGroup : theirGroup === undefined || theirGroup === before ? mineGroup : theirGroup;
          assert.equal(sectionForScene(state, row.id)?.id ?? "", expectedGroup, label + " new boundary membership " + row.id);
        }
      }
    }
  }
});
