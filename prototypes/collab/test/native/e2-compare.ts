import { fileURLToPath } from "node:url";
import type { NativeReading } from "../../src/native/variant.ts";
import { closeE2, generateE2, runE2, shrinkE2, storedText } from "./structure-model.ts";
import type { E2Delivery, E2Result, E2Step } from "./structure-model.ts";

export const E2_KINDS = {
  order: "rows out of stored order under one reading only",
  hidden: "a beat shown under one reading and in recovery under the other",
  acted: "the same steps stored different text or beats, because a command acted on what its reading showed",
  row: "a beat shown under both readings but in rows with different beats",
  recovery: "a beat in recovery under both readings but in entries with different beats"
} as const;
export type E2Kind = keyof typeof E2_KINDS;
export interface E2ReadingTotals { histories: number; commands: number; misordered: number; problems: number; probes: number; observedTies: number; observedFlags: number }
export interface E2Comparison { totals: Record<NativeReading, E2ReadingTotals>; differing: number; kinds: Record<E2Kind, { histories: number; example: string[]; follow: string[]; contiguous: string[] }> }

const DELIVERIES: readonly E2Delivery[] = ["forward", "reverse", "twice", "shuffled", "state"];

// why: a history counts under the first kind it shows, in this order, so each kind's shortest example shows that
// difference and none listed before it
export function kindOf(follow: E2Result, contiguous: E2Result): E2Kind | null {
  const kinds = new Set<E2Kind>();
  if (follow.misordered !== contiguous.misordered) kinds.add("order");
  if (storedText(follow) !== storedText(contiguous)) kinds.add("acted");
  for (const [beat, one] of follow.places) {
    const other = contiguous.places.get(beat);
    if (!other) continue;
    if (one.hidden !== other.hidden) kinds.add("hidden");
    else if (JSON.stringify(one.members) !== JSON.stringify(other.members)) kinds.add(one.hidden ? "recovery" : "row");
  }
  return (Object.keys(E2_KINDS) as E2Kind[]).find(kind => kinds.has(kind)) ?? null;
}

function both(steps: readonly E2Step[], delivery: E2Delivery, seed: number): [E2Result, E2Result] {
  return [runE2(steps, { delivery, seed, probes: 0 }), runE2(steps, { delivery, seed, probes: 0, reading: "contiguous" })];
}

function show(result: E2Result): string[] {
  return [...result.rows, ...result.recovery.map(entry => `recovery: ${entry}`)];
}

// why: the same generated steps under both readings; a step that names a row by position may land on a different
// row when the readings show different rows, and that is counted as the kind "acted"
export function compareReadings(seeds: number, length: number): E2Comparison {
  const blank = (): E2ReadingTotals => ({ histories: 0, commands: 0, misordered: 0, problems: 0, probes: 0, observedTies: 0, observedFlags: 0 });
  const totals: Record<NativeReading, E2ReadingTotals> = { follow: blank(), contiguous: blank() };
  const kinds = Object.fromEntries(Object.keys(E2_KINDS).map(kind => [kind, { histories: 0, example: [] as string[], follow: [] as string[], contiguous: [] as string[], steps: null as E2Step[] | null, delivery: "forward" as E2Delivery, seed: 0 }]));
  let differing = 0;
  for (const delivery of DELIVERIES) for (let seed = 1; seed <= seeds; seed++) {
    const steps = generateE2(seed * 7919, length), results = [runE2(steps, { delivery, seed }), runE2(steps, { delivery, seed, reading: "contiguous" })] as const;
    results.forEach((result, index) => {
      const sum = totals[index ? "contiguous" : "follow"];
      sum.histories++; sum.commands += result.executed; sum.probes += result.probed;
      if (result.misordered) sum.misordered++;
      if (result.problems.length) sum.problems++;
      if (result.observedTies) sum.observedTies++;
      if (result.observedFlags) sum.observedFlags++;
    });
    const found = kindOf(results[0], results[1]), entry = found ? kinds[found] : undefined;
    if (entry) {
      differing++; entry.histories++;
      if (!entry.steps || steps.length < entry.steps.length) Object.assign(entry, { steps, delivery, seed });
    }
    results.forEach(closeE2);
  }
  for (const [kind, entry] of Object.entries(kinds)) {
    if (!entry.steps) continue;
    const short = shrinkE2(entry.steps, candidate => {
      const [follow, contiguous] = both(candidate, entry.delivery, entry.seed), hit = kindOf(follow, contiguous) === kind;
      closeE2(follow); closeE2(contiguous); return hit;
    });
    const [follow, contiguous] = both(short, entry.delivery, entry.seed);
    Object.assign(entry, { example: follow.labels.length >= contiguous.labels.length ? follow.labels : contiguous.labels, follow: show(follow), contiguous: show(contiguous), steps: null });
    closeE2(follow); closeE2(contiguous);
  }
  const shaped = Object.fromEntries(Object.entries(kinds).map(([kind, entry]) => [kind, { histories: entry.histories, example: entry.example, follow: entry.follow, contiguous: entry.contiguous }]));
  return { totals, differing, kinds: shaped as E2Comparison["kinds"] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seeds = Number(process.argv.find(value => value.startsWith("--seeds="))?.split("=")[1] ?? 200);
  console.log(JSON.stringify(compareReadings(seeds, 30), null, 2));
}
