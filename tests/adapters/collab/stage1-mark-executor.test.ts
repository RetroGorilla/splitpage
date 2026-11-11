import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../../collab/delivery.ts";
import { commentsOverlapOracle } from "../../collab/oracles/oracles.ts";
import { markOracles } from "../../collab/oracles/marks/oracles.ts";
import { Stage1ExecutorHarness } from "./stage1-executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { ref } from "./executor-support.ts";

for (const trace of ["T11 step 1", "T20 nest", "T21"] as const) test(`executor replays ${trace} against its copied mark literal`, () => {
  let runs = 0;
  for (const order of deliveryOrders) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: trace === "T20 nest" ? "the red mug" : "abcd" }]);
    try {
      const aRange = h.range("A", "R1", trace === "T20 nest" ? 4 : 1, trace === "T20 nest" ? 11 : 3);
      const bRange = h.range("B", "R1", trace === "T20 nest" ? 8 : 2, trace === "T20 nest" ? 11 : 4), gap = h.point("B", "R1", 2, "after");
      const writeA = () => h.execute("A", [h.mark("A", "R1", aRange, trace === "T20 nest" ? { kind: "tag", id: ref("P"), value: ref("P") } : trace === "T21" ? { kind: "b", value: true } : { kind: "comment", id: ref("C1"), value: true })]);
      const writeB = () => {
        if (trace === "T21") {
          const seen = order === "D2" || order === "late-C";
          h.execute("B", [h.insertion("B", "R1", gap, "X", seen ? [{ kind: "b", value: true }] : [])], ["b1"]);
        } else h.execute("B", [h.mark("B", "R1", bRange, trace === "T20 nest" ? { kind: "tag", id: ref("S"), value: ref("S") } : { kind: "comment", id: ref("C2"), value: true })]);
      };
      if (order === "D3") { writeB(); h.queue.deliverFrom("B", order); writeA(); }
      else { writeA(); if (order === "D2" || order === "late-C") h.queue.flush(order); if (order === "late-C") h.join(); writeB(); }
      const expected = trace === "T11 step 1" ? commentsOverlapOracle : markOracles[trace]; assert.ok(expected);
      h.check(order, expected);
      for (const handle of [h.a, h.b, h.c]) assert.equal(collabState(handle).roots.comments.size, 0);
      runs++;
    } finally { h.destroy(); }
  }
  assert.equal(runs, 6);
});

test("T20 mark retains the prototype's literal stored spans before whole-tag projection", () => {
  for (const order of deliveryOrders) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "the red mug" }]);
    try {
      const tag = h.range("A", "R1", 4, 11), comment = h.range("B", "R1", 8, 11), link = h.range("B", "R1", 4, 7);
      const writeA = () => h.execute("A", [h.mark("A", "R1", tag, { kind: "tag", id: ref("P"), value: ref("P") })]);
      const writeB = () => h.execute("B", [h.mark("B", "R1", comment, { kind: "comment", id: ref("C1"), value: true }), h.mark("B", "R1", link, { kind: "link", id: ref("http://x"), value: "http://x" })]);
      if (order === "D3") { writeB(); h.queue.deliverFrom("B", order); writeA(); }
      else { writeA(); if (order === "D2" || order === "late-C") h.queue.flush(order); if (order === "late-C") h.join(); writeB(); }
      h.check(order, { rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}],
        ["s5", "r", { tag: "P", href: "http://x" }], ["s6", "e", { tag: "P", href: "http://x" }], ["s7", "d", { tag: "P", href: "http://x" }], ["s8", " ", { tag: "P" }],
        ["s9", "m", { tag: "P", "c:C1": true }], ["s10", "u", { tag: "P", "c:C1": true }], ["s11", "g", { tag: "P", "c:C1": true }]] }], carets: {}, recovery: [] });
    } finally { h.destroy(); }
  }
});

test("T21 scalar keeps the copied concurrent-status literal with text insertion", () => {
  for (const order of ["D1", "dup", "rev"] as const) {
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }]);
    try {
      const target = { scope: "beat", record: "R1" }, gap = h.point("A", "R1", 2, "after");
      h.execute("A", [h.insertion("A", "R1", gap, "Z"), h.command("A", { kind: "status", target, parents: [], value: "ready" })], ["a1"]);
      h.execute("B", [h.command("B", { kind: "status", target, parents: [], value: "shot" })]);
      const expected = markOracles["T21 scalar"]; assert.ok(expected); h.check(order, expected, undefined, true);
    } finally { h.destroy(); }
  }
});
