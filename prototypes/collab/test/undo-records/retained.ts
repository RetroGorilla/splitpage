import assert from "node:assert/strict";
import * as Y from "yjs";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { deliveryOrders } from "../../src/delivery.ts";
import { statusValue } from "../../src/marks/commands.ts";
import { readStatusEvent } from "../../src/marks/status-resolution.ts";
import type { ScriptOracle } from "../../src/model.ts";
import { createProjectionReplica, fromDocument } from "../../src/proj/document.ts";
import { mapValue } from "../../src/schema.ts";
import type { SchemaReplica } from "../../src/schema.ts";
import { structuralCaret } from "../../src/structure-selection.ts";
import { captureRange, changeStatus, insertText, replaceRange, split } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import { RecordBufferHarness } from "../../src/undo-records/buffer.ts";
import { statusReaders } from "../marks/status-readers.ts";
import { bufferOracles, bufferTraceOrder } from "../buffer-oracles.ts";
import { replacementIntentFixtures } from "../buffer-replacements.ts";
import { deletionOracle, splitOracle, splitUndoOracle, swappedSplitOracle } from "../oracles.ts";
import { markTraces } from "../marks/runner.ts";
import { beatOracles } from "../structure-oracles.ts";
import { structureTraces } from "../structure-runner.ts";
import { attempt, bufferOrders, runBufferTrace, runReplacement } from "./buffer-runner.ts";
import { Scenario } from "./cases.ts";
import type { CaseResult, Writer } from "./cases.ts";
import { runRecord } from "./runner.ts";
import { runReaderIdentity, runReaderRemovalConsumed, runReaderRemovals } from "./reader-order.ts";

export interface FamilyRun {
  label: string;
  run: () => CaseResult;
}

export interface RetainedFamily {
  name: string;
  runs: FamilyRun[];
}

function lateJoined(orders: readonly DeliveryOrder[]): DeliveryOrder[] {
  return orders.includes("late-C") ? [...orders] : [...orders, "late-C"];
}

function traceFamily(trace: string, orders: readonly DeliveryOrder[]): RetainedFamily {
  const swaps = trace === "T06" ? [false, true] : [false];
  return {
    name: trace,
    runs: swaps.flatMap(swapped => lateJoined(orders).map(order => ({
      label: `${order}${swapped ? " swapped" : ""}`,
      run: (): CaseResult => {
        const result = runRecord(trace, order, swapped);
        return { name: trace, failure: result.failure, history: result.history, checks: result.checks };
      }
    })))
  };
}

function bufferRun(label: string, attemptRun: () => string | null): FamilyRun {
  return { label, run: () => { const failure = attemptRun(); return { name: label, failure, history: failure ? [`FAIL ${failure}`] : [], checks: failure ? 0 : 2 }; } };
}

function status(value: string): ScriptOracle {
  return { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: value }], carets: {}, recovery: [] };
}

function todoFixture(scenario: Scenario, beats: readonly string[]): void {
  const alice = scenario.replicas.Alice;
  alice.doc.transact(() => { for (const beat of beats) mapValue(alice.doc.getMap("beats").get(beat)).set("status", "todo"); }, "fixture");
  scenario.harness.queue.flush("D2");
}

export function runSplitInsert(order: DeliveryOrder, swapped: boolean): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abcd" }], order, swapped);
  return scenario.run("Alice splits abcd at 2 while Bob inserts X at 2; Alice undoes", () => {
    const original = { position: structuralCaret(scenario.replicas.Alice, "R1", 2) };
    scenario.carets.set("A", split(scenario.histories.Alice, "R1", 2, "Ra", "a1", undefined, original));
    scenario.carets.set("B", insertText(scenario.histories.Bob, "R1", 2, "X", ["b1"]));
    scenario.check("split", swapped ? swappedSplitOracle : splitOracle);
    const undone = scenario.undo("Alice");
    if (!undone.selection) throw new Error("Split undo restored no caret");
    scenario.carets.set("A", undone.selection);
    scenario.check("split undone", splitUndoOracle);
    return undefined;
  });
}

