import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../src/core/migrate.ts";
import { sectionGroups } from "../../src/core/document/sections.ts";
import { mergeStateFields } from "../../src/core/merge/states.ts";
import { fakeMigration } from "./migrate-ports.ts";
import { fakePorts } from "./merge/fakes.ts";

interface GroupFixture { id: string; name: string; beats: string[] }

function documentOf(groups: GroupFixture[]): { rows: { id: string }[]; sections: { id: string; name: string; firstSceneId: string }[] } {
  return {
    rows: groups.flatMap(group => group.beats.map(id => ({ id }))),
    sections: groups.flatMap(group => group.id && group.beats[0]
      ? [{ id: group.id, name: group.name, firstSceneId: group.beats[0] }] : [])
  };
}

function mergeLaws(base: GroupFixture[] | null, mine: GroupFixture[], theirs: GroupFixture[], label: string): void {
  const migration = fakeMigration();
  const read = (groups: GroupFixture[]) => migrateRows(documentOf(groups), migration.ports);
  const original = base && read(base), left = read(mine), right = read(theirs);
  const layout = (doc: ReturnType<typeof read>) => ({ rows: doc.rows, sections: doc.sections ?? [] });
  const merge = (a: ReturnType<typeof read>, b: ReturnType<typeof read>) => migrateRows(
    mergeStateFields(original, a, b, fakePorts(() => [])).merged, migration.ports);
  for (const side of [left, right]) {
    const unchanged = original ?? read([]);
    assert.deepEqual(layout(merge(unchanged, side)), layout(side), label + " one-sided identity incoming");
    assert.deepEqual(layout(merge(side, unchanged)), layout(side), label + " one-sided identity local");
    assert.deepEqual(layout(merge(side, side)), layout(side), label + " idempotence");
  }
  for (const [local, incoming] of [[left, right], [right, left]] as const) {
    const result = merge(local, incoming);
    const survivors = new Set(result.rows.map(row => row.id));
    for (const group of sectionGroups(original ?? { rows: [] })) {
      const record = JSON.stringify(group.section);
      if (![local, incoming].every(side => sectionGroups(side).some(item => JSON.stringify(item.section) === record))) continue;
      if (!original?.rows.slice(group.start, group.end).some(row => survivors.has(row.id))) continue;
      assert.ok(sectionGroups(result).some(item => item.section.id === group.section.id), label + " unchanged populated identity survives " + group.section.id + " " + JSON.stringify({ base, mine, theirs, actual: layout(result) }));
    }
  }
}

test("sections: seeded section operations against scene edits preserve identities and every surviving scene", () => {
  const initialSeed = Number(process.env.SPLITPAGE_SECTION_SEED ?? 3101031);
  let seed = initialSeed;
  const random = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
  let serial = 0;
  const beat = (): string => "r" + serial++;
  for (let trial = 0; trial < 1000; trial++) {
    const base: GroupFixture[] = Array.from({ length: 2 + random(6) }, (_, i) => ({
      id: i ? "s" + i : "", name: "Section " + i, beats: Array.from({ length: 1 + random(5) }, beat)
    }));
    const sectionSide = structuredClone(base), beatSide = structuredClone(base);
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
      previous.beats.push(...removed.beats);
    } else {
      const candidates = sectionSide.filter((group, i) => !i || group.beats.length > 1);
      const group = candidates[random(candidates.length)];
      assert.ok(group);
      const at = group.id ? 1 + random(group.beats.length - 1) : random(group.beats.length);
      sectionSide.splice(sectionSide.indexOf(group) + 1, 0, { id: "added", name: "Added", beats: group.beats.splice(at) });
    }
    for (let edit = 0, count = 1 + random(8); edit < count; edit++) {
      const populated = beatSide.filter(group => group.beats.length);
      const source = populated[random(populated.length)];
      assert.ok(source);
      const at = random(source.beats.length);
      const action = random(4);
      if (action === 0) source.beats.splice(at, 0, beat());
      else if (action === 1) {
        if (beatSide.reduce((n, group) => n + group.beats.length, 0) > 1) source.beats.splice(at, 1);
      } else if (action === 2) source.beats.splice(at, 1, beat(), beat());
      else {
        const target = beatSide[random(beatSide.length)];
        assert.ok(target);
        const [moved] = source.beats.splice(at, 1);
        assert.ok(moved);
        target.beats.splice(random(target.beats.length + 1), 0, moved);
      }
    }
    const original = documentOf(base), edited = documentOf(sectionSide), other = documentOf(beatSide);
    mergeLaws(base, sectionSide, beatSide, "seed " + initialSeed + " trial " + trial);
    for (const [mine, theirs] of [[edited, other], [other, edited]]) {
      const migration = fakeMigration();
      const state = migrateRows(mergeStateFields(migrateRows(structuredClone(original), migration.ports),
        migrateRows(structuredClone(mine), migration.ports), migrateRows(structuredClone(theirs), migration.ports), fakePorts(() => [])).merged, migration.ports);
      const label = "seed " + initialSeed + " trial " + trial + " operation " + operation + " reversed " + (mine === other);
      assert.deepEqual(state.rows.map(row => row.id).sort(), other.rows.map(row => row.id).sort(), label + " scene conservation");
      const groups = sectionGroups(state);
      assert.equal(new Set(groups.map(group => group.section.id)).size, groups.length, label + " unique identity");
      assert.ok(groups.every(group => state.rows[group.start]?.id === group.section.firstSceneId && group.end > group.start), label + " first surviving anchor");
      const first = mine === edited ? sectionSide : beatSide, second = mine === edited ? beatSide : sectionSide;
      const expected = snapshotProjection(base, first, second, sectionSide, beatSide);
      const wanted = documentOf(expected);
      const detail = label + " " + JSON.stringify({ base, sectionSide, beatSide });
      assert.deepEqual(state.rows.map(row => row.id), wanted.rows.map(row => row.id), detail + " complete order");
      assert.deepEqual(state.sections ?? [], wanted.sections, detail + " identities, names and anchors");
    }
  }
});

