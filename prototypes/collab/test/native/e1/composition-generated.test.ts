import assert from "node:assert/strict";
import test from "node:test";
import { runHistory } from "../../../src/native-e1/history.ts";
import type { CommitStrategy, ComposedHistory } from "../../../src/native-e1/history.ts";

const RUNS = Number(process.env.E1_RUNS ?? 3000);
const KINDS = [
  "commits", "cancels", "composer undo", "composer redo", "composition steps", "commits after remote changes were folded",
  "commits where a remote copy had already deleted text the person deleted", "commits with a deleted character still on screen",
  "remote insertions", "remote letters", "remote surrogate pairs", "remote atoms", "remote splits", "remote deletions",
  "remote deletions of atoms or boundaries", "remote formatting", "remote undo", "deliveries", "repeated deliveries",
  "out-of-order deliveries", "deliveries to the composer while composing"
];

function sweep(from: number, undo: boolean): { failures: string[]; tally: Record<string, number>; deletedNeighbour: number[] } {
  const failures: string[] = [], tally: Record<string, number> = {}, deletedNeighbour: number[] = [];
  for (let seed = from; seed < from + RUNS; seed++) {
    const history = runHistory({ seed, undo });
    for (const [name, amount] of Object.entries(history.tally)) tally[name] = (tally[name] ?? 0) + amount;
    if (history.hard.length > 0 || history.liveOrder.length > 0) failures.push(`seed ${seed}: ${[...history.hard, ...history.liveOrder.map(item => item.message)].join("; ")}\n${history.commands.join("\n")}`);
    if (history.order.length > 0) deletedNeighbour.push(seed);
  }
  return { failures, tally, deletedNeighbour };
}

for (const [name, from, undo] of [["with undo and redo", 1, true], ["without undo", 100_001, false]] as const) {
  test(`generated, ${RUNS} histories ${name}: nothing lost or extra, copies and a late joiner agree, live order holds`, t => {
    const { failures, tally, deletedNeighbour } = sweep(from, undo);
    t.diagnostic(`tally ${JSON.stringify(tally)}`);
    t.diagnostic(`order broken only next to a character already deleted at the composer: ${deletedNeighbour.length} histories, first seeds ${deletedNeighbour.slice(0, 5).join(", ")}`);
    assert.deepEqual(failures.slice(0, 3), []);
    for (const kind of KINDS.filter(kind => undo || !["composer undo", "composer redo", "remote undo"].includes(kind))) assert.ok((tally[kind] ?? 0) > 0, `the generator never produced: ${kind}`);
  });
}

for (const strategy of ["relative", "offsets"] as const satisfies readonly CommitStrategy[]) {
  test(`negative control: the rejected commit by ${strategy === "relative" ? "one relative position per painted unit" : "painted offsets"} is caught`, t => {
    const caught: ComposedHistory[] = [];
    for (let seed = 1; seed <= 500; seed++) {
      const history = runHistory({ seed, strategy });
      if (history.hard.length > 0) caught.push(history);
    }
    const first = caught[0];
    t.diagnostic(`caught in ${caught.length} of 500; first seed ${first?.seed}: ${first?.hard.slice(0, 2).join("; ")}`);
    assert.ok(caught.length > 0);
    assert.ok(caught.some(history => history.hard.some(finding => / missing$/.test(finding))));
  });
}

test("negative control: one character dropped, duplicated or misplaced in a passing history is reported", () => {
  const applied = { drop: 0, typed: 0, duplicate: 0, misplace: 0 }, caught = { drop: 0, typed: 0, duplicate: 0, misplace: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const history = runHistory({ seed });
    assert.deepEqual(history.hard, []);
    const final = history.final, check = history.ledger.check.bind(history.ledger);
    if (final.length === 0) continue;
    applied.drop++;
    if (check(final.slice(1)).identity.length > 0) caught.drop++;
    applied.duplicate++;
    if (check([...final, final[0] as (typeof final)[number]]).identity.length > 0) caught.duplicate++;
    const typed = final.findIndex(seen => history.ledger.keyOf(seen.id)?.startsWith("local:"));
    if (typed >= 0) {
      applied.typed++;
      if (check(final.filter((_, index) => index !== typed)).identity.length > 0) caught.typed++;
    }
    const based = final.flatMap((seen, index) => seen.id.startsWith("100:") ? [index] : []);
    if (based.length >= 2) {
      const [first, second] = based as [number, number], swapped = [...final];
      [swapped[first], swapped[second]] = [final[second] as (typeof final)[number], final[first] as (typeof final)[number]];
      applied.misplace++;
      if (check(swapped).liveOrder.length > 0) caught.misplace++;
    }
  }
  assert.deepEqual(caught, applied);
  assert.ok(Object.values(applied).every(amount => amount >= 50), JSON.stringify(applied));
});