export function runHonestDeletion(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abcd" }], "dup", false);
  return scenario.run("Alice deletes the bc she saw after Bob's X arrived between them; Alice undoes", () => {
    const capture = captureRange(scenario.histories.Alice, "R1", 1, "R1", 3);
    scenario.carets.set("A", { position: structuralCaret(scenario.replicas.Alice, "R1", 1, -1) });
    insertText(scenario.histories.Bob, "R1", 2, "X", ["b1"]);
    scenario.harness.queue.deliverFrom("B", "D3");
    replaceRange(scenario.histories.Alice, capture, "", [], "Alice");
    scenario.check("deleted", deletionOracle);
    const undone = scenario.undo("Alice");
    if (!undone.selection) throw new Error("Delete undo restored no selection");
    scenario.carets.set("A", undone.selection);
    scenario.harness.queue.flush("dup");
    scenario.harness.lateJoin();
    scenario.check("undone", {
      rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2*", "b", {}], ["b1", "X", {}], ["s3*", "c", {}], ["s4", "d", {}]] }],
      carets: { A: { beat: "R1", offset: 1, selection: { beat: "R1", from: 1, to: 4 } } }, recovery: []
    });
    return undefined;
  });
}

export function runReanchor(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "abc" }, { id: "R2", text: "de" }, { id: "R3", text: "fgh" }], "D3", false);
  return scenario.run("T09: the range undo reanchors its captured selection to the restored identities", () => {
    const capture = captureRange(scenario.histories.Alice, "R1", 1, "R3", 2);
    insertText(scenario.histories.Bob, "R1", 2, "W", ["b1"]);
    insertText(scenario.histories.Bob, "R2", 1, "X", ["b2"]);
    insertText(scenario.histories.Bob, "R3", 2, "Y", ["b3"]);
    scenario.harness.queue.flush("D3");
    replaceRange(scenario.histories.Alice, capture, "Z", ["a1"], "Alice");
    const undone = scenario.undo("Alice");
    if (!undone.selection) throw new Error("Range undo restored no selection");
    const oracle = beatOracles["T09 undo"];
    if (!oracle) throw new Error("Missing literal oracle T09 undo");
    scenario.carets.set("A", undone.selection);
    scenario.check("restored", oracle);
    scenario.carets.set("A", capture.anchor);
    assert.throws(() => scenario.check("stale", oracle), /stale\/client\d+\.carets\.A/);
    return undefined;
  });
}

export function runStatusPrior(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], "dup", false);
  return scenario.run("a later status command captures the actual prior value after an identical undo", () => {
    todoFixture(scenario, ["R1"]);
    changeStatus(scenario.histories.Alice, "R1", "sA", "shot", "Alice");
    changeStatus(scenario.histories.Bob, "R1", "sB", "shot", "Bob");
    scenario.harness.queue.flush("D1");
    scenario.undo("Alice");
    scenario.harness.queue.flush("D1");
    changeStatus(scenario.histories.Bob, "R1", "sLater", "ready", "Bob");
    scenario.harness.queue.flush("D2");
    scenario.undo("Bob");
    scenario.harness.queue.flush("dup");
    scenario.harness.lateJoin(scenario.replicas.Bob);
    scenario.check("prior after retirement", status("todo"));
    return undefined;
  });
}

export function runStatusLocal(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }], "dup", false);
  return scenario.run("status event parents and prior values stay local to their target beat", () => {
    todoFixture(scenario, ["R1", "R2"]);
    changeStatus(scenario.histories.Alice, "R1", "sA", "ready", "Alice");
    scenario.harness.queue.flush("D2");
    changeStatus(scenario.histories.Bob, "R2", "sB", "shot", "Bob");
    scenario.undo("Bob");
    scenario.harness.queue.flush("dup");
    scenario.harness.lateJoin(scenario.replicas.Bob);
    scenario.check("target status", { rows: [
      { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "ready" },
      { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]], status: "todo" }
    ], carets: {}, recovery: [] });
    return undefined;
  });
}

export function runStatusConsumed(): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], "dup", false);
  return scenario.run("an ineffective identical-status undo consumes its step before the writer's earlier insertion", () => {
    todoFixture(scenario, ["R1"]);
    insertText(scenario.histories.Bob, "R1", 2, "Z", ["b1"]);
    scenario.harness.queue.flush("D2");
    changeStatus(scenario.histories.Alice, "R1", "sA", "shot", "Alice");
    changeStatus(scenario.histories.Bob, "R1", "sB", "shot", "Bob");
    scenario.harness.queue.flush("D1");
    scenario.harness.lateJoin(scenario.replicas.Bob);
    const retained: ScriptOracle = { rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "Z", {}]], status: "todo" }], carets: {}, recovery: [] };
    scenario.undo("Alice");
    scenario.check("Alice's undo", retained);
    scenario.consumed("Bob");
    scenario.check("Bob's undo consumed", retained);
    assert.equal(scenario.undo("Bob").effective, true);
    scenario.check("Bob's earlier insertion undone", status("todo"));
    return undefined;
  });
}