function snapshotProjection(base: GroupFixture[], mine: GroupFixture[], theirs: GroupFixture[], sectionOrder: GroupFixture[], beatOrder: GroupFixture[]): GroupFixture[] {
  const present = (groups: GroupFixture[], id: string): GroupFixture | undefined => groups.find(group => group.id === id && group.beats.length);
  const names = new Map<string, string>();
  for (const group of sectionOrder) {
    const before = present(base, group.id), local = present(mine, group.id), incoming = present(theirs, group.id);
    if (before && ((!local && incoming?.name === before.name) || (!incoming && local?.name === before.name))) continue;
    const name = incoming && incoming.name !== before?.name ? incoming.name : local?.name ?? incoming?.name;
    if (name) names.set(group.id, name);
  }
  const assignments = new Map<string, string>();
  for (const beat of beatOrder.flatMap(group => group.beats)) {
    const original = base.find(group => group.beats.includes(beat));
    const observed = (side: GroupFixture[]): string | undefined => {
      const current = side.find(group => group.beats.includes(beat))?.id;
      if (current === undefined || !original?.id || present(side, original.id)) return current;
      const predecessor = base.slice(0, base.indexOf(original)).reverse().find(group => present(side, group.id))?.id ?? "";
      return current === predecessor ? original.id : current;
    };
    const local = observed(mine), incoming = observed(theirs);
    let assigned = local === undefined ? incoming ?? "" : incoming === undefined || incoming === original?.id ? local : incoming;
    if (assigned && !names.has(assigned)) {
      const localGroup = mine.find(group => group.beats.includes(beat))?.id;
      const incomingGroup = theirs.find(group => group.beats.includes(beat))?.id;
      assigned = localGroup === undefined ? incomingGroup ?? "" : incomingGroup === undefined || incomingGroup === original?.id ? localGroup : incomingGroup;
    }
    assignments.set(beat, assigned);
  }
  const active = new Set([...assignments.values()].filter(id => names.has(id)));
  const wanted = [{ id: "", name: "", beats: [] as string[] }, ...sectionOrder.filter(group => group.id && active.has(group.id)).map(group => ({ id: group.id, name: names.get(group.id) ?? "", beats: [] as string[] }))];
  for (const beat of beatOrder.flatMap(group => group.beats)) {
    let id = assignments.get(beat) ?? "";
    if (id && !active.has(id)) id = base.slice(0, base.findIndex(group => group.id === id)).reverse().find(group => active.has(group.id))?.id ?? "";
    const destination = wanted.find(group => group.id === id);
    assert.ok(destination);
    destination.beats.push(beat);
  }
  return wanted;
}

