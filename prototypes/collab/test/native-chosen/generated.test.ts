import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { need } from "../native-delete/model.ts";
import { MODES } from "./engine.ts";
import { GENERATED_SPEC, generateHistory } from "./generate.ts";
import { ALL_RULES } from "../../src/native/variant.ts";
import type { ChosenNames } from "../../src/native-chosen/replica.ts";
import { play } from "./play.ts";
import type { Controls, PlayResult, Step } from "./play.ts";

const SIZE = Number(process.env.E11_SEEDS ?? 600);

const category = (problem: string): string => {
  if (problem.includes("threw: ")) return `threw: ${problem.slice(problem.indexOf("threw: ") + 7).replace(/b:[^\s]+/g, "b:#")}`;
  const text = problem.replace(/^(step \d+ \w+|settled( on \d+)?|settling): /, "");
  return text.replace(/\b(letter|narration|beat|beats|copy|row|heading) \S+/g, "$1 #").replace(/\(\w+\)/g, "").replace(/\s+/g, " ").slice(0, 90);
};

export function runAll(steps: readonly Step[], number: number, names: ChosenNames = "inline"): PlayResult[] {
  return MODES.map((mode, at) => play({ spec: GENERATED_SPEC(), steps, writers: 3, mode, seed: number * 7 + at, names }));
}

function shrink(steps: Step[], number: number, kind: string, names: ChosenNames): Step[] {
  let current = steps;
  for (let changed = true; changed;) {
    changed = false;
    for (let index = current.length - 1; index >= 0; index--) {
      const candidate = current.filter((_, at) => at !== index);
      if (runAll(candidate, number, names).some(result => result.never.some(problem => category(problem) === kind))) { current = candidate; changed = true; }
    }
  }
  return current;
}

interface Survey {
  never: Record<string, { count: number; seed: number }>; local: Record<string, { count: number; sample: string }>; thrown: Record<string, number>; tags: { requested: number; causes: Record<string, number> };
  drift: { place: number; scene: number; seeds: number[] };
}

