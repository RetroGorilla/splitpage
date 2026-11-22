import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../../collab/delivery.ts";
import { bufferOracles } from "../../collab/oracles/buffer-oracles.ts";
import { replacementIntentFixtures } from "../../collab/oracles/buffer-replacements.ts";
import { Stage1ExecutorHarness } from "./stage1-executor-support.ts";

for (const trace of ["T04", "T01", "T01 composition", "T02", "T02 boundary", "T03", "T03 replace"] as const) test(`executor replays ${trace} command intent against its copied literal`, () => {
  let runs = 0;
  for (const order of deliveryOrders) {
    const fixture = bufferOracles[trace], h = new Stage1ExecutorHarness(fixture.seed);
    try {
      const aRange = h.range("A", fixture.beat, fixture.from, fixture.to), aPoint = h.point("A", fixture.beat, fixture.from);
      const deleted = trace === "T03" ? [6, 5, 4, 3].map(index => h.range("A", "R1", index, index + 1)) : [];
      const bRow = "R1", bAt = trace === "T04" || trace === "T02" ? 0 : trace === "T03 replace" ? 7 : 2;
      const bPoint = h.point("B", bRow, bAt, "after"), bRange = trace === "T04" ? h.range("B", "R1", 3, 4) : h.range("B", "R1", 0, Math.min(3, fixture.seed[0]?.text.length ?? 0));
      let caret = { row: fixture.beat, anchor: aPoint };
      const writeA = () => {
        const text = trace === "T04" ? "xy" : trace === "T01 composition" ? "β" : trace === "T02" ? "c" : trace === "T02 boundary" ? "Z" : trace === "T03 replace" ? "a" : "";
        const names = trace === "T04" ? ["a1", "a2"] : text ? ["a1"] : [];
        const operations = text ? [h.insertion("A", fixture.beat, aPoint, text)] : [];
        if (trace === "T03") operations.push(...deleted.map(range => h.deletion("A", "R1", range)));
        else if (fixture.from !== fixture.to) operations.push(h.deletion("A", fixture.beat, aRange));
        h.execute("A", operations, names);
        const last = names.at(-1);
        if (last) {
          const index = h.characters(h.a, fixture.beat).findIndex(char => h.book.notation(char.identity) === last); assert.ok(index >= 0);
          caret = { row: fixture.beat, anchor: h.point("A", fixture.beat, index + 1) };
        }
      };
      const writeB = () => {
        if (trace === "T03") { h.execute("B", [h.mark("B", "R1", bRange, { kind: "b", value: true })]); return; }
        const text = trace === "T04" ? "Z" : trace === "T02 boundary" ? "Y" : trace === "T03 replace" ? "n" : "X";
        const fresh = h.point("B", bRow, h.offset("B", bPoint), "after"), operations = [h.insertion("B", bRow, fresh, text)];
        if (trace === "T04") operations.push(h.deletion("B", "R1", bRange));
        h.execute("B", operations, ["b1"]);
      };
      if (order === "D3") { writeB(); h.queue.deliverFrom("B", order); writeA(); }
      else { writeA(); if (order === "D2" || order === "late-C") h.queue.flush(order); if (order === "late-C") h.join(); writeB(); }
      h.check(order, fixture.expected, caret); runs++;
    } finally { h.destroy(); }
  }
  assert.equal(runs, 6);
});

for (const fixture of replacementIntentFixtures) test(`executor replacement intent: ${fixture.name}`, () => {
  let runs = 0;
  for (const order of deliveryOrders) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "the the" }]);
    try {
      const range = h.range("A", "R1", 4, 7), gap = h.point("A", "R1", 4), remote = h.point("B", "R1", fixture.remote ?? 7, "after");
      let caret = gap;
      const writeA = () => {
        h.execute("A", [h.insertion("A", "R1", gap, fixture.data), h.deletion("A", "R1", range)], fixture.names);
        const last = fixture.names.at(-1); assert.ok(last);
        const index = h.characters(h.a, "R1").findIndex(char => h.book.notation(char.identity) === last); assert.ok(index >= 0); caret = h.point("A", "R1", index + 1);
      };
      const writeB = () => { if (fixture.remote !== null) h.execute("B", [h.insertion("B", "R1", h.point("B", "R1", h.offset("B", remote), "after"), "n")], ["b1"]); };
      if (order === "D3") { writeB(); h.queue.deliverFrom("B", order); writeA(); }
      else { writeA(); if (order === "D2" || order === "late-C") h.queue.flush(order); if (order === "late-C") h.join(); writeB(); }
      h.check(order, fixture.expected, { row: "R1", anchor: caret }); runs++;
    } finally { h.destroy(); }
  }
  assert.equal(runs, 6);
});
