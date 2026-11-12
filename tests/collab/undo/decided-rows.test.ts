import test from "node:test";
import assert from "node:assert/strict";
import type { OracleCharacter, ScriptOracle } from "../checker.ts";
import { deliveryOrders } from "../delivery.ts";
import { doubleDeleteOracles } from "../oracles/undo-records/oracles.ts";
import { runConcurrentStatus, runDoubleDelete, runIdenticalTag } from "./cases.ts";
import type { UndoWriter } from "./cases.ts";
import { BOLD, UndoScenario } from "./scenario.ts";

const WRITERS: readonly UndoWriter[] = ["Alice", "Bob"];

function r1(...characters: OracleCharacter[]): ScriptOracle {
  return { rows: [{ id: "R1", characters }], carets: {}, recovery: [] };
}

test("decided: undo covers only your own changes; the other writer's text and format stay, and there is nothing older to reach", () => {
  for (const order of deliveryOrders) {
    const s = new UndoScenario([{ id: "R1", text: "ab" }], order);
    s.type(s.a, "R1", 2, "x", ["a1"]);
    s.type(s.b, "R1", 0, "Q", ["b1"]);
    s.deliver();
    s.format(s.b, "R1", 1, 3, BOLD);
    s.check("both wrote", r1(["b1", "Q", {}], ["s1", "a", { b: true }], ["s2", "b", { b: true }], ["a1", "x", {}]));
    s.effective(s.a.undo.undo());
    s.check("Alice undone", r1(["b1", "Q", {}], ["s1", "a", { b: true }], ["s2", "b", { b: true }]));
    assert.deepEqual(s.a.undo.undo(), { ok: false, empty: true });
    assert.deepEqual(s.b.undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
    s.check("Alice has nothing older", r1(["b1", "Q", {}], ["s1", "a", { b: true }], ["s2", "b", { b: true }]));
    s.effective(s.b.undo.undo());
    s.check("Bob's format undone", r1(["b1", "Q", {}], ["s1", "a", {}], ["s2", "b", {}]));
    s.effective(s.a.undo.redo());
    s.check("Alice redone", r1(["b1", "Q", {}], ["s1", "a", {}], ["s2", "b", {}], ["a1*", "x", {}]));
    assert.equal(s.checks, 5);
  }
});

for (const first of WRITERS) {
  test(`decided: the same tag on the same words by two writers is one change; ${first} undoes it and the other's undo is used up`, () => {
    for (const order of deliveryOrders) assert.equal(runIdenticalTag(order, first).checks, 4);
  });
  test(`decided: the same status by two writers is one change; ${first} undoes it and the other's undo is used up`, () => {
    for (const order of deliveryOrders) assert.equal(runConcurrentStatus(order, true, first).checks, 3);
  });
  test(`decided: the same deletion by two writers is one change; ${first} undoes it and the other's undo is used up`, () => {
    for (const order of deliveryOrders) {
      const s = new UndoScenario([{ id: "R1", text: "abcd" }], order), [one, two] = first === "Alice" ? [s.a, s.b] : [s.b, s.a];
      s.erase(s.a, "R1", 1, 3);
      s.erase(s.b, "R1", 1, 3);
      s.check("deleted", doubleDeleteOracles.deleted);
      s.effective(one.undo.undo());
      s.check("restored", doubleDeleteOracles["both undone"]);
      s.usedUp(two);
      s.check("other undo used up", doubleDeleteOracles["both undone"]);
      assert.deepEqual(two.undo.redo(), { ok: false, empty: true });
      assert.equal(s.checks, 3);
    }
  });
  test(`decided: a deletion the other writer made in part; ${first} undoes first and each character comes back once`, () => {
    for (const order of deliveryOrders) assert.equal(runDoubleDelete(order, first, false).checks, 2);
  });
}

test("decided: cut and paste are two commands, also into the same beat in the same millisecond", () => {
  for (const order of deliveryOrders) {
    const s = new UndoScenario([{ id: "R1", text: "abcd" }], order);
    s.a.typing = true;
    s.a.edit({ at: s.a.observe("R1", 1, 3), command: "cut" });
    s.world.name(s.a.edit({ at: s.a.observe("R1", 2, 2), text: "bc", command: "paste" }), ["a1", "a2"]);
    assert.deepEqual(s.a.undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
    s.check("cut and pasted", r1(["s1", "a", {}], ["s4", "d", {}], ["a1", "b", {}], ["a2", "c", {}]));
    const undone = s.a.undo.undo();
    assert.deepEqual(undone.ok && [undone.effective, undone.label], [true, "paste"]);
    s.check("paste undone", r1(["s1", "a", {}], ["s4", "d", {}]));
    s.effective(s.a.undo.undo());
    s.check("cut undone", r1(["s1", "a", {}], ["s2*", "b", {}], ["s3*", "c", {}], ["s4", "d", {}]));
    s.effective(s.a.undo.redo());
    s.effective(s.a.undo.redo());
    s.check("both redone", r1(["s1", "a", {}], ["s4", "d", {}], ["a1*", "b", {}], ["a2*", "c", {}]));
    assert.equal(s.checks, 4);
  }
});

test("different: deleting an earlier letter and typing it again keeps an entry; its undo brings the first letter back, so the older entry still reaches it", () => {
  for (const order of deliveryOrders) {
    const s = new UndoScenario([{ id: "R1", text: "ab" }], order);
    s.format(s.a, "R1", 0, 1, BOLD);
    s.erase(s.a, "R1", 0, 1);
    s.a.typing = true;
    s.type(s.a, "R1", 0, "a", ["a1"]);
    s.a.typing = false;
    assert.deepEqual(s.a.undo.sizes(), { undo: 2, redo: 0, dropped: 0 });
    s.check("retyped", r1(["a1", "a", {}], ["s2", "b", {}]));
    s.effective(s.a.undo.undo());
    s.check("group undone", r1(["s1*", "a", { b: true }], ["s2", "b", {}]));
    s.effective(s.a.undo.undo());
    s.check("format undone", r1(["s1*", "a", {}], ["s2", "b", {}]));
    assert.equal(s.checks, 3);
  }
});

test("a remote change records nothing: the receiver's stacks, also its redo, are as they were, and its records still resolve", () => {
  for (const order of deliveryOrders) {
    const s = new UndoScenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], order);
    s.type(s.a, "R1", 2, "x", ["a1"]);
    s.type(s.a, "R2", 2, "y", ["a2"]);
    s.effective(s.a.undo.undo());
    s.deliver();
    const before = [s.a.undo.sizes(), s.a.undo.serial(), s.a.undo.lifetime()];
    assert.deepEqual(before, [{ undo: 1, redo: 1, dropped: 0 }, 3, 0]);
    s.erase(s.b, "R1", 2, 3);
    s.type(s.b, "R2", 0, "Q", ["b1"]);
    s.format(s.b, "R2", 0, 3, BOLD);
    s.b.status("R1", "ready");
    s.deliver();
    assert.deepEqual([s.a.undo.sizes(), s.a.undo.serial(), s.a.undo.lifetime()], before);
    s.effective(s.a.undo.redo());
    s.check("redo kept through remote changes", { rows: [
      { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "ready" },
      { id: "R2", characters: [["b1", "Q", { b: true }], ["s3", "c", { b: true }], ["s4", "d", { b: true }], ["a2*", "y", {}]], status: "todo" }
    ], carets: {}, recovery: [] }, { status: true });
    s.effective(s.a.undo.undo());
    s.usedUp(s.a);
    assert.deepEqual(s.a.undo.sizes(), { undo: 0, redo: 1, dropped: 0 });
    assert.equal(s.checks, 1);
  }
});