// why: `steps` replays the step lists made without the option under it, so the same histories can be compared
function survey(t: { diagnostic: (message: string) => void }, size: number, twins: boolean, names: ChosenNames = "inline", steps: ChosenNames = names): Survey {
  const kinds: Record<string, number> = {}, timing: Record<string, { sameMoment: number; offline: number }> = {}, never: Record<string, { count: number; seed: number }> = {};
  const local: Record<string, { count: number; sample: string }> = {}, thrown: Record<string, number> = {}, uses: Record<string, number> = {}, ops: Record<string, number> = {};
  let histories = 0, commands = 0, withLoss = 0, clean = 0, formatsByDelivery = 0, twinPairs = 0;
  const tags = { requested: 0, kept: 0, histories: 0, historiesWithTags: 0, causes: {} as Record<string, number>, lost: [] as unknown[] };
  const drift = { place: 0, scene: 0, seeds: [] as number[] };
  for (let number = 1; number <= size; number++) {
    const history = generateHistory(number, 40, twins, steps), results = runAll(history.steps, number, names);
    twinPairs += history.steps.filter(step => "by" in step && step.cmd.op === "split" && step.cmd.created.startsWith("T")).length / 2;
    histories++;
    for (const step of history.steps) if ("by" in step) { commands++; ops[step.cmd.op] = (ops[step.cmd.op] ?? 0) + 1; }
    for (const problem of history.thrown) { const key = problem.replace(/[A-Z]\w*\d+|\b[A-Z]\b/g, "#"); thrown[key] = (thrown[key] ?? 0) + 1; }
    const first = need(results[0], "result"), unmarked = (lines: readonly string[]): string[] => lines.map(line => line.replace(/\[([^|\]]*)\|[^\]]*\]/g, "$1"));
    for (const result of results) assert.deepEqual(unmarked(result.lines), unmarked(first.lines), `seed ${number}: deliveries agree on text and rows`);
    if (results.some(result => !isDeepStrictEqual(result.lines, first.lines))) formatsByDelivery++;
    for (const problem of new Set(results.flatMap(result => result.never).map(category))) {
      const slot = never[problem] ??= { count: 0, seed: number };
      slot.count++;
    }
    for (const problem of results.flatMap(result => result.local)) { const key = category(problem); (local[key] ??= { count: 0, sample: `seed ${number}: ${problem}` }).count++; }
    for (const [kind, n] of Object.entries(first.kinds)) kinds[kind] = (kinds[kind] ?? 0) + n;
    for (const [kind, slot] of Object.entries(first.timing)) { const total = timing[kind] ??= { sameMoment: 0, offline: 0 }; total.sameMoment += slot.sameMoment; total.offline += slot.offline; }
    for (const [rule, n] of Object.entries(first.uses)) if (n) uses[rule] = (uses[rule] ?? 0) + 1;
    tags.requested += first.tags.requested; tags.kept += first.tags.kept;
    if (first.tags.requested) tags.historiesWithTags++;
    const losing = results.findIndex(result => result.tags.lost.length > 0);
    if (losing >= 0) {
      tags.histories++;
      tags.lost.push({ seed: number, mode: MODES[losing], modes: results.filter(result => result.tags.lost.length).length, lost: results[losing]?.tags.lost });
      for (const loss of results[losing]?.tags.lost ?? []) tags.causes[loss.cause] = (tags.causes[loss.cause] ?? 0) + 1;
    }
    if (results.some(result => result.drift.place)) { drift.place++; drift.seeds.push(number); }
    if (results.some(result => result.drift.scene)) drift.scene++;
    if (Object.keys(first.kinds).some(kind => !kind.startsWith("library-decided"))) withLoss++;
    if (!results.some(result => result.never.length || result.local.length) && !Object.keys(first.kinds).length) clean++;
  }
  const smallest: Record<string, unknown> = {};
  for (const [kind, { seed }] of Object.entries(never)) {
    const smallSteps = shrink(generateHistory(seed, 40, twins, steps).steps, seed, kind, names);
    smallest[kind] = { seed, steps: smallSteps, rows: runAll(smallSteps, seed, names)[0]?.lines };
  }
  t.diagnostic(JSON.stringify({ histories, commands, twinPairs, clean, withLoss, formatsByDelivery, ops, uses, kinds, timing, thrown }));
  t.diagnostic(JSON.stringify({ never, smallest }));
  t.diagnostic(JSON.stringify({ local }));
  t.diagnostic(JSON.stringify({ tags }));
  t.diagnostic(JSON.stringify({ ranklessDrift: drift }));
  return { never, local, thrown, tags, drift };
}

// why: the never-acceptable kind part A leaves, reported in RESULT.md; pinned so any other kind fails here
const LEFT_BY_PART_A = ["narration # is shown only in a removed heading"];

test("E11 new generated histories: three copies, a late joiner, five deliveries, offline stretches", t => {
  const { never, local, thrown, tags } = survey(t, SIZE, false);
  assert.ok(tags.requested > 0, "the histories ask for production tags");
  assert.equal(tags.causes.other, undefined, "every lost tag is one of the two library behaviours named in RESULT.md");
  assert.deepEqual(Object.keys(local), [], "every command did what it promised on its copy");
  assert.deepEqual(Object.keys(thrown), [], "no writer refused a request picked from the rows");
  assert.deepEqual(Object.keys(never).sort(), LEFT_BY_PART_A);
});

test("E11 generated histories with same-moment double splits of rows the rules read", t => {
  const { never, local, thrown } = survey(t, Number(process.env.E11_TWIN_SEEDS ?? 200), true);
  assert.deepEqual(Object.keys(local), [], "every command did what it promised on its copy");
  assert.deepEqual(Object.keys(thrown), [], "no writer refused a request picked from the rows");
  assert.deepEqual(Object.keys(never).filter(kind => !LEFT_BY_PART_A.includes(kind)), []);
});

test("E11 part B: the same step lists with names in their own cells", t => {
  const { never, local } = survey(t, SIZE, false, "cells", "inline");
  // why: a list made where narration showed in a name can ask for an offset the option no longer shows; that refusal is
  // the only problem allowed, and it is counted in the diagnostic
  const refused = (key: string): boolean => /^threw: (Range|Offset) outside|step \d+ \w+: (split|typing|erasing|format)/.test(key);
  assert.deepEqual(Object.keys(never).filter(kind => !refused(kind)), []);
  assert.deepEqual(Object.keys(local).filter(kind => !refused(kind)), []);
});

