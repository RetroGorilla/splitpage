import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual as equal } from "node:util";
import { MODES } from "../native-chosen/engine.ts";
import { GENERATED_SPEC, generateHistory } from "../native-chosen/generate.ts";
import { specOf } from "../native-chosen/kit.ts";
import { generated, histories } from "../native-delete/histories.ts";
import type { DeleteHistory } from "../native-delete/histories.ts";
import { generate, namedHistories } from "../native-moves/e10-model.ts";
import { auditCrossings } from "./crossings.ts";
import { forkEdits, predictForks } from "./fork-model.ts";
import { forkSnapshot, replay } from "./replay.ts";
import type { KeptStep, ReplayResult } from "./replay.ts";
import { e10Command, e10Spec, e9Command } from "./sets.ts";

function tally() {
  const problems = new Map<string, string[]>();
  const stale = new Map<string, string[]>();
  const missing: [string | number, string[]][] = [];
  const repeated: [string | number, string[]][] = [];
  let runs = 0, commands = 0, rank = 0, missingRank = 0, orphans = 0, doubled = 0;
  return {
    add(result: ReplayResult, label: string | number, firstDelivery: boolean) {
      runs++;
      commands += result.count;
      if (result.stale.length) stale.set(String(label), result.stale);
      if (firstDelivery) {
        rank += Number(result.rankUse);
        missingRank += Number(result.missingRank);
        orphans += result.orphans.length;
        doubled += result.doubled.length;
        if (result.rankAt.length) missing.push([label, result.rankAt]);
        if (result.doubled.length) repeated.push([label, result.doubled]);
      }
      for (const issue of result.problems) {
        const key = issue.replace(/(?:step|delivery|settled copy) \d+/g, "step").replace(/:.*/, match => match.replace(/(?<=beat )\S+$/, "ID"));
        const known = problems.get(key) ?? [];
        problems.set(key, [...known, String(label)]);
      }
    },
    summary() {
      return { runs, commands, rank, missingRank, orphans, doubled, problems: [...problems.values()].reduce((sum, entries) => sum + entries.length, 0),
        samples: [...problems].slice(0, 16).map(([key, entries]) => [key, entries.length, entries.slice(0, 5)]),
        stale: [...stale].slice(0, 10), staleHistories: stale.size, missing, repeated };
    }
  };
}

test("E14 replays E9's 37 named histories and 2,220 generated runs", t => {
  const baseline = tally(), kept = tally();
  let status = 0, visual = 0;
  const run = (history: DeleteHistory, mode: (typeof MODES)[number], number: number): void => {
    const spec = specOf(history.initial);
    const steps = history.forks.flatMap((fork, by) => fork.map(cmd => ({ by, cmd: e9Command(cmd) })));
    for (const [keep, count] of [[false, baseline], [true, kept]] as const) {
      const expected = predictForks(history, keep), after = expected.forks.flat();
      if (keep) {
        const edits = forkEdits(history, expected.settled[0]?.stored ?? history.initial);
        status += edits.status;
        visual += edits.visual;
      }
      const result = replay(spec, steps, history.forks.length, keep, mode, number, undefined, {
        command: (replica, index) => assert.deepEqual(forkSnapshot(replica), after[index], history.name),
        settled: replica => assert.ok(expected.settled.some(state => equal(state, forkSnapshot(replica))), history.name)
      });
      count.add(result, history.name, true);
    }
  };
  for (const history of histories(1)) run(history, "reverse", 1);
  for (const [index, mode] of MODES.entries()) for (let n = 0; n < 12; n++) {
    const number = 12 * index + n;
    for (const history of generated(number)) run(history, mode, number);
  }
  t.diagnostic(JSON.stringify({ built: baseline.summary(), kept: kept.summary(), unseenInOrphans: { status, visual } }));
  assert.equal(kept.summary().runs, 2257);
  assert.equal(baseline.summary().problems, 0);
  assert.equal(kept.summary().problems, 0);
  assert.deepEqual({ status, visual }, { status: 61, visual: 61 });
});

test("E14 replays all 229 of E10's histories in five deliveries", t => {
  const baseline = tally(), kept = tally();
  let unseenEdits = 0;
  const all = [...namedHistories, ...Array.from({ length: 200 }, (_, i) => generate(i + 1))];
  for (const [index, history] of all.entries()) {
    const steps = history.steps.map((step): KeptStep => "from" in step ? step : { by: step.by, cmd: e10Command(step.command) });
    const writers = index < namedHistories.length ? 2 : 3;
    for (const [at, mode] of MODES.entries()) {
      const pair = [replay(e10Spec, steps, writers, false, mode, index * 5 + at), replay(e10Spec, steps, writers, true, mode, index * 5 + at)] as const;
      baseline.add(pair[0], history.label, at === 0);
      kept.add(pair[1], history.label, at === 0);
      if (history.kind === "delete while editing") {
        assert.equal(pair[0].state?.visuals.B, undefined, history.label);
        assert.equal(pair[0].state?.beats.B, undefined, history.label);
        assert.deepEqual(pair[1].state?.visuals.B, [{ insert: "BW" }], history.label);
        assert.equal(pair[1].state?.beats.B?.remote, "kept", history.label);
        assert.ok(pair[1].orphans.includes("B"), history.label);
        if (at === 0) unseenEdits++;
      }
    }
  }
  t.diagnostic(JSON.stringify({ built: baseline.summary(), kept: kept.summary(), unseenEdits }));
  assert.equal(kept.summary().runs, 1145);
  assert.equal(kept.summary().problems, 0);
});

for (const twins of [false, true]) test(`E14 replays E11's ${twins ? "200 double-split" : "600"} histories in five deliveries`, t => {
  const baseline = tally(), kept = tally(), size = twins ? 200 : 600;
  const crossings: Record<string, number> = {};
  for (let number = 1; number <= size; number++) {
    const { steps, thrown, crashed } = generateHistory(number, twins ? 28 : 40, twins, "cells");
    assert.deepEqual([thrown, crashed], [[], null], `generation ${number}`);
    for (const [at, mode] of MODES.entries()) {
      const built = replay(GENERATED_SPEC(), steps, 3, false, mode, number), variant = replay(GENERATED_SPEC(), steps, 3, true, mode, number);
      baseline.add(built, number, at === 0);
      kept.add(variant, number, at === 0);
      if (at === 0) auditCrossings(steps, built, variant, crossings);
    }
  }
  t.diagnostic(JSON.stringify({ built: baseline.summary(), kept: kept.summary(), crossings }));
  assert.equal(kept.summary().runs, size * 5);
  assert.equal(kept.summary().problems, 0);
});
