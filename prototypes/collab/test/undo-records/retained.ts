import assert from "node:assert/strict";
import type { DeliveryOrder } from "../../src/delivery.ts";
import type { ScriptOracle } from "../../src/model.ts";
import { mapValue } from "../../src/schema.ts";
import { structuralCaret } from "../../src/structure-selection.ts";
import { captureRange, changeStatus, insertText, replaceRange, split } from "../../src/undo-records/commands.ts";
import { RecordBufferHarness } from "../../src/undo-records/buffer.ts";
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
const ingress: RetainedFamily = {
  name: "T04 ingress paths share the dirty gate, M1",
  runs: ["delivery", "hydration", "recovery-restore"].map(path => bufferRun(path, () => runIngress(path)))
};
const cleanRemote: RetainedFamily = { name: "T02 clean remote integration repaints, M1", runs: [bufferRun("D3", runCleanRemote)] };

export const retainedFamilies: RetainedFamily[] = [
  ...structureFamilies, glue, topItem, ...markFamilies, splitInsert, honest, reanchor, statusTests, concurrentStatus,
  ...bufferFamilies, ingress, cleanRemote, ...replacementFamilies
];

const names = (families: readonly RetainedFamily[]): string[] => families.map(family => family.name);

export const retainedUndoSources: Record<string, string[]> = {
  "test/structure-runner.ts": [...names(structureFamilies), glue.name, topItem.name],
  "test/structure.test.ts": [...names(structureFamilies), reanchor.name],
  "test/marks/runner.ts": names(markFamilies),
  "test/marks/marks.test.ts": [...names(markFamilies), statusTests.name, concurrentStatus.name],
  "test/harness.test.ts": [honest.name, splitInsert.name],
  "test/buffer-runner.ts": names(bufferFamilies),
  "test/buffers.test.ts": [...names(bufferFamilies), ingress.name, cleanRemote.name],
  "test/buffer-replacement-runner.ts": names(replacementFamilies)
};