for (const twins of [false, true]) test(`E11 part B: histories made with names in their own cells${twins ? ", with same-moment double splits" : ""}`, t => {
  const { never, local, thrown, tags } = survey(t, twins ? Number(process.env.E11_TWIN_SEEDS ?? 200) : SIZE, twins, "cells");
  assert.deepEqual(Object.keys(local), [], "every command did what it promised on its copy");
  assert.deepEqual(Object.keys(thrown), [], "no writer refused a request picked from the rows");
  assert.deepEqual(Object.keys(never), [], "nothing never-acceptable");
  assert.equal(tags.causes.other, undefined, "every lost tag is one of the two library behaviours named in RESULT.md");
});

const CONTROL_SEEDS = Number(process.env.E11_CONTROL_SEEDS ?? 25);

test("E11 new generated histories: silent-write controls, one per library call and per whole command", t => {
  const controls: Controls = new Map();
  for (let number = 1; number <= CONTROL_SEEDS; number++) play({ spec: GENERATED_SPEC(), steps: generateHistory(number).steps, writers: 3, mode: "forward", seed: number, controls, checkLetters: false });
  const rows = [...controls].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, count] of rows) t.diagnostic(`${key}: used ${count.used}, effective ${count.effective}, failed ${count.failed}, throws ${count.throws}, coverage ${count.coverage}, rows unchanged ${count.storageOnly}`);
  for (const [key, count] of rows) assert.deepEqual([count.coverage, count.effective - count.failed - count.throws - count.storageOnly], [0, 0], key);
  // why: only a rank rewrite may change storage and leave every row where it was; nothing else may slip through
  for (const [key, count] of rows) if (count.storageOnly) assert.equal(key, "move / YMap.set:e10Rank");
  for (const op of ["type", "erase", "format", "field", "split", "join", "unjoin", "delete", "heading", "removeHeading", "restoreHeading", "move", "undo"]) {
    assert.ok(rows.some(([key, count]) => key.startsWith(`${op} /`) && count.effective > 0), `an effective control for ${op}`);
  }
});

test("E11 new generated histories: with one reading rule off, the histories that use it fail", t => {
  const table: Record<string, { needed: number; failed: number; byReach: number; threw: number }> = {};
  for (let number = 1; number <= SIZE; number++) {
    const { steps } = generateHistory(number), normal = play({ spec: GENERATED_SPEC(), steps, writers: 3, mode: "forward", seed: number, checkLetters: false });
    for (const rule of ["prefix", "empty", "repeat", "adjacent", "rank"] as const) {
      // why: rule (e) is needed by few histories, so all of them are checked; the others are checked in the first 150
      if (!normal.uses[rule] || (rule !== "rank" && number > 150)) continue;
      const row = table[rule] ??= { needed: 0, failed: 0, byReach: 0, threw: 0 };
      row.needed++;
      const off = play({ spec: GENERATED_SPEC(), steps, writers: 3, mode: "forward", seed: number, rules: { ...ALL_RULES, [rule]: false } });
      const failed = off.never.length > 0 || off.local.length > 0;
      if (failed) row.failed++;
      if (off.never.some(problem => /shown nowhere|out of reach|shown twice|is shown/.test(problem) && !/threw/.test(problem))) row.byReach++;
      if (off.never.some(problem => /threw/.test(problem))) row.threw++;
    }
  }
  t.diagnostic(JSON.stringify(table));
  for (const rule of ["prefix", "repeat", "empty", "rank"] as const) if (table[rule]) assert.equal(table[rule].failed, table[rule].needed, rule);
});

test("E11 part B: with rule (f) off, the histories made with names in cells that use it fail", t => {
  let needed = 0, failed = 0;
  for (let number = 1; number <= SIZE; number++) {
    const { steps } = generateHistory(number, 40, false, "cells");
    const normal = play({ spec: GENERATED_SPEC(), steps, writers: 3, mode: "forward", seed: number, names: "cells", checkLetters: false });
    if (!normal.uses.headless) continue;
    needed++;
    const off = play({ spec: GENERATED_SPEC(), steps, writers: 3, mode: "forward", seed: number, names: "cells", rules: { ...ALL_RULES, headless: false } });
    if (off.never.length || off.local.length) failed++;
  }
  t.diagnostic(JSON.stringify({ needed, failed }));
  assert.ok(needed > 0);
  assert.equal(failed, needed);
});