export function runConcurrentStatus(order: "D1" | "late-C", swapped: boolean, same: boolean, first: Writer): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, swapped);
  const second: Writer = first === "Alice" ? "Bob" : "Alice";
  const notices = same ? {} : { notices: ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply"] };
  const oracle = (value: string): ScriptOracle => ({ ...status(value), ...notices });
  return scenario.run(`A-H12: ${same ? "identical" : "different"} concurrent statuses; ${first} undoes first`, () => {
    todoFixture(scenario, ["R1"]);
    changeStatus(scenario.histories.Alice, "R1", "sA", same ? "shot" : "ready", "Alice");
    changeStatus(scenario.histories.Bob, "R1", "sB", "shot", "Bob");
    scenario.check("concurrent", oracle(same ? "shot" : "todo"));
    if (!same) {
      changeStatus(scenario.histories[first], "R1", "sLater", "ready", first);
      scenario.check("later status", oracle("ready"));
      scenario.undo(first);
      scenario.check("later status undone", oracle("todo"));
    }
    scenario.undo(first);
    scenario.check(`${first}'s undo`, oracle("todo"));
    if (same) scenario.consumed(second);
    else {
      const before = scenario.histories[second].undoStack.length;
      scenario.undo(second);
      assert.equal(scenario.histories[second].undoStack.length, before - 1);
    }
    scenario.check(`${second}'s undo`, oracle("todo"));
    return undefined;
  });
}

const writerNotices = { notices: ["writer0: concurrent status change did not apply", "writer1: concurrent status change did not apply"] };

export function runStatusEitherUndo(order: DeliveryOrder, swapped: boolean, same: boolean, first: Writer): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, swapped);
  const second: Writer = first === "Alice" ? "Bob" : "Alice";
  const notices = same ? {} : writerNotices;
  const oracle = (value: string): ScriptOracle => ({ ...status(value), ...notices });
  return scenario.run(`${same ? "identical" : "different"} concurrent status roots; ${first} undoes, then ${second}`, () => {
    todoFixture(scenario, ["R1"]);
    changeStatus(scenario.histories.Alice, "R1", "s0", same ? "shot" : "ready", "writer0");
    changeStatus(scenario.histories.Bob, "R1", "s1", "shot", "writer1");
    scenario.check("concurrent", oracle(same ? "shot" : "todo"));
    scenario.undo(first);
    scenario.check(`${first}'s undo`, oracle("todo"));
    scenario.undo(second);
    scenario.check(`${second}'s undo`, oracle("todo"));
    return undefined;
  });
}

export function runSemanticUndo(order: DeliveryOrder, swapped: boolean, identical: boolean, undo: readonly Writer[]): CaseResult {
  const scenario = new Scenario([{ id: "R1", text: "ab" }], order, swapped);
  const values = identical ? { a: "ready", c: "shot", b: "ready", d: "shot" } : { a: "ready", c: "shot", b: "shot", d: "ready" };
  return scenario.run(`semantic undo ${undo.join(", ")} of ${identical ? "identical" : "different"} two-event branches`, () => {
    todoFixture(scenario, ["R1"]);
    changeStatus(scenario.histories.Alice, "R1", "a", values.a, "writer0");
    changeStatus(scenario.histories.Alice, "R1", "c", values.c, "writer0");
    changeStatus(scenario.histories.Bob, "R1", "b", values.b, "writer1");
    changeStatus(scenario.histories.Bob, "R1", "d", values.d, "writer1");
    const notices = identical ? {} : writerNotices;
    scenario.check("branches", { ...status(identical ? "shot" : "todo"), ...notices });
    for (const writer of undo) scenario.undo(writer);
    scenario.check("undone", { ...status(identical ? "ready" : "todo"), ...notices });
    return undefined;
  });
}

