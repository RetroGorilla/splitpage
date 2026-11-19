import assert from "node:assert/strict";
import test from "node:test";
import { KeptReplica } from "../../src/native-kept/replica.ts";
import { crossedEdits, lossKinds, readCrossings } from "../../src/native-kept-recount/losses.ts";
import { MODES } from "../native-chosen/engine.ts";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { perform, play, rowOf, shown } from "../native-chosen/play.ts";
import { justTwo, split, remove, act, setField, undo } from "../native-rank-undo/histories.ts";
import { missingContainers } from "./reachability.ts";

const makeKept = (client: number) => new KeptReplica(client);

test("E16 generated E11 histories and forward accepted-loss counts", t => {
  const results = [false, true].map(() => ({
    counts: lossKinds.map(() => 0), affected: lossKinds.map(() => 0), tags: [0, 0], crossings: new Map<string, number>(),
    problems: new Map<string, string>(), missing: new Map<string, string>(), stale: new Set<string>(),
    fieldMisses: new Set<string>(), tagSeeds: new Set<number>()
  }));
  let requested = 0;
  for (const twins of [false, true]) for (let seed = 1; seed <= (twins ? 200 : 600); seed++) {
    const { steps, thrown, crashed } = generateHistory(seed, 40, twins, "cells");
    assert.deepEqual([thrown, crashed], [[], null]);
    if (!twins) requested += steps.filter(step => "cmd" in step && step.cmd.op === "format"
      && step.cmd.key.startsWith("t:") && step.cmd.on && step.cmd.to > step.cmd.from).length;
    for (const [variant, totals] of results.entries()) {
      if (!variant && twins) continue;
      const label = `${twins ? "twin" : "mixed"} ${seed}`;
      let lostTags: number | undefined;
      for (const [at, mode] of MODES.entries()) {
        const result = play({
          spec: GENERATED_SPEC(), steps, writers: 3, mode, seed: seed * 7 + at, names: "cells",
          ...(variant ? { make: makeKept, keepCutVisuals: true } : {}),
          skip(replica, cmd, step) {
            if (!variant) return false;
            const view = shown(replica), rows = [...view.rows.keys()];
            if (cmd.op === "format" && rowOf(view, cmd.id) === undefined && replica.beats.has(cmd.id)) {
              const before = replica.encode();
              perform(replica, cmd);
              assert.deepEqual(replica.encode(), before);
              totals.stale.add(`${label} step ${step} format`);
              return true;
            }
            if (cmd.op === "join" && rows.indexOf(cmd.id) <= 0) {
              totals.stale.add(`${label} step ${step} join`);
              return true;
            }
            if (cmd.op === "move" && cmd.drop.unit !== "scene"
              && [cmd.drop.first, cmd.drop.last, cmd.drop.target].some(id => typeof id === "string" && !rows.includes(id))) {
              totals.stale.add(`${label} step ${step} move`);
              assert.equal(replica.drop(cmd.drop), false);
              return true;
            }
            return false;
          },
          inspect(replica, step) {
            const missing = missingContainers(replica);
            if (missing.length && !totals.missing.has(label)) totals.missing.set(label, `${mode} step ${step}: ${missing.join(", ")}`);
          },
          ...(at === 0 && !twins ? { settled(replica, events) {
            const edits = crossedEdits(events, index => {
              const step = steps[index];
              return step && "by" in step ? step.cmd : undefined;
            });
            for (const { id, index, facet, live, matches } of readCrossings(replica, edits)) {
              const key = [facet, live ? "shown" : "removed", matches ? "matches" : "missing"].join("/");
              totals.crossings.set(key, (totals.crossings.get(key) ?? 0) + 1);
              if (variant && !matches) totals.fieldMisses.add(`${seed} step ${index} ${id} record ${replica.beats.has(id)}`);
            }
          } } : {})
        });
        const problem = result.never.find(message => !/changed scene|no visual cell|no record/.test(message));
        if (problem && !totals.problems.has(label)) totals.problems.set(label, `${mode}: ${problem}`);
        if (twins) continue;
        if (at === 0) {
          for (const [index, kind] of lossKinds.entries()) {
            const count = index === 4 ? result.timing[kind]?.offline ?? 0 : result.kinds[kind] ?? 0;
            totals.counts[index] = (totals.counts[index] ?? 0) + count;
            totals.affected[index] = (totals.affected[index] ?? 0) + Number(count > 0);
          }
          totals.tags[0] = (totals.tags[0] ?? 0) + result.tags.requested;
        }
        if (result.tags.lost.length) lostTags ??= result.tags.lost.length;
      }
      if (lostTags) totals.tagSeeds.add(seed);
      totals.tags[1] = (totals.tags[1] ?? 0) + (lostTags ?? 0);
    }
  }
  for (const totals of results) t.diagnostic(JSON.stringify({
    ...totals, crossings: Object.fromEntries(totals.crossings), problems: [...totals.problems],
    missing: [...totals.missing], stale: [...totals.stale], fieldMisses: [...totals.fieldMisses], tagSeeds: [...totals.tagSeeds]
  }));
  assert.equal(requested, 845);
  for (const totals of results) {
    assert.deepEqual(totals.tags, [requested, 5]);
    assert.deepEqual([...totals.tagSeeds], [53, 137, 211, 352, 447]);
    assert.deepEqual([...totals.problems], []);
    assert.deepEqual([...totals.missing], []);
  }
  const [built, kept] = results;
  assert.deepEqual(built?.counts, [131, 106, 3, 1, 1, 3, 3]);
  assert.deepEqual(kept?.counts, [1, 0, 3, 1, 1, 3, 3]);
  assert.deepEqual([...(kept?.fieldMisses ?? [])], ["497 step 29 N05 record false"]);
  assert.deepEqual(Object.fromEntries(kept?.crossings ?? []), {
    "field/removed/matches": 120, "visual/removed/matches": 103, "field/shown/matches": 6,
    "visual/shown/matches": 8, "field/removed/missing": 1
  });
});

