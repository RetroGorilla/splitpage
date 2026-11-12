import assert from "node:assert/strict";
import type { ScriptOracle } from "../checker.ts";
import type { DeliveryOrder } from "../delivery.ts";
import { markOracles } from "../oracles/marks/oracles.ts";
import { deletionOracle } from "../oracles/oracles.ts";
import {
  chainOracles, doubleDeleteOracles, endpointOracles, heldSelectionOracle, identicalTagOracles, insideRangeOracles, laterFormatOracles, longChainOracle,
  positionControlOracle, redoneAtGapOracle, redoOracles, statusOracles, statusRedoObserved, throwingUndoOracles
} from "../oracles/undo-records/oracles.ts";
import { BOLD, MODEL_WORLD, TAG_P, UNBOLD, UndoScenario } from "./scenario.ts";
import type { UndoReplica, UndoWorldKind } from "./scenario.ts";

export type UndoWriter = "Alice" | "Bob";

const AB = [{ id: "R1", text: "ab" }];
const NOTICES = ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply"];

function status(value: string, noticed = false): ScriptOracle {
  return { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: value }], carets: {}, recovery: [], ...(noticed ? { notices: NOTICES } : {}) };
}

function pair(s: UndoScenario, first: UndoWriter): [UndoReplica, UndoReplica] {
  return first === "Alice" ? [s.a, s.b] : [s.b, s.a];
}

export function runInsideRange(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.type(s.a, "R1", 2, "xyz", ["a1", "a2", "a3"]);
  s.deliver();
  s.type(s.b, "R1", 3, "Q", ["b1"]);
  s.check("typed", insideRangeOracles.typed);
  const caret = s.effective(s.a.undo.undo());
  assert.ok(caret);
  s.check("undone", insideRangeOracles.undone, { carets: { A: caret } });
  return s;
}

export function runPositionControl(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.type(s.a, "R1", 2, "xy", ["a1", "a2"]);
  s.type(s.b, "R1", 0, "Q", ["b1"]);
  s.deliver();
  s.effective(s.a.undo.undo());
  s.check("undone", positionControlOracle);
  return s;
}

export function runDoubleDelete(order: DeliveryOrder, first: UndoWriter, concurrent: boolean, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "abcd" }], order, kind), [one, two] = pair(s, first);
  s.erase(s.a, "R1", 1, 3);
  s.erase(s.b, "R1", 2, 3);
  s.check("deleted", doubleDeleteOracles.deleted);
  s.effective(one.undo.undo());
  if (!concurrent) s.deliver();
  s.effective(two.undo.undo(), concurrent || first === "Bob");
  s.check("both undone", doubleDeleteOracles["both undone"]);
  return s;
}

export function runRedoAfterRemote(order: DeliveryOrder, sameGap: boolean, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], order, kind);
  s.type(s.a, "R1", 2, "xy", ["a1", "a2"]);
  s.check("typed", redoOracles.typed);
  s.effective(s.a.undo.undo());
  s.check("undone", redoOracles.undone);
  s.type(s.b, sameGap ? "R1" : "R2", sameGap ? 2 : 1, "Z", ["b1"]);
  if (!sameGap) s.check("remote elsewhere", redoOracles["remote elsewhere"]);
  s.effective(s.a.undo.redo());
  s.check("redone", sameGap ? redoneAtGapOracle : redoOracles.redone);
  return s;
}

export function runEmptyBeatInsert(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "ab" }, { id: "R2", text: "" }], order, kind);
  s.type(s.a, "R2", 0, "x", ["a1"]);
  s.check("empty beat typed", endpointOracles["empty beat typed"]);
  const caret = s.effective(s.a.undo.undo());
  assert.ok(caret);
  s.check("empty beat undone", endpointOracles["empty beat undone"], { carets: { A: caret } });
  return s;
}

export function runLongChain(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.format(s.a, "R1", 1, 2, BOLD);
  for (let round = 0; round < 64; round++) {
    s.erase(s.a, "R1", 1, 2);
    s.effective(s.a.undo.undo());
  }
  s.deliver();
  assert.deepEqual(s.a.undo.sizes(), { undo: 1, redo: 1, dropped: 0 });
  s.effective(s.a.undo.undo());
  s.check("bold undone", longChainOracle);
  return s;
}