function literal(name: string, body: (history: string[]) => number): CaseResult {
  const history: string[] = [];
  try {
    return { name, failure: null, history, checks: body(history) };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    history.push(`FAIL ${failure}`);
    return { name, failure, history, checks: 0 };
  }
}

function acceptedEvents(replica: SchemaReplica, phase: string): void {
  for (const [id, raw] of replica.doc.getMap("statusEvents")) assert.ok(readStatusEvent(raw), `${phase}: status event ${id} rejected by readStatusEvent`);
}

export function runStatusAncestry(complete: boolean): CaseResult {
  return literal(`authoring with ${complete ? "complete" : "partial"} status ancestry, then undo`, history => {
    const seed = fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, "B", 100);
    const replicas = [1, 2, 3, 4, 5].map(client => createProjectionReplica("B", client));
    const [x, p, a, c, late] = replicas;
    assert.ok(x && p && a && c && late);
    const histories = [x, p, a, c].map(replica => new CommandHistory(replica));
    const [hx, hp, ha, hc] = histories;
    assert.ok(hx && hp && ha && hc);
    const capture = (replica: SchemaReplica, edit: () => void): Uint8Array => {
      const updates: Uint8Array[] = [];
      const listener = (update: Uint8Array): void => { updates.push(update); };
      replica.doc.on("update", listener);
      try { edit(); } finally { replica.doc.off("update", listener); }
      assert.equal(updates.length, 1);
      const update = updates[0];
      assert.ok(update);
      return update;
    };
    try {
      for (const replica of replicas) Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(seed.doc));
      const ux = capture(x, () => changeStatus(hx, "R1", "x", "ready", "X"));
      for (const replica of [p, a, c]) Y.applyUpdate(replica.doc, ux);
      const up = capture(p, () => changeStatus(hp, "R1", "p", "todo", "P"));
      Y.applyUpdate(a.doc, up);
      const ua = capture(a, () => changeStatus(ha, "R1", "a", "shot", "A"));
      Y.applyUpdate(c.doc, ua);
      history.push(`X ready, P todo after X, A shot after P; C has ${complete ? "X, P and A" : "X and A"}`);
      if (complete) Y.applyUpdate(c.doc, up);
      changeStatus(hc, "R1", "c", "ready", "C");
      const event = readStatusEvent(c.doc.getMap("statusEvents").get("c"));
      assert.deepEqual(event?.parents, complete ? ["a"] : ["a", "x"]);
      Y.applyUpdate(c.doc, up);
      const undone = hc.undo();
      history.push(`C ready, receives P, undoes: effective=${String(undone.effective)}`);
      Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(c.doc));
      let checks = 0;
      for (const replica of [c, late]) {
        acceptedEvents(replica, `client${replica.doc.clientID}`);
        for (const [reader, value] of Object.entries(statusReaders(replica))) {
          assert.equal(value, complete ? "shot" : "todo", `client${replica.doc.clientID} ${reader}`);
          checks++;
        }
      }
      return checks;
    } finally {
      for (const replica of [...replicas, seed]) replica.destroy();
    }
  });
}

export function runStatusEmits(): CaseResult {
  return literal("status command, undo and redo emit only accepted events and true retirement flags; invalid values write nothing", history => {
    const source = fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, "B", 100);
    const commands = new CommandHistory(source);
    try {
      changeStatus(commands, "R1", "a", "ready", "Alice");
      acceptedEvents(source, "changed");
      assert.equal(commands.undo().effective, true);
      acceptedEvents(source, "undone");
      assert.deepEqual([...source.doc.getMap("retiredStatus").values()], [true]);
      assert.equal(commands.redo().effective, true);
      acceptedEvents(source, "redone");
      assert.equal(statusValue(source, "R1"), "ready");
      history.push("change, undo and redo: every status event accepted");
      for (const value of ["bogus", "", "READY", "done"]) {
        const before = Y.encodeStateAsUpdate(source.doc);
        const stack = commands.undoStack.length;
        assert.throws(() => changeStatus(commands, "R1", "bad", value, "Alice"), /Invalid status command/);
        assert.deepEqual(Y.encodeStateAsUpdate(source.doc), before);
        assert.equal(commands.undoStack.length, stack);
      }
      history.push("invalid values throw and write nothing");
      return 4;
    } finally {
      source.destroy();
    }
  });
}

