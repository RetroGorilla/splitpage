import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual as equal } from "node:util";
import { ROW_MAKERS } from "../../src/native-row-record/variants.ts";
import type { RowControl, RowOption } from "../../src/native-row-record/variants.ts";
import { MODES } from "../native-chosen/engine.ts";
import { justTwo } from "../native-rank-undo/histories.ts";
import { drive } from "./drive.ts";
import { BASES, ROW_HISTORIES } from "./histories.ts";
import { runModel } from "./model.ts";
import type { ModelOption } from "./model.ts";

interface Count {
  runs: number; mismatched: number; settledMissing: number; histories: Set<string>; copySteps: number; stepMissing: number; never: number; threw: number; disagree: number;
  rankless: number; shownN: number;
}

// why: every history in every delivery, read on every copy after every step and compared with the model's reading
function count(option: RowOption | RowControl, expected: ModelOption): Count {
  const total: Count = { runs: 0, mismatched: 0, settledMissing: 0, histories: new Set(), copySteps: 0, stepMissing: 0, never: 0, threw: 0, disagree: 0, rankless: 0, shownN: 0 };
  for (const [index, history] of ROW_HISTORIES.entries()) {
    const model = runModel(expected, history.model, 2);
    for (const [at, mode] of MODES.entries()) {
      const real = drive(ROW_MAKERS[option], justTwo(), history.steps, 2, mode, index * 5 + at);
      total.runs++;
      if (!real.views.every((views, step) => equal(views, model.views[step])) || !real.settled.every(view => equal(view, model.settled))) total.mismatched++;
      if (real.settled.some(view => view.missing.length)) { total.settledMissing++; total.histories.add(history.label); }
      const settled = real.settled[0], shown = !!settled?.rows.some(row => row.startsWith("N:"));
      total.shownN += Number(shown);
      total.rankless += Number(shown && !settled?.rank);
      for (const views of real.views) for (const view of views) { total.copySteps++; if (view.missing.length) total.stepMissing++; }
      if (real.never.some(problem => !/has no (record|visual cell)$/.test(problem))) total.never++;
      if (real.threw.length) total.threw++;
      if (real.disagree) total.disagree++;
    }
  }
  return total;
}

const summary = (total: Count) => ({ ...total, histories: [...total.histories] });

test("E17 the model's own reading of the four steps, written from the commands", () => {
  const steps = ROW_HISTORIES[0]?.model ?? [];
  assert.deepEqual(runModel("K", steps, 2).settled, { rows: ["A: a / ", "B:  / ", "N: b / "], boundaries: 1, record: false, cell: false, rank: false, missing: ["N"] });
  assert.deepEqual(runModel("R", steps, 2).settled, { rows: ["A: a / ", "B: b / "], boundaries: 1, record: false, cell: false, rank: false, missing: [] });
  assert.deepEqual(runModel("U", steps, 2).settled, { rows: ["A: a / ", "B:  / ", "N: b / "], boundaries: 1, record: true, cell: true, rank: false, missing: [] });
});

test("E17 K, R and U against the model: 18 histories, five deliveries, every copy after every step", t => {
  const results = Object.fromEntries((["K", "R", "U"] as const).map(option => [option, count(option, option)]));
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(results).map(([option, total]) => [option, summary(total)]))));
  for (const total of Object.values(results)) {
    assert.equal(total.runs, 90);
    assert.deepEqual([total.mismatched, total.never, total.threw, total.disagree], [0, 0, 0, 0]);
    assert.equal(total.copySteps, 3000);
  }
  assert.deepEqual([results.K?.settledMissing, results.K?.stepMissing], [30, 480]);
  assert.deepEqual([results.K?.shownN, results.K?.rankless, results.R?.shownN, results.R?.rankless, results.U?.shownN, results.U?.rankless], [60, 30, 30, 0, 60, 30]);
  assert.deepEqual(results.K?.histories, new Set(BASES.map(base => base.label)));
  for (const option of ["R", "U"]) assert.deepEqual([results[option]?.settledMissing, results[option]?.stepMissing], [0, 0]);
});

test("E17 controls on the set total: no-op fixes bring the failure back, a wrong reading or a wrong expectation is caught", t => {
  const noopR = count("R0", "K"), noopU = count("U0", "K"), drop = count("Rdrop", "R");
  const wrong = { RasK: count("R", "K"), UasK: count("U", "K"), KasU: count("K", "U") };
  t.diagnostic(JSON.stringify({ noopR: summary(noopR), noopU: summary(noopU), drop: summary(drop), wrong: Object.fromEntries(Object.entries(wrong).map(([key, total]) => [key, summary(total)])) }));
  for (const noop of [noopR, noopU]) assert.deepEqual([noop.mismatched, noop.settledMissing, noop.stepMissing], [0, 30, 480]);
  assert.deepEqual([drop.mismatched, drop.never], [75, 75]);
  for (const total of Object.values(wrong)) assert.equal(total.mismatched, 90);
});
