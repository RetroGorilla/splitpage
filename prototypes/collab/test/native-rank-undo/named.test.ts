import assert from "node:assert/strict";
import test from "node:test";
import { MODES } from "../native-chosen/engine.ts";
import { play } from "../native-chosen/play.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { EntryOrder, RankOption } from "../../src/native-rank-undo/variants.ts";
import { NAMED } from "./histories.ts";
import { EXPECTED, snapshotKey, standings, storageOf } from "./model.ts";
import { NAMES } from "./survey.ts";

export interface NamedOutcome { label: string; rows: string[][]; keys: string[]; never: string[][]; thrown: string[]; press: string[] }

export function runNamed(option: RankOption, order: EntryOrder = "stamp"): NamedOutcome[] {
  return NAMED.map(history => {
    const keys = standings(storageOf(option, history.target), history.register).map(snapshotKey), thrown: string[] = [];
    const never: string[][] = [], press = new Set<string>();
    const rows = history.checkpoints.map((end, at) => {
      const results = MODES.flatMap((mode, index) => {
        try {
          const result = play({ spec: history.spec, steps: history.steps.slice(0, end), writers: history.writers, mode, seed: index + 1, make: makeOption(option, order), names: NAMES, pressChecks: true });
          for (const problem of result.press?.problems ?? []) press.add(problem);
          return [result];
        } catch (error) { thrown.push(`part ${at + 1} ${mode}: ${(error as Error).message}`); return []; }
      });
      never.push([...new Set(results.flatMap(result => [...result.never, ...result.local].flatMap(problem => problem.split("; ")).map(problem => problem.replace(/^(step \d+ \w+|settled(?: on \d+)?): /, ""))))]);
      const first = results[0]?.lines ?? [];
      for (const [index, result] of results.entries()) assert.deepEqual(result.lines, first, `${history.label}, part ${at + 1}, ${option}: delivery ${index} agrees with forward`);
      return first;
    });
    return { label: history.label, rows, keys, never, thrown, press: [...press] };
  });
}

for (const option of OPTIONS) test(`E15 named histories, option ${option}: the rows the model's standing write gives, on every copy and in five deliveries`, t => {
  for (const [index, outcome] of runNamed(option).entries()) {
    const history = NAMED[index], expected = EXPECTED[outcome.label];
    if (!history || !expected) throw new Error(`no expectation for ${outcome.label}`);
    t.diagnostic(`${outcome.label}: ${outcome.keys.join(" -> ")} | ${outcome.rows.map(rows => rows.join(", ")).join(" -> ")}${outcome.press.length ? ` | press: ${outcome.press.join("; ")}` : ""}`);
    assert.deepEqual(outcome.thrown, [], `${history.label}, ${option}: no command throws`);
    assert.equal(outcome.keys.length, history.checkpoints.length, `${history.label}: one model reading per part`);
    for (const [at, key] of outcome.keys.entries()) {
      const rows: string[] | undefined = expected.rows[at]?.[key];
      assert.ok(rows, `${history.label}, part ${at + 1}, ${option}: rows listed for the model's ${key}`);
      assert.deepEqual(outcome.rows[at], rows, `${history.label}, part ${at + 1}, ${option}: model says ${key}`);
    }
    const later = outcome.press.filter(problem => / which step \d+ by another person moved later and the presser had seen$/.test(problem));
    assert.deepEqual(outcome.press.filter(problem => !later.includes(problem)), [], `${history.label}, ${option}: no press moves rows it did not place`);
    assert.equal(later.length > 0, expected.seenLater?.includes(option) ?? false, `${history.label}, ${option}: a press moves a later placement the presser had seen`);
    const listed = expected.never?.[option] ?? [];
    for (const [at, problems] of outcome.never.entries()) {
      const allowed = listed.filter(entry => entry.at <= at).map(entry => entry.problem);
      assert.deepEqual(problems.filter(problem => !allowed.includes(problem)), [], `${history.label}, part ${at + 1}, ${option}: nothing never-acceptable beyond the listed`);
      for (const entry of listed) if (entry.at === at) assert.ok(problems.includes(entry.problem), `${history.label}, part ${at + 1}, ${option}: shows ${entry.problem}`);
    }
  }
});

test("E15 named histories: option C with the other reader orders, for the record", t => {
  for (const order of ["lowest", "clock"] as const) for (const outcome of runNamed("C", order)) {
    const listed = new Set((EXPECTED[outcome.label]?.never?.C ?? []).map(entry => entry.problem));
    const found = [...new Set(outcome.never.flat())];
    t.diagnostic(`${order} / ${outcome.label}: ${outcome.rows.map(rows => rows.join(", ")).join(" -> ")}${found.length ? ` | ${found.join("; ")}` : ""}`);
    assert.deepEqual(outcome.thrown, [], `${order} / ${outcome.label}: no command throws`);
    assert.deepEqual(found.filter(problem => !listed.has(problem)), [], `${order} / ${outcome.label}`);
  }
});