function runIngress(path: string): string | null {
  return attempt(() => {
    const harness = new RecordBufferHarness(bufferOracles.T04.seed);
    try {
      const alice = harness.alice;
      alice.paint("R1", 2);
      alice.dispatch({ type: "compositionstart", from: 2, to: 2 });
      alice.dispatch({ type: "compositionupdate", data: "xy" });
      harness.bob.editor.insert("R1", 0, "Z", ["b1"]);
      harness.bob.editor.deleteIdentities(["s4"]);
      for (const message of harness.queue.pending.filter(message => message.from === "B")) alice.receive(message.update, path);
      assert.equal(alice.editor.characters().filter(character => character.beat === "R1").map(character => character.value).join(""), "abcd");
      alice.dispatch({ type: "compositionend", names: ["a1", "a2"] });
      harness.queue.flush("dup");
      harness.check(bufferOracles.T04.expected);
      alice.undo();
      harness.queue.flush("dup");
      harness.check(bufferOracles.T04.undo);
      return harness;
    } catch (error) {
      harness.destroy();
      throw error;
    }
  });
}

function runCleanRemote(): string | null {
  return attempt(() => {
    const harness = new RecordBufferHarness(bufferOracles.T02.seed);
    try {
      harness.alice.paint("R1", 2);
      harness.bob.editor.insert("R1", 0, "X", ["b1"]);
      harness.queue.deliverFrom("B", "D3");
      assert.equal(harness.alice.nativeValue, "Xab");
      harness.alice.dispatch({ type: "beforeinput", from: 3, to: 3, data: "c", names: ["a1"] });
      harness.alice.commit(["a1"]);
      harness.queue.flush("D3");
      harness.check(bufferOracles.T02.expected);
      harness.alice.undo();
      harness.queue.flush("D3");
      harness.check(bufferOracles.T02.undo);
      return harness;
    } catch (error) {
      harness.destroy();
      throw error;
    }
  });
}

