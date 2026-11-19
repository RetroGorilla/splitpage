import assert from "node:assert/strict";
import test from "node:test";
import { betweenRanks, MOVE_DESIGNS } from "../../src/native-moves/ranks.ts";
import { DELIVERIES } from "../native/e5-histories.ts";
import { required } from "../native/e5-model.ts";
import { generate, namedHistories } from "./e10-model.ts";
import type { E10History } from "./e10-model.ts";
import { run } from "./e10-run.ts";
import type { E10Run } from "./e10-run.ts";

test("E10: rank allocation between offline peers and under repeated insertion", t => {
  const low = betweenRanks(null, null, 1, 1), high = betweenRanks(null, null, 2, 1);
  const tieGap = betweenRanks(low, high, 3, 1);
  assert.ok(low < tieGap && tieGap < high);
  let worst = 0;
  for (const toward of ["left", "right", "longer"] as const) {
    let left = low, right = high, longest = 0;
    for (let i = 1; i <= 1000; i++) {
      const rank = betweenRanks(left, right, 4, i);
      assert.ok(left < rank && rank < right);
      longest = Math.max(longest, rank.length);
      if (toward === "left" || (toward === "longer" && rank.length >= left.length && i % 2 === 0)) right = rank;
      else left = rank;
    }
    worst = Math.max(worst, longest);
    t.diagnostic(`${toward}: ${longest} ASCII characters`);
  }
  assert.ok(worst > 0);
});

function outcome(history: E10History, runs: E10Run[]): "preferred" | "other" | "broken" {
  if (runs.some(result => result.problems.length || result.local.length || !result.view)) return "broken";
  if (runs.some(result => result.preferences.length || (result.view && !history.preferred(result.view)))) return "other";
  return "preferred";
}

test("E10: hand-written collisions on two copies and late loads", t => {
  for (const history of namedHistories) {
    for (const design of MOVE_DESIGNS) {
      const runs = DELIVERIES.map(delivery => run(design, history, delivery, 2));
      const first = required(runs[0], "forward delivery");
      const sample = runs.find(result => result.problems.length || result.local.length) ?? first;
      assert.deepEqual(runs.map(result => result.view), runs.map(() => first.view), `${design}, ${history.label}, cross-delivery view`);
      const result = outcome(history, runs);
      if (["join moving", "join next", "split landing", "same beat", "delete moving", "drop between tied halves",
        "drop onto heading", "two splits", "undo real deletion"].includes(history.kind)) assert.equal(result, "preferred", `${design}, ${history.label}`);
      if (history.kind === "split moving") assert.equal(result, design === "flat" ? "other" : "preferred", design);
      t.diagnostic(JSON.stringify({ kind: history.kind, design, result, order: sample.view?.order.join(" "),
        rows: sample.view?.rows.filter(row => row.start || row.members.length > 1), presses: sample.presses,
        problems: sample.problems, local: sample.local, preferences: sample.preferences, history: sample.failureHistory }));
    }
  }
});

