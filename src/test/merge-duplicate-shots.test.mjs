import "./_dom.mjs";
import "./_preferences-started.mjs";
import "./_merge-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mergeBrollShots } from "../core/merge/lists.ts";
import { mergeStates } from "../bootstrap/wiring/document-merge.ts";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { mergeGoldenInputs } from "./_merge-corpus.mjs";
import { freezeClockAndRandom } from "./golden-helpers.mjs";

freezeClockAndRandom(519);

const kettle = { id: "t_kettle", name: "Kettle" };
const ladder = { id: "t_ladder", name: "Ladder" };
const shots = [
  { id: "b1", name: "Gulls", owner: "", props: [kettle] },
  { id: "b1", name: "Gulls", owner: "p1", props: [kettle, ladder] }
];

function keepsShotContent(merged) {
  assert.equal(merged[0].owner, "p1");
  assert.deepEqual(merged[0].props, [kettle, ladder]);
}

test("unchanged duplicate shots keep their owner and props (#519)", () => {
  keepsShotContent(mergeBrollShots(structuredClone(shots), structuredClone(shots), structuredClone(shots)));
});

for (const migrated of [false, true]) {
  test("unrelated document edits keep duplicate shot content, migrated=" + migrated + " (#519)", () => {
    const { base } = structuredClone(mergeGoldenInputs().find((c) => c.name === "merge-broll-shots-each-side").inputs);
    base.brollShots = structuredClone(shots);
    const mine = structuredClone(base), theirs = structuredClone(base);
    mine.title = "Changed title";
    theirs.wordsPerMinute = 160;
    let docs = { base, mine, theirs };
    if (migrated) docs = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, migrateRows(v)]));
    keepsShotContent(mergeStates(docs.base, docs.mine, docs.theirs).merged.brollShots);
  });
}
