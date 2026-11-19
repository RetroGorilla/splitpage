import assert from "node:assert/strict";
import test from "node:test";
import { play } from "../native-chosen/play.ts";
import type { PlayResult } from "../native-chosen/play.ts";
import { OPTIONS, makeOption } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { NAMED, keysOf, plainMarkers, rowsFor } from "./histories.ts";
import type { Named } from "./histories.ts";
import { EXPECTED } from "./model.ts";
import { SILENT, e15Checks } from "./storage.ts";
import { NAMES } from "./survey.ts";

interface Tally { used: number; effective: number; atCommand: number; later: number; throws: number; rows: number; silent: string[] }

const THREW = "threw: ";
const problems = (result: PlayResult): string[] => [...result.never, ...result.local, ...(result.threw ?? []).map(problem => `${THREW}${problem}`)];
const stepOf = (problem: string): number | null => { const found = /^(?:threw: )?step (\d+) /.exec(problem); return found ? Number(found[1]) : null; };
const plainOf = (problem: string): string[] => problem.replace(/^(?:threw: )?(step \d+ \w+|settled(?: on \d+)?): /, "").split("; ");

// why: every library write of every command in a named history is muted once; the settled rows are compared with the
// intended rows model.ts lists, and the checks look for partly written state (a boundary without a record, and so on)
function mute(option: RankOption, history: Named): Tally {
  const make = plainMarkers(makeOption(option), history.plain), storage = e15Checks(option), expected = EXPECTED[history.label];
  const tally: Tally = { used: 0, effective: 0, atCommand: 0, later: 0, throws: 0, rows: 0, silent: [] };
  const run = (muted?: { step: number; call: number }): PlayResult => play({
    spec: history.spec, steps: history.steps, writers: history.writers, mode: "forward", seed: 1, make, names: NAMES, storage, listCalls: true,
    continueOnThrow: true, ...muted ? { mute: muted } : {}
  });
  const base = run(), last = history.checkpoints.length - 1;
  if (!expected) throw new Error(`no expectation for ${history.label}`);
  const intended = rowsFor(expected, last, keysOf(option, history).at(-1) ?? "");
  assert.deepEqual(base.lines.map(line => line.replace(/\[([^|\]]*)\|[^\]]*\]/g, "$1")), intended, `${history.label}, ${option}: the unmuted history shows the intended rows`);
  const listed = new Set([...expected.never?.[option] ?? [], ...expected.local?.[option] ?? []].map(entry => entry.problem));
  const listedThrows = new Set((expected.threw?.[option] ?? []).map(entry => entry.problem));
  for (const problem of problems(base)) {
    const ok = problem.startsWith(THREW) ? listedThrows.has(problem.slice(THREW.length).replace(/^step \d+ /, "")) : plainOf(problem).every(part => listed.has(part));
    assert.ok(ok, `${history.label}, ${option}: the unmuted history shows only what model.ts lists, not ${problem}`);
  }
  const known = new Set(problems(base));
  for (const [step, calls] of Object.entries(base.calls ?? {})) for (const [call, name] of calls.entries()) {
    tally.used++;
    const result = run({ step: Number(step), call });
    if (result.stored === base.stored) continue;
    tally.effective++;
    const fresh = problems(result).filter(problem => !known.has(problem)), throws = (problem: string): boolean => problem.startsWith(THREW) || problem.includes(" threw");
    const cmd = history.steps[Number(step)], op = cmd && "cmd" in cmd ? cmd.cmd.op : "?";
    if (fresh.some(problem => !throws(problem) && stepOf(problem) === Number(step))) tally.atCommand++;
    else if (fresh.some(throws)) tally.throws++;
    else if (fresh.length) tally.later++;
    else if (result.lines.join("|") !== base.lines.join("|")) tally.rows++;
    else tally.silent.push(`${op} / ${name}`);
  }
  return tally;
}

for (const option of OPTIONS) test(`E15 named-history controls, option ${option}: each write muted once, judged by the intended rows and the checks`, t => {
  const total: Tally = { used: 0, effective: 0, atCommand: 0, later: 0, throws: 0, rows: 0, silent: [] };
  for (const history of NAMED) {
    const tally = mute(option, history);
    t.diagnostic(`${history.label}: ${JSON.stringify(tally)}`);
    for (const key of ["used", "effective", "atCommand", "later", "throws", "rows"] as const) total[key] += tally[key];
    total.silent.push(...tally.silent);
  }
  t.diagnostic(`total: ${JSON.stringify({ ...total, silent: total.silent.length })}`);
  assert.ok(total.rows + total.atCommand + total.later > 0);
  // why: a muted whole press leaves the intended rows when another person's command makes the same rows (both undo
  // the same deletion) or later replaces what the press wrote; the stored state differs, the rows cannot show it
  for (const key of total.silent) assert.ok(SILENT[option].test(key) || /^(undo|redo) \/ UndoManager\.(undo|redo)$/.test(key), key);
});
