import { spawnSync } from "node:child_process";
import { ALL_RULES, NO_RULES, NativeReplica } from "../../src/native/variant.ts";
import type { NativeReading } from "../../src/native/variant.ts";
import { DELIVERIES, generateHistory } from "../native/e5-histories.ts";
import { runHistory } from "../native/e5-run.ts";
import { closeE2, generateE2, runE2 } from "../native/structure-model.ts";

// why: E2 and E5 run unedited; this script compares their results with and without the reading rules
function statuses(file: string, rules: boolean): Map<string, { ok: boolean; error: string }> {
  const args = ["--test", "--test-reporter=tap", ...rules ? ["--import", "./test/native-chosen/rules-on.ts"] : [], file];
  const output = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split("\n");
  const result = new Map<string, { ok: boolean; error: string }>();
  output.forEach((line, index) => {
    const match = /^(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!match?.[2]) return;
    const block = output.slice(index + 1, index + 30), at = block.findIndex(item => item.includes("error:"));
    const error = at < 0 ? "" : block.slice(at, at + 8).map(item => item.trim()).filter(item => item.startsWith("error") || item.startsWith("+   ")).join(" ");
    result.set(match[2], { ok: match[1] === "ok", error });
  });
  return result;
}

const tests: Record<string, unknown> = {};
for (const file of ["test/native/e2-structure.test.ts", "test/native/e5-headings.test.ts"]) {
  const before = statuses(file, false), after = statuses(file, true), changed: Record<string, string> = {};
  for (const [name, status] of after) if (before.get(name)?.ok !== status.ok) changed[name] = status.error.slice(0, 600);
  tests[file] = { total: after.size, passedBefore: [...before.values()].filter(item => item.ok).length, passedAfter: [...after.values()].filter(item => item.ok).length, changed };
}

const kinds = (problems: readonly string[]): string[] => [...new Set(problems.map(problem =>
  /joined holds/.test(problem) ? "join flag re-pointed by the split" : /rows .* the model reads/.test(problem) ? "rows grouped differently"
    : /lost|missing|twice|duplicat|reach|strand|disagree|threw/i.test(problem) ? "data problem" : "other"))];

const e2: Record<string, Record<string, number>> = {};
NativeReplica.defaultRules = ALL_RULES;
for (const reading of ["follow", "contiguous"] as NativeReading[]) {
  const tally: Record<string, number> = { histories: 0, changed: 0 };
  for (const delivery of DELIVERIES) for (let seed = 1; seed <= 200; seed++) {
    const result = runE2(generateE2(seed * 7919, 30), { delivery, seed, reading });
    tally.histories = (tally.histories ?? 0) + 1;
    if (result.problems.length) tally.changed = (tally.changed ?? 0) + 1;
    for (const kind of kinds(result.problems)) tally[kind] = (tally[kind] ?? 0) + 1;
    closeE2(result);
  }
  e2[reading] = tally;
}

const e5: Record<string, Record<string, number>> = {};
for (const removal of ["delete", "flag"] as const) {
  const tally: Record<string, number> = { histories: 0, mismatched: 0, lost: 0, duplicated: 0, disagreeing: 0, crashes: 0, uneditableBefore: 0, uneditableAfter: 0 };
  for (const [index, delivery] of DELIVERIES.entries()) for (let seed = 1; seed <= 200; seed++) {
    const history = generateHistory(removal, seed * 7919, 30);
    NativeReplica.defaultRules = NO_RULES;
    const old = runHistory(history, removal, delivery, seed);
    NativeReplica.defaultRules = ALL_RULES;
    const result = runHistory(history, removal, delivery, seed);
    tally.histories = (tally.histories ?? 0) + 1;
    if (result.mismatch) {
      tally.mismatched = (tally.mismatched ?? 0) + 1;
      const key = `first mismatch: ${result.mismatch.field} after ${result.mismatch.op}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    for (const key of ["lost", "duplicated", "disagreeing", "crashes"] as const) tally[key] = (tally[key] ?? 0) + result[key];
    tally.uneditableBefore = (tally.uneditableBefore ?? 0) + old.uneditable;
    tally.uneditableAfter = (tally.uneditableAfter ?? 0) + result.uneditable;
    void index;
  }
  e5[removal] = tally;
}

console.log(JSON.stringify({ tests, e2, e5 }, null, 2));
