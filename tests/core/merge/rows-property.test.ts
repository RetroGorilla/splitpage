import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import { mergeRows } from "../../../src/core/merge/rows.ts";
import { textMergeContext } from "../../../src/core/merge/text-field.ts";
import { fakeMigration } from "../migrate-ports.ts";
import { fakePorts } from "./fakes.ts";

for (const movesOnly of [true, false]) {
  test("rows: seeded " + (movesOnly ? "reorders" : "scene operations") + " preserve merge laws without sections", () => {
    const initialSeed = 103031;
    let seed = initialSeed;
    const random = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
    const migration = fakeMigration();
    const read = (ids: string[]) => migrateRows({ rows: ids.map(id => ({ id })) }, migration.ports);
    for (let trial = 0; trial < 1000; trial++) {
      let serial = 0;
      const scene = (): string => "r" + serial++;
      const baseIds = Array.from({ length: 2 + random(20) }, scene);
      const change = (): string[] => {
        const ids = [...baseIds];
        for (let edit = 0, count = 1 + random(8); edit < count; edit++) {
          const at = random(ids.length), action = movesOnly ? 3 : random(4);
          if (action === 0) ids.splice(at, 0, scene());
          else if (action === 1) {
            if (ids.length > 1) ids.splice(at, 1);
          } else if (action === 2) ids.splice(at, 1, scene(), scene());
          else {
            const [moved] = ids.splice(at, 1);
            assert.ok(moved);
            ids.splice(random(ids.length + 1), 0, moved);
          }
        }
        return ids;
      };
      const base = read(baseIds), left = read(change()), right = read(change());
      const before = structuredClone([base, left, right]);
      const merge = (mine: typeof base, theirs: typeof base) => {
        const ports = fakePorts(() => []);
        return mergeRows(base, mine, theirs, {
          ...ports, text: textMergeContext(ports.decode, base, mine, theirs), conflicts: [],
          stats: { rowsFromMe: 0, rowsFromThem: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 }
        });
      };
      const label = "seed " + initialSeed + " trial " + trial;
      for (const side of [left, right]) {
        const detail = label + " " + JSON.stringify({ base: baseIds, changed: side.rows.map(row => row.id) });
        assert.deepEqual(merge(side, base), side.rows, detail + " one-sided identity local");
        assert.deepEqual(merge(base, side), side.rows, detail + " one-sided identity incoming");
        assert.deepEqual(merge(side, side), side.rows, detail + " idempotence");
      }
      for (const [mine, theirs] of [[left, right], [right, left]] as const) {
        const rows = merge(mine, theirs), ids = rows.map(row => row.id);
        const mineIds = new Set(mine.rows.map(row => row.id)), theirIds = new Set(theirs.rows.map(row => row.id));
        const expected = new Set([...mineIds, ...theirIds].filter(id => !baseIds.includes(id) || (mineIds.has(id) && theirIds.has(id))));
        assert.equal(new Set(ids).size, ids.length, label + " no duplicate scenes");
        assert.deepEqual([...ids].sort(), [...expected].sort(), label + " additions survive and deletion beats unchanged content");
        assert.deepEqual(merge(mine, theirs), rows, label + " deterministic result");
      }
      assert.deepEqual([base, left, right], before, label + " inputs unchanged");
    }
  });
}