export function runThrowingUndo(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.type(s.a, "R1", 2, "x", ["a1"]);
  s.a.failNextReversal = "the record cannot be resolved";
  assert.throws(() => s.a.undo.undo(), /the record cannot be resolved/);
  assert.deepEqual(s.a.undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
  s.check("after the throw", throwingUndoOracles.thrown);
  s.effective(s.a.undo.undo());
  s.check("insert undone", throwingUndoOracles["insert undone"]);
  return s;
}

export function runHeldSelection(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "abcd" }], order, kind), held = s.a.observe("R1", 1, 3).selection;
  s.erase(s.a, "R1", 1, 3);
  s.effective(s.a.undo.undo());
  s.check("held selection mapped", heldSelectionOracle, { carets: { A: held } });
  return s;
}

export function runLaterFormat(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "abcd" }], order, kind);
  s.format(s.a, "R1", 0, 2, BOLD);
  s.deliver();
  s.format(s.b, "R1", 1, 3, UNBOLD);
  s.format(s.b, "R1", 1, 3, BOLD);
  s.check("Bob bolded", laterFormatOracles["Bob bolded"]);
  s.effective(s.a.undo.undo());
  s.check("Alice undone", laterFormatOracles["Alice undone"]);
  return s;
}

export function runRestoredChain(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.type(s.b, "R1", 0, "Q", ["b1"]);
  s.deliver();
  s.type(s.a, "R1", 3, "x", ["a1"]);
  s.format(s.a, "R1", 3, 4, BOLD);
  s.erase(s.a, "R1", 3, 4);
  s.check("commands", chainOracles.commands);
  for (const phase of ["delete undone", "format undone", "insert undone"]) {
    s.effective(s.a.undo.undo());
    s.check(phase, chainOracles[phase]);
  }
  for (const phase of ["insert redone", "format redone", "delete redone"]) {
    s.effective(s.a.undo.redo());
    s.check(phase, chainOracles[phase]);
  }
  return s;
}

export function runIdenticalTag(order: DeliveryOrder, first: UndoWriter, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "the red mug" }, { id: "R2", text: "ok" }], order, kind), [one, two] = pair(s, first);
  s.type(s.a, "R2", 2, "?", ["a1"]);
  s.type(s.b, "R2", 0, "!", ["b1"]);
  s.deliver();
  s.format(s.a, "R1", 4, 11, TAG_P);
  s.format(s.b, "R1", 4, 11, TAG_P);
  s.check("tagged", identicalTagOracles.tagged);
  s.effective(one.undo.undo());
  s.check("untagged", identicalTagOracles.untagged);
  s.usedUp(two);
  s.check("other undo used up", identicalTagOracles.untagged);
  s.effective(two.undo.undo());
  s.check("older undone", identicalTagOracles[`${first === "Alice" ? "Bob" : "Alice"} older undone`]);
  return s;
}

export function runSequentialStatus(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.a.status("R1", "ready");
  s.a.status("R1", "shot");
  s.check("shot", statusOracles.shot, { status: true });
  s.effective(s.a.undo.undo());
  s.check("first undo", statusOracles.ready, { status: true });
  s.effective(s.a.undo.undo());
  s.check("second undo", statusOracles.todo, { status: true });
  return s;
}

export function runStatusRedo(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.a.status("R1", "ready");
  s.b.status("R1", "shot");
  s.check("concurrent", statusRedoObserved.todo, { status: true });
  s.usedUp(s.a);
  s.check("Alice undone", statusRedoObserved.todo, { status: true });
  assert.deepEqual(s.a.undo.redo(), { ok: false, empty: true });
  s.check("nothing to redo", statusRedoObserved.todo, { status: true });
  return s;
}

