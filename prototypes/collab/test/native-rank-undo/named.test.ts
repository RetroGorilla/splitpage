import assert from "node:assert/strict";
import test from "node:test";
import { MODES } from "../native-chosen/engine.ts";
import { play } from "../native-chosen/play.ts";
import type { PressRecord } from "../native-chosen/play.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { EntryOrder, RankOption } from "../../src/native-rank-undo/variants.ts";
import { NAMED, keysOf, plainMarkers, rowsFor } from "./histories.ts";
import { EXPECTED } from "./model.ts";
import { NAMES } from "./survey.ts";

export interface NamedOutcome {
  label: string; rows: string[][]; keys: string[]; never: string[][]; local: string[][]; threw: string[][]; thrown: string[]; press: string[];
  lastPress: (PressRecord | undefined)[];
}

const plainProblems = (list: readonly string[]): string[] =>
  [...new Set(list.flatMap(problem => problem.split("; ")).map(problem => problem.replace(/^(step \d+ \w+|settled(?: on \d+)?): /, "")))];
const withOp = (list: readonly string[]): string[] => [...new Set(list.map(problem => problem.replace(/^step \d+ /, "")))];

export function runNamed(option: RankOption, order: EntryOrder = "stamp"): NamedOutcome[] {
  return NAMED.map(history => {
    const keys = keysOf(option, history), thrown: string[] = [], make = plainMarkers(makeOption(option, order), history.plain);
    const never: string[][] = [], local: string[][] = [], threw: string[][] = [], press = new Set<string>();
    let lastPress: (PressRecord | undefined)[] = [];
    const rows = history.checkpoints.map((end, at) => {
      const results = MODES.flatMap((mode, index) => {
        try {
          const result = play({
            spec: history.spec, steps: history.steps.slice(0, end), writers: history.writers, mode, seed: index + 1, make, names: NAMES,
            pressChecks: true, continueOnThrow: true, logPresses: true
          });
          for (const problem of result.press?.problems ?? []) press.add(problem);
          return [result];
        } catch (error) { thrown.push(`part ${at + 1} ${mode}: ${(error as Error).message}`); return []; }
      });
      never.push(plainProblems(results.flatMap(result => result.never)));
      local.push(plainProblems(results.flatMap(result => result.local)));
      threw.push(withOp(results.flatMap(result => result.threw ?? [])));
      lastPress = results.map(result => result.presses?.at(-1));
      const first = results[0]?.lines ?? [];
      for (const [index, result] of results.entries()) assert.deepEqual(result.lines, first, `${history.label}, part ${at + 1}, ${option}: delivery ${index} agrees with forward`);
      return first;
    });
    return { label: history.label, rows, keys, never, local, threw, thrown, press: [...press], lastPress };
  });
}

function listedOnly(found: readonly string[][], listed: readonly { at: number; problem: string }[], what: string, label: string): void {
  for (const [at, problems] of found.entries()) {
    const allowed = listed.filter(entry => entry.at <= at).map(entry => entry.problem);
    assert.deepEqual(problems.filter(problem => !allowed.includes(problem)), [], `${label}, part ${at + 1}: no ${what} beyond the listed`);
    for (const entry of listed) if (entry.at === at) assert.ok(problems.includes(entry.problem), `${label}, part ${at + 1}: shows ${entry.problem}`);
  }
}

for (const option of OPTIONS) test(`E15 named histories, option ${option}: the rows the model's standing write gives, on every copy and in five deliveries`, t => {
  for (const [index, outcome] of runNamed(option).entries()) {
    const history = NAMED[index], expected = EXPECTED[outcome.label];
    if (!history || !expected) throw new Error(`no expectation for ${outcome.label}`);
    const label = `${history.label}, ${option}`;
    t.diagnostic(`${outcome.label}: ${outcome.keys.join(" -> ")} | ${outcome.rows.map(rows => rows.join(", ")).join(" -> ")}${outcome.press.length ? ` | press: ${outcome.press.join("; ")}` : ""}`);
    assert.deepEqual(outcome.thrown, [], `${label}: the play itself never throws`);
    assert.equal(outcome.keys.length, history.checkpoints.length, `${history.label}: one model reading per part`);
    for (const [at, key] of outcome.keys.entries()) {
      const rows = rowsFor(expected, at, key);
      assert.ok(rows, `${label}, part ${at + 1}: rows listed for ${key}`);
      assert.deepEqual(outcome.rows[at], rows, `${label}, part ${at + 1}: expected rows for ${key}`);
    }
    const later = outcome.press.filter(problem => / which step \d+ by another person moved later and the presser had seen$/.test(problem));
    const moved = outcome.press.filter(problem => !later.includes(problem));
    assert.equal(moved.length > 0, expected.moved?.includes(option) ?? false, `${label}: a press moves rows it did not place`);
    assert.equal(later.length > 0, expected.seenLater?.includes(option) ?? false, `${label}: a press moves a later placement the presser had seen`);
    listedOnly(outcome.never, expected.never?.[option] ?? [], "never-acceptable result", label);
    listedOnly(outcome.local, expected.local?.[option] ?? [], "broken command promise", label);
    listedOnly(outcome.threw, expected.threw?.[option] ?? [], "command that throws", label);
    if (!expected.blockedRedo) continue;
    assert.equal(outcome.lastPress.length, MODES.length, `${label}: the last press, in every delivery`);
    for (const [mode, press] of outcome.lastPress.entries()) {
      const where = `${label}, ${MODES[mode]}: the last press`;
      assert.equal(press?.op, "redo", where);
      if (expected.blockedRedo.includes(option)) {
        assert.equal(press.returned, false, `${where} returns false`);
        assert.deepEqual([press.redo[1], press.undo[1]], [press.redo[0] - 1, press.undo[0]], `${where} uses up its redo item and adds no undo item`);
        assert.equal(press.same, true, `${where} leaves the document snapshot unchanged`);
      } else {
        assert.equal(press.returned, true, `${where} returns true`);
        assert.equal(press.same, false, `${where} changes the document`);
      }
    }
  }
});

test("E15 named histories: option C with the other reader orders, for the record", t => {
  for (const order of ["lowest", "clock"] as const) for (const outcome of runNamed("C", order)) {
    const expected = EXPECTED[outcome.label];
    t.diagnostic(`${order} / ${outcome.label}: ${outcome.rows.map(rows => rows.join(", ")).join(" -> ")}`);
    assert.deepEqual(outcome.thrown, [], `${order} / ${outcome.label}: the play itself never throws`);
    for (const [found, listed] of [[outcome.never, expected?.never?.C], [outcome.local, expected?.local?.C], [outcome.threw, expected?.threw?.C]] as const) {
      const allowed = new Set((listed ?? []).map(entry => entry.problem));
      assert.deepEqual([...new Set(found.flat())].filter(problem => !allowed.has(problem)), [], `${order} / ${outcome.label}`);
    }
  }
});
