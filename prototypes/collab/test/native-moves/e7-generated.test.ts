import assert from "node:assert/strict";
import test from "node:test";
import { DELIVERIES } from "../native/e5-histories.ts";
import { generateHistory } from "./e7-histories.ts";
import { CONTROLS, effective, runHistory } from "./e7-run.ts";

const SEEDS = Number(process.env.E7_SEEDS ?? 200);
const histories = Array.from({ length: SEEDS }, (_, seed) => generateHistory((seed + 1) * 7919, 30));

test("E7: generated histories of moves, typing and structure commands", t => {
  const totals = { histories: 0, commands: 0, lost: 0, duplicated: 0, uneditable: 0, disagreeing: 0, notOnce: 0, unmovedOutOfOrder: 0, crashes: 0 };
  const concurrent = { typing: 0, typingFollowed: 0, typingDeleted: 0, typingInNewHeading: 0, splits: 0, splitsFollowed: 0, splitsMovedSince: 0, splitsUnderNewHeading: 0, splitsBesideOtherSplit: 0, sameBlockMoves: 0 };
  const commands: Record<string, number> = {};
  let movedHeads = 0, rows = 0, sharedSegmentRows = 0;
  for (const delivery of DELIVERIES) for (const [seed, history] of histories.entries()) {
    const result = runHistory(history, delivery, seed + 1);
    assert.equal(result.mismatch, undefined, JSON.stringify({ seed: seed + 1, delivery, mismatch: result.mismatch }));
    totals.histories++;
    totals.commands += history.events.length;
    for (const key of ["lost", "duplicated", "uneditable", "disagreeing", "notOnce", "unmovedOutOfOrder", "crashes"] as const) totals[key] += result[key];
    for (const key of Object.keys(concurrent) as (keyof typeof concurrent)[]) concurrent[key] += result.concurrent[key];
    for (const { command } of history.events) {
      const key = command.op === "move" ? `move ${command.unit}` : "field" in command ? `${command.op} ${command.field}` : command.op;
      commands[key] = (commands[key] ?? 0) + 1;
    }
    if (delivery === "forward" && result.final) {
      const stored = result.final.stored;
      for (const entry of result.final.view.outline) if (entry.kind === "row") {
        rows++;
        const head = entry.members[0] ?? entry.id;
        if (stored.places[`b:${head}`]) movedHeads++;
        const segment = Object.values(stored.segments).find(item => item.head?.kind === "b" && item.head.id === head);
        if (!segment) sharedSegmentRows++;
      }
    }
  }
  t.diagnostic(JSON.stringify({ totals, concurrent, commands, settledRows: { rows, movedHeads, sharedSegmentRows } }));
  assert.equal(totals.histories, SEEDS * DELIVERIES.length);
  assert.equal(totals.lost + totals.duplicated + totals.uneditable + totals.disagreeing + totals.notOnce + totals.unmovedOutOfOrder + totals.crashes, 0);
  assert.equal(concurrent.typingFollowed + concurrent.typingDeleted + concurrent.typingInNewHeading, concurrent.typing);
  assert.equal(concurrent.splitsFollowed + concurrent.splitsMovedSince + concurrent.splitsUnderNewHeading + concurrent.splitsBesideOtherSplit,
    concurrent.splits);
});

for (const control of CONTROLS) {
  test(`E7: generated check detects a silent ${control.op} ${control.part}`, t => {
    let used = 0, live = 0, failed = 0;
    for (const delivery of DELIVERIES) for (const [seed, history] of histories.entries()) {
      if (history.events.some(event => event.command.op === control.op)) used++;
      const index = history.events.findIndex(event => effective(event, control));
      if (index < 0) continue;
      live++;
      let commandIndex = -1;
      const at = history.steps.findIndex(step => "command" in step && ++commandIndex === index);
      const result = runHistory(history, delivery, seed + 1, { at, part: control.part });
      if (result.mismatch?.op === control.op && result.mismatch.at === at && !result.crashes) failed++;
      else assert.fail(JSON.stringify({ seed: seed + 1, delivery, control, at, mismatch: result.mismatch, crashes: result.crashes }));
    }
    t.diagnostic(`${control.op} ${control.part}: used ${used}, effective ${live}, failed ${failed}`);
    assert.ok(live > 0);
    assert.equal(failed, live);
  });
}