export function runConcurrentStatus(order: DeliveryOrder, same: boolean, first: UndoWriter, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind), [one, two] = pair(s, first);
  s.a.status("R1", same ? "shot" : "ready");
  s.b.status("R1", "shot");
  s.check("concurrent", status(same ? "shot" : "todo", !same), { status: true });
  if (!same) {
    one.status("R1", "ready");
    s.check("later status", status("ready", true), { status: true });
    s.effective(one.undo.undo());
    s.check("later status undone", status("todo", true), { status: true });
    s.usedUp(one);
  } else s.effective(one.undo.undo());
  s.check("first undo", status("todo", !same), { status: true });
  s.usedUp(two);
  s.check("second undo", status("todo", !same), { status: true });
  return s;
}

export function runStatusPrior(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.a.status("R1", "shot");
  s.b.status("R1", "shot");
  s.deliver();
  s.effective(s.a.undo.undo());
  s.deliver();
  s.b.status("R1", "ready");
  s.deliver();
  s.effective(s.b.undo.undo());
  s.check("prior after retirement", status("todo"), { status: true });
  return s;
}

export function runStatusUsedUp(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  const kept: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Z", {}]], status: "todo" }], carets: {}, recovery: [] };
  s.type(s.b, "R1", 2, "Z", ["b1"]);
  s.deliver();
  s.a.status("R1", "shot");
  s.b.status("R1", "shot");
  s.deliver();
  s.effective(s.a.undo.undo());
  s.check("Alice's undo", kept, { status: true });
  s.usedUp(s.b);
  s.check("Bob's undo used up", kept, { status: true });
  s.effective(s.b.undo.undo());
  s.check("Bob's earlier insertion undone", status("todo"), { status: true });
  return s;
}

export function runSemanticStatus(order: DeliveryOrder, identical: boolean, undo: readonly UndoWriter[], kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.a.status("R1", "ready");
  s.a.status("R1", "shot");
  s.b.status("R1", identical ? "ready" : "shot");
  s.b.status("R1", identical ? "shot" : "ready");
  s.check("branches", status(identical ? "shot" : "todo", !identical), { status: true });
  undo.forEach((writer, index) => {
    const replica = writer === "Alice" ? s.a : s.b;
    if (identical && index === 0) s.effective(replica.undo.undo());
    else s.usedUp(replica);
    s.deliver();
  });
  s.check("undone", status(identical ? "ready" : "todo", !identical), { status: true });
  return s;
}

export function runT21(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "abcd" }], order, kind), seen = s.a.observe("R1", 1, 3);
  s.type(s.b, "R1", 2, "X", ["b1"]);
  if (order === "D3") s.world.queue.deliverFrom("B", order);
  s.a.mark(seen, BOLD);
  s.check("T21", markOracles.T21);
  const selection = s.effective(s.a.undo.undo());
  assert.ok(selection);
  s.check("T21 undo", markOracles["T21 undo"], { carets: { A: selection } });
  return s;
}

export function runT21Scalar(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario(AB, order, kind);
  s.type(s.a, "R1", 2, "Z", ["a1"]);
  s.a.status("R1", "ready");
  s.b.status("R1", "shot");
  s.check("T21 scalar", markOracles["T21 scalar"], { status: true });
  s.usedUp(s.a);
  s.check("T21 scalar first undo", markOracles["T21 scalar"], { status: true });
  s.effective(s.a.undo.undo());
  s.check("T21 scalar undo", markOracles["T21 scalar undo"], { status: true });
  return s;
}

export function runHonestDeletion(order: DeliveryOrder, kind: UndoWorldKind = MODEL_WORLD): UndoScenario {
  const s = new UndoScenario([{ id: "R1", text: "abcd" }], order, kind), seen = s.a.observe("R1", 1, 3), caret = s.a.observe("R1", 1, 1).selection;
  s.type(s.b, "R1", 2, "X", ["b1"]);
  s.world.queue.deliverFrom("B", order);
  s.a.edit({ at: seen });
  s.check("deleted", deletionOracle, { carets: { A: caret } });
  const selection = s.effective(s.a.undo.undo());
  assert.ok(selection);
  s.check("undone", {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["b1", "X", {}], ["s3*", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R1", offset: 1, selection: { beat: "R1", from: 1, to: 4 } } }, recovery: []
  }, { carets: { A: selection } });
  return s;
}