const structureFamilies = Object.entries(structureTraces).map(([trace, orders]) => traceFamily(trace, orders));
const markFamilies = Object.entries(markTraces).map(([trace, orders]) => traceFamily(trace, orders));
const glue = traceFamily("U-H1 glue rewrite", ["D2"]);
const topItem = traceFamily("U-H1 top item", ["D1"]);
const bufferFamilies: RetainedFamily[] = bufferTraceOrder.map(trace => ({
  name: `${trace} undo half, M1`,
  runs: bufferOrders(bufferOracles[trace].orders).map(order => bufferRun(order, () => attempt(() => runBufferTrace(trace, order))))
}));
const replacementFamilies: RetainedFamily[] = replacementIntentFixtures.map(fixture => ({
  name: `replacement: ${fixture.name}, M1`,
  runs: bufferOrders(fixture.orders).map(order => bufferRun(order, () => attempt(() => runReplacement(fixture, order))))
}));
const splitInsert: RetainedFamily = {
  name: "T05 split and insert at the same offset",
  runs: (["D1", "dup", "rev", "late-C"] as const).flatMap(order => [false, true].map(swapped => ({ label: `${order}${swapped ? " swapped" : ""}`, run: () => runSplitInsert(order, swapped) })))
};
const honest: RetainedFamily = { name: "Honest deletion of a stale span, then undo", runs: [{ label: "D3, dup, late-C", run: runHonestDeletion }] };
const reanchor: RetainedFamily = { name: "T09 undo reanchors its captured selection", runs: [{ label: "D3", run: runReanchor }] };
const statusTests: RetainedFamily = {
  name: "Status: prior value, target locality, consumed identical undo",
  runs: [{ label: "prior", run: runStatusPrior }, { label: "local", run: runStatusLocal }, { label: "consumed", run: runStatusConsumed }]
};
const concurrentStatus: RetainedFamily = {
  name: "A-H12 concurrent statuses",
  runs: [false, true].flatMap(swapped => (["D1", "late-C"] as const).flatMap(order => [false, true].flatMap(same => (["Alice", "Bob"] as const).map(first => ({
    label: `${order}${swapped ? " swapped" : ""} ${same ? "identical" : "different"} ${first} first`,
    run: () => runConcurrentStatus(order, swapped, same, first)
  })))))
};
const statusOrders = ["D1", "rev", "dup", "late-C"] as const;
const eitherUndo: RetainedFamily = {
  name: "Status resolution: either undo of concurrent roots, late join",
  runs: [false, true].flatMap(swapped => statusOrders.flatMap(order => [false, true].flatMap(same => (["Alice", "Bob"] as const).map(first => ({
    label: `${order}${swapped ? " swapped" : ""} ${same ? "identical" : "different"} ${first} first`,
    run: () => runStatusEitherUndo(order, swapped, same, first)
  })))))
};
const semanticUndo: RetainedFamily = {
  name: "Status resolution: semantic undo of two-event branches",
  runs: [false, true].flatMap(swapped => statusOrders.flatMap(order => [false, true].flatMap(identical => ([["Alice"], ["Bob"], ["Alice", "Bob"], ["Bob", "Alice"]] as const).map(undo => ({
    label: `${order}${swapped ? " swapped" : ""} ${identical ? "identical" : "different"} undo ${undo.join(", ")}`,
    run: () => runSemanticUndo(order, swapped, identical, undo)
  })))))
};
const ancestry: RetainedFamily = {
  name: "Status authoring with complete or partial ancestry, then undo",
  runs: [false, true].map(complete => ({ label: complete ? "complete" : "partial", run: () => runStatusAncestry(complete) }))
};
const emits: RetainedFamily = { name: "Status commands and their undo emit only accepted events", runs: [{ label: "single replica", run: runStatusEmits }] };
const ingress: RetainedFamily = {
  name: "T04 ingress paths share the dirty gate, M1",
  runs: ["delivery", "hydration", "recovery-restore"].map(path => bufferRun(path, () => runIngress(path)))
};
const cleanRemote: RetainedFamily = { name: "T02 clean remote integration repaints, M1", runs: [bufferRun("D3", runCleanRemote)] };
const readerRemovals: RetainedFamily = {
  name: "Reader order: all removers, either undo, early delivery and re-removal",
  runs: deliveryOrders.flatMap(order => [false, true].flatMap(swapped => ([["a", "b"], ["z", "a"]] as const).flatMap(ids => [0, 1].flatMap(first => [false, true].map(early => ({
    label: `${order}, swapped ${swapped}, ids ${ids}, first ${first}, early ${early}`,
    run: () => runReaderRemovals(order, swapped, ids, first, early)
  }))))))
};
const readerConsumed: RetainedFamily = {
  name: "Reader order: ineffective removal undo consumes only its own step",
  runs: deliveryOrders.map(order => ({ label: order, run: () => runReaderRemovalConsumed(order) }))
};
const readerIdentity: RetainedFamily = {
  name: "Reader review: identity-writing commands and status undo",
  runs: [{ label: "normalized stored keys", run: runReaderIdentity }]
};

export const retainedFamilies: RetainedFamily[] = [
  ...structureFamilies, glue, topItem, ...markFamilies, splitInsert, honest, reanchor, statusTests, concurrentStatus,
  eitherUndo, semanticUndo, ancestry, emits, ...bufferFamilies, ingress, cleanRemote, ...replacementFamilies,
  readerRemovals, readerConsumed, readerIdentity
];

const names = (families: readonly RetainedFamily[]): string[] => families.map(family => family.name);

export const retainedUndoSources: Record<string, string[]> = {
  "test/structure-runner.ts": [...names(structureFamilies), glue.name, topItem.name],
  "test/structure.test.ts": [...names(structureFamilies), reanchor.name],
  "test/marks/runner.ts": names(markFamilies),
  "test/marks/marks.test.ts": [...names(markFamilies), statusTests.name, concurrentStatus.name],
  "test/marks/review-histories.test.ts": [ancestry.name],
  "test/marks/status-resolution.test.ts": [eitherUndo.name, semanticUndo.name],
  "test/marks/status-roundtrip.test.ts": [emits.name],
  "test/harness.test.ts": [honest.name, splitInsert.name],
  "test/buffer-runner.ts": names(bufferFamilies),
  "test/buffers.test.ts": [...names(bufferFamilies), ingress.name, cleanRemote.name],
  "test/buffer-replacement-runner.ts": names(replacementFamilies),
  "test/reader-order/readers.test.ts": [readerRemovals.name, readerConsumed.name],
  "test/reader-order/review.test.ts": [readerIdentity.name]
};
