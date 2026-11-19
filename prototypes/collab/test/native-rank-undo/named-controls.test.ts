import assert from "node:assert/strict";
import test from "node:test";
import { play } from "../native-chosen/play.ts";
import type { PlayResult } from "../native-chosen/play.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { NAMED } from "./histories.ts";
import type { Named } from "./histories.ts";
import { EXPECTED, snapshotKey, standings, storageOf } from "./model.ts";
import { SILENT, e15Checks } from "./storage.ts";
import { NAMES } from "./survey.ts";

interface Tally { used: number; effective: number; rows: number; checks: number; throws: number; silent: string[] }

const problems = (result: PlayResult): string[] => [...result.never, ...result.local].map(problem => problem.replace(/^step \d+ /, ""));

// why: every library write of every command in a named history is muted once; the settled rows are compared with the
// intended rows model.ts lists, and the checks look for partly written state (a boundary without a record, and so on)
function mute(option: RankOption, history: Named): Tally {
  const make = makeOption(option), storage = e15Checks(option), tally: Tally = { used: 0, effective: 0, rows: 0, checks: 0, throws: 0, silent: [] };
  const run = (muted?: { step: number; call: number }): PlayResult => play({
    spec: history.spec, steps: history.steps, writers: history.writers, mode: "forward", seed: 1, make, names: NAMES, storage, listCalls: true, ...muted ? { mute: muted } : {}
  });
  const base = run(), key = standings(storageOf(option, history.target), history.register).map(snapshotKey).at(-1) ?? "";
  const intended = EXPECTED[history.label]?.rows.at(-1)?.[key];
  assert.deepEqual(base.lines.map(line => line.replace(/\[([^|\]]*)\|[^\]]*\]/g, "$1")), intended, `${history.label}, ${option}: the unmuted history shows the intended rows`);
  const known = new Set(problems(base));
  for (const [step, calls] of Object.entries(base.calls ?? {})) for (const [call, name] of calls.entries()) {
    tally.used++;
    const result = run({ step: Number(step), call });
    if (result.stored === base.stored) continue;
    tally.effective++;
    const fresh = problems(result).filter(problem => !known.has(problem));
    const cmd = history.steps[Number(step)], op = cmd && "cmd" in cmd ? cmd.cmd.op : "?";
    if (fresh.some(problem => problem.includes("threw"))) tally.throws++;
    else if (fresh.length) tally.checks++;
    else if (result.lines.join("|") !== base.lines.join("|")) tally.rows++;
    else tally.silent.push(`${op} / ${name}`);
  }
  return tally;
}

for (const option of OPTIONS) test(`E15 named-history controls, option ${option}: each write muted once, judged by the intended rows and the checks`, t => {
  const total: Tally = { used: 0, effective: 0, rows: 0, checks: 0, throws: 0, silent: [] };
  for (const history of NAMED) {
    const tally = mute(option, history);
    t.diagnostic(`${history.label}: ${JSON.stringify(tally)}`);
    for (const key of ["used", "effective", "rows", "checks", "throws"] as const) total[key] += tally[key];
    total.silent.push(...tally.silent);
  }
  t.diagnostic(`total: ${JSON.stringify({ ...total, silent: total.silent.length })}`);
  assert.ok(total.rows + total.checks > 0);
  // why: a muted whole press leaves the intended rows when another person's command makes the same rows (both undo
  // the same deletion) or later replaces what the press wrote; the stored state differs, the rows cannot show it
  for (const key of total.silent) assert.ok(SILENT[option].test(key) || /^(undo|redo) \/ UndoManager\.(undo|redo)$/.test(key), key);
});