test("E10: collision outcomes per three-writer history across five deliveries", t => {
  const size = Number(process.env.E10_SEEDS ?? 200);
  for (const design of MOVE_DESIGNS) {
    const counts: Record<string, Record<ReturnType<typeof outcome>, number>> = {}, examples: Record<string, unknown> = {},
      alternate: Record<string, string> = {};
    const breakdown = { randomDrops: 0, randomDropsStillOther: 0, oldPressCheck: 0, oldPressStillOther: 0, hiddenHeading: {} as Record<string, number>,
      withoutHeading: {} as Record<string, number>, remaining: {} as Record<string, number>, scenesLeftBehind: 0,
      headingChanges: {} as Record<string, number>, witnesses: {} as Record<string, [string, string]> };
    const tallyKind = (bucket: Record<string, number>, history: E10History): void => {
      bucket[history.kind] = (bucket[history.kind] ?? 0) + 1;
    };
    for (let i = 1; i <= size; i++) {
      const history = generate(i), runs = DELIVERIES.map(delivery => run(design, history, delivery, 3));
      const result = outcome(history, runs), tally = counts[history.kind] ??= { preferred: 0, other: 0, broken: 0 };
      tally[result]++;
      const sample = runs.find(item => item.problems.length || item.local.length);
      if (sample && !examples[history.kind]) examples[history.kind] = { seed: i, ...sample };
      if (result === "other" && !alternate[history.kind]) alternate[history.kind] = `${i}: ${runs[0]?.view?.order.join(" ")}`;
      const first = required(runs[0], "forward delivery");
      assert.deepEqual(runs.map(result => result.view), runs.map(() => first.view), `${design}, ${history.label}, cross-delivery view`);
      assert.deepEqual(runs.map(run => run.preferences), runs.map(() => first.preferences), `${design}, ${history.label}, cross-delivery presses`);
      const remotePress = history.kind === "undo remote move" || history.kind === "undo remote edit";
      if (result !== "other" && !(result === "preferred" && remotePress)) continue;
      if (history.steps.some(step => "by" in step && step.by === 2 && step.command.op === "move")) {
        breakdown.randomDrops++;
        if (result === "other") breakdown.randomDropsStillOther++;
        continue;
      }
      if (remotePress) {
        breakdown.oldPressCheck++;
        if (result === "other") breakdown.oldPressStillOther++;
      }
      if (result !== "other") continue;
      const steps = history.steps.filter(step => !("by" in step && step.by === 2 &&
        ((step.command.op === "heading" && step.command.newId === "#T") ||
          (step.command.op === "removeHeading" && step.command.id === "#T"))));
      const without = run(design, { ...history, steps }, "forward", 3);
      if (outcome(history, [without]) === "preferred") tallyKind(remotePress ? breakdown.withoutHeading : breakdown.hiddenHeading, history);
      else tallyKind(breakdown.remaining, history);
      const before = required(first.view, "original view").order.join(" ");
      const after = required(without.view, "view without the third heading").order.join(" ");
      if (before !== after) {
        tallyKind(breakdown.headingChanges, history);
        breakdown.witnesses[history.kind] ??= [before, after];
      }
      if ((history.kind === "rename moved heading" || history.kind === "remove moved heading") &&
          ["E", "F", "G", "H"].every(id => first.view?.rows.some(row => row.id === id && row.scene === "#P"))) {
        breakdown.scenesLeftBehind++;
      }
    }
    assert.equal(Object.values(counts).reduce((sum, counts) => sum + counts.preferred + counts.other + counts.broken, 0), size);
    t.diagnostic(JSON.stringify({ design, size, counts, examples, alternate, breakdown }));
  }
});

test("E10: undo leaves C in the other scene until the first writer redoes", () => {
  const history = required(namedHistories.find(history => history.kind === "undo remote move"), "undo of a move");
  for (const delivery of DELIVERIES) {
    const undone = run("run", { ...history, steps: history.steps.slice(0, -1) }, delivery, 2);
    assert.deepEqual(undone.problems, []);
    assert.deepEqual(undone.local, []);
    assert.equal(undone.view?.rows.find(row => row.id === "C")?.scene, "#Q");
    const redone = run("run", history, delivery, 2);
    assert.deepEqual(redone.problems, []);
    assert.deepEqual(redone.local, []);
    assert.equal(redone.view?.rows.find(row => row.id === "C")?.scene, "#P");
  }
});

test("E10: silence individual writes and whole undo presses", t => {
  for (const design of MOVE_DESIGNS) {
    const totals: E10Run["controls"] = {};
    for (const history of [...namedHistories, ...Array.from({ length: 20 }, (_, i) => generate(i + 1))]) {
      const writers = history.label.startsWith("generated") ? 3 : 2;
      const { controls } = run(design, history, "forward", writers, true);
      for (const [key, stats] of Object.entries(controls)) {
        const sum = totals[key] ??= { used: 0, effective: 0, failed: 0, throws: 0, coverage: 0, storageOnly: 0 };
        for (const field of Object.keys(sum) as (keyof typeof sum)[]) sum[field] += stats[field];
      }
    }
    assert.ok(Object.values(totals).every(stats => stats.used > 0));
    for (const [key, stats] of Object.entries(totals)) {
      assert.equal(stats.coverage, 0, `${design}, ${key}`);
      assert.equal(stats.effective, stats.failed, `${design}, ${key}`);
      const missingParent = (design === "flat" && /^heading map.set [RT]$/.test(key)) ||
        (design === "run" && key === "heading map.set seg-h-R");
      if (!missingParent) assert.equal(stats.throws, 0, `${design}, ${key}`);
    }
    for (const key of ["type text.insert", "tag text.format", "format text.format", "split text.embed", "delete text.delete",
      "heading whole command", "undo undo", "redo redo"]) assert.ok(totals[key]?.failed, `${design}, missing control ${key}`);
    t.diagnostic(JSON.stringify({ design, controls: totals }));
  }
});