test("sections: seeded edits on both sides reconcile names, removal, additions and complete order", () => {
  const initialSeed = Number(process.env.SPLITPAGE_SECTION_SEED ?? 3101031);
  let seed = initialSeed;
  const random = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
  const clone = (groups: GroupFixture[]): GroupFixture[] => structuredClone(groups);
  const atGroup = (groups: GroupFixture[], index: number): GroupFixture => {
    const group = groups[index];
    assert.ok(group);
    return group;
  };
  function remove(groups: GroupFixture[], at: number): void {
    const [group] = groups.splice(at, 1), before = groups[at - 1];
    assert.ok(group && before);
    before.beats.push(...group.beats);
  }
  function add(groups: GroupFixture[], at: number, offset: number, id: string): void {
    const group = groups[at];
    assert.ok(group);
    groups.splice(at + 1, 0, { id, name: "Added " + id, beats: group.beats.splice(offset) });
  }
  function move(groups: GroupFixture[]): void {
    const from = 1 + random(groups.length - 1);
    const to = 1 + (from + random(groups.length - 2)) % (groups.length - 1);
    const [group] = groups.splice(from, 1);
    assert.ok(group);
    groups.splice(to, 0, group);
  }
  const covered = new Set<number>();
  for (let trial = 0; trial < 1000; trial++) {
    let serial = 0;
    const base: GroupFixture[] = Array.from({ length: 4 + random(4) }, (_, i) => ({
      id: i ? "s" + i : "", name: "Section " + i,
      beats: Array.from({ length: 2 + random(5) }, () => "r" + serial++)
    }));
    let left = clone(base), right = clone(base);
    let common: GroupFixture[] | null = base;
    const at = 1 + random(base.length - 1), group = base[at];
    assert.ok(group);
    const operation = trial % 11;
    covered.add(operation);
    let expected: (incoming: GroupFixture[]) => GroupFixture[];
    if (operation === 0) {
      atGroup(left, at).name = "Local " + trial;
      atGroup(right, at).name = "Incoming " + trial;
      expected = incoming => incoming;
    } else if (operation === 1) {
      atGroup(left, at).name = "Renamed " + trial;
      remove(right, at);
      atGroup(right, 0).beats.unshift("new");
      const wanted = clone(left);
      atGroup(wanted, 0).beats.unshift("new");
      expected = () => wanted;
    } else if (operation === 2) {
      const offset = 1 + random(group.beats.length - 1);
      add(left, at, offset, "left"); add(right, at, offset, "right");
      expected = incoming => incoming;
    } else if (operation === 3) {
      move(left); move(right);
      expected = incoming => incoming;
    } else if (operation === 4) {
      const offset = 1 + random(group.beats.length - 1);
      add(left, at, offset, "mid");
      atGroup(right, at).name = "Renamed " + trial;
      const wanted = clone(left);
      atGroup(wanted, at).name = atGroup(right, at).name;
      expected = () => wanted;
    } else if (operation === 5) {
      common = [{ id: "", name: "", beats: base.flatMap(item => item.beats) }];
      left = clone(common); right = clone(common);
      const offset = 1 + random(atGroup(left, 0).beats.length - 1);
      add(left, 0, offset, "left"); add(right, 0, offset, "right");
      expected = incoming => incoming;
    } else if (operation === 6) {
      common = null;
      right = [{ id: "", name: "", beats: base.flatMap(item => item.beats) }];
      atGroup(left, at).name = "Restored " + trial;
      expected = () => left;
    } else if (operation === 7) {
      remove(left, at);
      const anchor = atGroup(right, at).beats.shift();
      assert.ok(anchor);
      if (random(2)) atGroup(right, 0).beats.unshift(anchor);
      const wanted = clone(right);
      remove(wanted, at);
      expected = () => wanted;
    } else if (operation === 8) {
      remove(left, at);
      const other = at === base.length - 1 ? 1 : at + 1;
      atGroup(right, other).name = "Other " + trial;
      const wanted = clone(right);
      remove(wanted, at);
      expected = () => wanted;
    } else if (operation === 9) {
      common = null;
      atGroup(left, at).name = "Local " + trial;
      atGroup(right, at).name = "Incoming " + trial;
      expected = incoming => incoming;
    } else {
      const removedAt = 2 + random(base.length - 2);
      const predecessor = atGroup(right, removedAt - 1);
      const moved = predecessor.beats.splice(0);
      remove(right, removedAt);
      if (random(2)) atGroup(right, 0).beats.unshift(...moved);
      if (random(2)) predecessor.name = "Retained " + trial;
      if (random(2)) remove(left, removedAt);
      expected = () => right;
    }
    mergeLaws(common, left, right, "seed " + initialSeed + " paired trial " + trial);
    for (const [mine, theirs] of [[left, right], [right, left]] as const) {
      const migration = fakeMigration();
      const result = mergeStateFields(common && migrateRows(documentOf(common), migration.ports),
        migrateRows(documentOf(mine), migration.ports), migrateRows(documentOf(theirs), migration.ports), fakePorts(() => []));
      const actual = migrateRows(result.merged, migration.ports), wanted = documentOf(expected(theirs));
      const label = "seed " + initialSeed + " trial " + trial + " pair " + operation + " reversed " + (mine === right) +
        " " + JSON.stringify({ base: common, mine, theirs });
      const ids = actual.rows.map(row => row.id), wantedIds = wanted.rows.map(row => row.id);
      assert.equal(new Set(ids).size, ids.length, label + " no duplicates");
      assert.deepEqual([...ids].sort(), [...wantedIds].sort(), label + " no scene loss");
      assert.deepEqual(ids, wantedIds, label + " complete order");
      assert.deepEqual(actual.sections ?? [], wanted.sections, label + " identities, names and anchors");
    }
  }
  assert.equal(covered.size, 11);
});