test("E16 crossing count detects a muted visual command and a falsified reading", () => {
  const steps = [act(0, { op: "type", id: "B", field: "visual", at: 0, text: "x" }), remove(1, "B")];
  for (const muted of [false, true]) {
    let matches: boolean[] | undefined;
    const result = play({
      spec: justTwo(), steps, writers: 2, mode: "forward", seed: 1, names: "cells",
      make: makeKept, keepCutVisuals: true, ...(muted ? { mute: { step: 0, call: 0 } } : {}),
      settled(replica, events) {
        const edits = crossedEdits(events, index => index === 0 ? { op: "type", id: "B", field: "visual", at: 0, text: "x" } : undefined);
        matches = readCrossings(replica, edits).map(edit => edit.matches);
        assert.deepEqual(readCrossings(replica, edits, () => "").map(edit => edit.matches), [false]);
      }
    });
    assert.deepEqual(matches, [!muted]);
    assert.equal(result.local.some(problem => problem.includes("typing")), muted);
  }
});

test("E16 a split muting control suppresses the creation-undo crossing at its source", () => {
  const spec = justTwo(), steps = [split(0, "B", 0, "N")];
  const actual = play({ spec, steps, writers: 2, mode: "forward", seed: 1, names: "cells", make: makeKept });
  const muted = play({ spec, steps, writers: 2, mode: "forward", seed: 1, names: "cells", make: makeKept, mute: { step: 0, call: 0 } });
  assert.ok(actual.lines.some(line => line.startsWith("N:")));
  assert.ok(!muted.lines.some(line => line.startsWith("N:")));
  assert.ok(muted.local.some(problem => problem.includes("split")));
});

test("E16 seed 497's missing field also disappears when there is no cut", () => {
  const create = split(0, "B", 1, "N");
  const steps = [create, { from: 0, to: 1 }, { from: 0, to: 2 }, setField(1, "N", "lens", "wide")];
  for (const cut of [false, true]) {
    let hasRecord: boolean | undefined;
    const result = play({
      spec: justTwo(), steps: [...steps, ...(cut ? [remove(2, "N")] : []), undo(0)],
      writers: 3, mode: "forward", seed: 497, names: "cells", make: makeKept, keepCutVisuals: true,
      settled(replica) { hasRecord = replica.beats.has("N"); }
    });
    assert.deepEqual(result.never, []);
    assert.equal(hasRecord, false);
    assert.equal(result.kinds[lossKinds[0] ?? ""], cut ? 1 : undefined);
  }
});
