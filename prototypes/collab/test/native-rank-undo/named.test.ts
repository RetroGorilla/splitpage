import assert from "node:assert/strict";
import test from "node:test";
import { MODES } from "../native-chosen/engine.ts";
import { play } from "../native-chosen/play.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { EntryOrder } from "../../src/native-rank-undo/variants.ts";
import { NAMED } from "./histories.ts";
import { snapshotKey, standings } from "./model.ts";
import { NAMES } from "./survey.ts";

// why: the one never-acceptable result the named histories may show, and only with option A
const DRIFT = /^step \d+ delete: beats B changed scene with one person working$/;

export function runNamed(option: (typeof OPTIONS)[number], order: EntryOrder = "stamp"): { label: string; rows: string[][]; keys: string[]; never: string[]; drift: number }[] {
  return NAMED.map(history => {
    const keys = standings(option, history.register).map(snapshotKey), never: string[] = [];
    let drift = 0;
    const rows = history.checkpoints.map((end, at) => {
      const results = MODES.map((mode, index) => play({ spec: history.spec, steps: history.steps.slice(0, end), writers: history.writers, mode, seed: index + 1, make: makeOption(option, order), names: NAMES }));
      for (const result of results) { never.push(...result.never, ...result.local); drift += result.drift.scene; }
      const first = results[0]?.lines ?? [];
      for (const [index, result] of results.entries()) assert.deepEqual(result.lines, first, `${history.label}, part ${at + 1}, ${option}: ${MODES[index]} agrees with forward`);
      return first;
    });
    return { label: history.label, rows, keys, never: [...new Set(never)], drift };
  });
}

for (const option of OPTIONS) test(`E15 named histories, option ${option}: the rows the model's standing write gives, on every copy and in five deliveries`, t => {
  for (const [index, outcome] of runNamed(option).entries()) {
    const history = NAMED[index];
    if (!history) throw new Error("history");
    t.diagnostic(`${outcome.label}: ${outcome.keys.join(" -> ")} | ${outcome.rows.map(rows => rows.join(", ")).join(" -> ")}`);
    assert.equal(outcome.keys.length, history.checkpoints.length, `${history.label}: one model reading per part`);
    for (const [at, key] of outcome.keys.entries()) {
      const expected = history.rows[at]?.[key];
      assert.ok(expected, `${history.label}, part ${at + 1}, ${option}: rows listed for the model's ${key}`);
      assert.deepEqual(outcome.rows[at], expected, `${history.label}, part ${at + 1}, ${option}: model says ${key}`);
    }
    const drifts = option === "A" && /^winner undoes, then the loser|six-step/.test(history.label);
    assert.deepEqual(outcome.never.filter(problem => !(drifts && DRIFT.test(problem))), [], `${history.label}, ${option}: nothing never-acceptable`);
    assert.equal(outcome.never.length > 0, drifts, `${history.label}, ${option}: B leaves scene H only with option A`);
  }
});

test("E15 named histories: option C with the other reader orders, for the record", t => {
  for (const order of ["lowest", "clock"] as const) for (const outcome of runNamed("C", order)) {
    t.diagnostic(`${order} / ${outcome.label}: ${outcome.rows.map(rows => rows.join(", ")).join(" -> ")}${outcome.never.length ? ` | ${outcome.never.join("; ")}` : ""}`);
    assert.deepEqual(outcome.never, [], `${order} / ${outcome.label}`);
  }
});
