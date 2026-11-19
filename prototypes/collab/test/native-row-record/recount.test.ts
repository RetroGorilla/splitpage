import assert from "node:assert/strict";
import test from "node:test";
import { crossedEdits, lossKinds, readCrossings } from "../../src/native-kept-recount/losses.ts";
import { ROW_MAKERS } from "../../src/native-row-record/variants.ts";
import { MODES } from "../native-chosen/engine.ts";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { perform, play, rowOf, shown } from "../native-chosen/play.ts";
import { missingContainers } from "../native-kept-recount/reachability.ts";

interface Recount {
  counts: number[]; tags: number[]; tagSeeds: number[]; crossings: Record<string, number>; fieldMisses: string[];
  problems: string[]; missing: string[]; stale: number; local: string[];
}

// why: E16's loop from `native-kept-recount/losses.test.ts` for its kept variant, with the replica made by each option
function recount(option: "K" | "R" | "U" | "U0"): Recount {
  const counts = lossKinds.map(() => 0), tags = [0, 0], tagSeeds: number[] = [], crossings = new Map<string, number>();
  const fieldMisses = new Set<string>(), problems = new Map<string, string>(), missing = new Map<string, string>(), stale = new Set<string>(), local: string[] = [];
  for (const twins of [false, true]) for (let seed = 1; seed <= (twins ? 200 : 600); seed++) {
    const { steps } = generateHistory(seed, 40, twins, "cells");
    const label = `${twins ? "twin" : "mixed"} ${seed}`;
    let lostTags: number | undefined;
    for (const [at, mode] of MODES.entries()) {
      const result = play({
        spec: GENERATED_SPEC(), steps, writers: 3, mode, seed: seed * 7 + at, names: "cells", make: client => ROW_MAKERS[option](client), keepCutVisuals: true,
        skip(replica, cmd, step) {
          const view = shown(replica), rows = [...view.rows.keys()];
          if (cmd.op === "format" && rowOf(view, cmd.id) === undefined && replica.beats.has(cmd.id)) {
            const before = replica.encode();
            perform(replica, cmd);
            assert.deepEqual(replica.encode(), before);
            stale.add(`${label} step ${step} format`);
            return true;
          }
          if (cmd.op === "join" && rows.indexOf(cmd.id) <= 0) { stale.add(`${label} step ${step} join`); return true; }
          if (cmd.op === "move" && cmd.drop.unit !== "scene" && [cmd.drop.first, cmd.drop.last, cmd.drop.target].some(id => typeof id === "string" && !rows.includes(id))) {
            stale.add(`${label} step ${step} move`);
            assert.equal(replica.drop(cmd.drop), false);
            return true;
          }
          return false;
        },
        inspect(replica, step) {
          const found = missingContainers(replica);
          if (found.length && !missing.has(label)) missing.set(label, `${mode} step ${step}: ${found.join(", ")}`);
        },
        ...(at === 0 && !twins ? { settled(replica, events) {
          const edits = crossedEdits(events, index => { const step = steps[index]; return step && "by" in step ? step.cmd : undefined; });
          for (const { id, index, facet, live, matches } of readCrossings(replica, edits)) {
            const key = [facet, live ? "shown" : "removed", matches ? "matches" : "missing"].join("/");
            crossings.set(key, (crossings.get(key) ?? 0) + 1);
            if (!matches) fieldMisses.add(`${seed} step ${index} ${id} record ${replica.beats.has(id)}`);
          }
        } } : {})
      });
      const problem = result.never[0];
      if (problem && !problems.has(label)) problems.set(label, `${mode}: ${problem}`);
      if (at === 0) local.push(...result.local.map(note => `${label} ${note}`));
      if (twins) continue;
      if (at === 0) {
        for (const [index, kind] of lossKinds.entries()) counts[index] = (counts[index] ?? 0) + (index === 4 ? result.timing[kind]?.offline ?? 0 : result.kinds[kind] ?? 0);
        tags[0] = (tags[0] ?? 0) + result.tags.requested;
      }
      if (result.tags.lost.length) lostTags ??= result.tags.lost.length;
    }
    if (lostTags) tagSeeds.push(seed);
    tags[1] = (tags[1] ?? 0) + (lostTags ?? 0);
  }
  return {
    counts, tags, tagSeeds, crossings: Object.fromEntries(crossings), fieldMisses: [...fieldMisses],
    problems: [...problems.values()], missing: [...missing.values()], stale: stale.size, local
  };
}

const KEPT = {
  counts: [1, 0, 3, 1, 1, 3, 3], tags: [845, 5], tagSeeds: [53, 137, 211, 352, 447],
  crossings: { "field/removed/matches": 120, "visual/removed/matches": 103, "field/shown/matches": 6, "visual/shown/matches": 8, "field/removed/missing": 1 },
  fieldMisses: ["497 step 29 N05 record false"], problems: [], missing: [], stale: 6, local: []
};

// why: E16's figures for its kept variant are K's; the no-op U must give them back on the whole set
const EXPECTED: Record<"K" | "R" | "U" | "U0", Recount> = {
  K: KEPT, R: KEPT, U0: KEPT,
  U: {
    ...KEPT, counts: [0, 0, 3, 1, 1, 3, 3],
    crossings: { "field/removed/matches": 121, "visual/removed/matches": 103, "field/shown/matches": 6, "visual/shown/matches": 8 },
    fieldMisses: [],
    local: [252, 287, 367].map(seed => `mixed ${seed}`)
  }
};

test("E17 E16's recount under K, R, U and the no-op U", t => {
  for (const option of ["K", "R", "U", "U0"] as const) {
    const result = recount(option);
    t.diagnostic(`${option} ${JSON.stringify(result)}`);
    assert.deepEqual({ ...result, local: result.local.map(note => note.slice(0, note.indexOf(" letter"))) }, EXPECTED[option], option);
    for (const note of result.local) assert.match(note, /letter \S+ was typing in a new beat lost when its creator undoes the creation unseen but is shown$/);
  }
});
