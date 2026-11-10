import assert from "node:assert/strict";
import { ReplicaHarness } from "../../src/delivery.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { checkModel } from "../../src/model.ts";
import type { ScriptOracle } from "../../src/model.ts";
import type { ReplicaCaretAnchor } from "../../src/reader.ts";
import { identityAt, mapValue } from "../../src/schema.ts";
import type { SchemaReplica, SeedBeat } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { structuralCaret } from "../../src/structure-selection.ts";
import { clearGlue, seedJoinMetadata } from "../../src/structure.ts";
import { addComment, addReply, changeStatus, formatRange, formatSelection, insertText, join, moveBeat, removeBeat, setScalar, split } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import type { UndoDefect, UndoOutcome } from "../../src/undo-records/history.ts";
import { markTraces } from "../marks/runner.ts";
import { markOracles } from "../marks/oracles.ts";
import { joinBoldUndoOracle, joinOracle, joinUndoOracle, removedOracle, restorationOracle } from "../oracles.ts";
import { beatOracles } from "../structure-oracles.ts";
import { structureTraces } from "../structure-runner.ts";

export interface RecordRunResult {
  trace: string;
  order: DeliveryOrder;
  swapped: boolean;
  checks: number;
  failure: string | null;
  history: string[];
}

function withLateJoiner(orders: readonly DeliveryOrder[] | undefined): DeliveryOrder[] {
  if (!orders) throw new Error("Missing retained order list");
  return orders.includes("late-C") ? [...orders] : [...orders, "late-C"];
}

export const recordTraces: Record<string, DeliveryOrder[]> = {
  T06: withLateJoiner(structureTraces.T06), T10: withLateJoiner(structureTraces.T10), T12: withLateJoiner(structureTraces.T12),
  "T12 join": withLateJoiner(structureTraces["T12 join"]), T21: withLateJoiner(markTraces.T21),
  "T21 comment": withLateJoiner(markTraces["T21 comment"]), "T21 scalar": withLateJoiner(markTraces["T21 scalar"]),
  "U-H1 glue rewrite": withLateJoiner(["D2"]), "U-H1 top item": withLateJoiner(["D1"]),
  "MOVE concurrent": withLateJoiner(structureTraces["MOVE concurrent"]), "MOVE destination": withLateJoiner(structureTraces["MOVE destination"]),
  "MOVE delete": withLateJoiner(structureTraces["MOVE delete"])
};

const glueRewriteOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", { i: true }], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["b1", "Z", {}], ["s4", "d", {}]] }], carets: {}, recovery: []
};
const topItemOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "Z", {}]], status: "shot" }], carets: {}, recovery: []
};

function fixture(trace: string): SeedBeat[] {
  if (trace === "T12") return [{ id: "R1", text: "abcd" }];
  if (trace.startsWith("T21")) return [{ id: "R1", text: trace === "T21 scalar" ? "ab" : "abcd" }];
  if (trace === "U-H1 top item") return [{ id: "R1", text: "ab" }];
  return [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, ...(trace === "T10" || trace.startsWith("MOVE") ? [{ id: "R3", text: "ef" }] : [])];
}

export function countUpdates(replica: SchemaReplica, action: () => UndoOutcome): { outcome: UndoOutcome; updates: number } {
  let updates = 0;
  const listener = (): void => { updates++; };
  replica.doc.on("update", listener);
  try {
    return { outcome: action(), updates };
  } finally {
    replica.doc.off("update", listener);
  }
}

function bound(harness: ReplicaHarness, notation: string): boolean {
  try {
    harness.identities.identity(notation);
    return true;
  } catch {
    return false;
  }
}

export function bindRestores(harness: ReplicaHarness, outcome: UndoOutcome): void {
  for (const [original, restored] of outcome.restored) {
    assert.notDeepEqual(restored, original, "a restore reused the deleted identity");
    let notation = harness.identities.notation(original);
    if (notation.startsWith("?")) continue;
    do notation = `${notation}*`; while (bound(harness, notation));
    harness.identities.bind(notation, restored);
  }
}

export function runRecord(trace: string, order: DeliveryOrder, swapped = false, defect?: UndoDefect): RecordRunResult {
  const harness = new ReplicaHarness("B", fixture(trace), swapped);
  const { alice: a, bob: b, queue } = harness;
  const ha = new CommandHistory(a, defect ? { defect } : {});
  const hb = new CommandHistory(b, defect ? { defect } : {});
  const carets = new Map<string, ReplicaCaretAnchor>();
  let checks = 0;
  const check = (phase: string, oracle: ScriptOracle | undefined): void => {
    queue.flush(order);
    if (order === "late-C" && harness.replicas.length === 2) harness.lateJoin(b);
    if (!oracle) throw new Error(`Missing literal oracle ${phase}`);
    queue.history.push(`check ${phase}`);
    for (const replica of harness.replicas) {
      let updates = 0;
      const count = (): void => { updates++; };
      replica.doc.on("update", count);
      try {
        checkModel(readStructure(replica.doc, "B", harness.identities, carets), oracle, harness.identities, `${phase}/client${replica.doc.clientID}`);
        assert.equal(updates, 0, "projection emitted a repair update");
      } finally { replica.doc.off("update", count); }
      checks++;
    }
  };
  const undo = (history: CommandHistory, who: string): UndoOutcome => {
    const outcome = history.undo();
    queue.history.push(`${who} undo ${outcome.label ?? "none"} effective=${String(outcome.effective)} consumed=${outcome.consumed}`);
    bindRestores(harness, outcome);
    return outcome;
  };
  const remote = (action: () => void): void => {
    action();
    if (order === "D3") queue.deliverFrom("B", order);
  };
  try {
    queue.history.push(`fixture B ${JSON.stringify(fixture(trace))}${swapped ? ", swapped client ids" : ""}${defect ? `, defect ${defect}` : ""}`);
    switch (trace) {
      case "T06": {
        seedJoinMetadata(a);
        queue.flush("D2");
        formatRange(ha, "R1", 0, 2, { b: true });
        queue.flush("D2");
        carets.set("A", { position: structuralCaret(a, "R2", 0) });
        carets.set("B", { position: structuralCaret(b, "R2", 0) });
        join(ha, "R2", "R1", "jA");
        join(hb, "R2", "R1", "jB");
        check(trace, joinOracle);
        undo(ha, "Alice");
        check("T06 Alice undo", joinUndoOracle);
        const bob = countUpdates(b, () => undo(hb, "Bob"));
        assert.equal(bob.outcome.effective, false, "Bob's join undo after retirement must change nothing");
        assert.equal(bob.updates, 0, "Bob's consumed join undo wrote shared state");
        assert.equal(bob.outcome.consumed, 1);
        check("T06 Bob undo consumed", joinUndoOracle);
        undo(ha, "Alice");
        check("T06 bold undo", joinBoldUndoOracle);
        break;
      }
      case "T10": {
        carets.set("A", { position: structuralCaret(a, "R2", 0) });
        removeBeat(ha, "R2", "rA", "Alice");
        insertText(hb, "R2", 1, "X", ["b1"]);
        check(trace, removedOracle);
        if (harness.replicas.length === 2) harness.lateJoin(b);
        check("T10 late recovery", removedOracle);
        undo(ha, "Alice");
        check("T10 undo", restorationOracle);
        break;
      }
      case "T12": {
        split(ha, "R1", 2, "Ra", "a1");
        const oldBoundary = harness.identities.identity("a1");
        queue.flush(order);
        insertText(hb, "R1", 2, "Y", ["b1"]);
        insertText(hb, "Ra", 0, "X", ["b2"]);
        queue.flush(order);
        if (order === "late-C") harness.lateJoin(b);
        const undone = undo(ha, "Alice");
        if (!undone.selection) throw new Error("Split undo restored no caret");
        carets.set("A", undone.selection);
        check("T12 undo", beatOracles["T12 undo"]);
        const redone = ha.redo();
        queue.history.push(`Alice redo ${redone.label ?? "none"} effective=${String(redone.effective)}`);
        const boundary = a.locate("Ra");
        assert.notDeepEqual(identityAt(boundary.text, boundary.start - 1), oldBoundary);
        carets.clear();
        check("T12 redo", beatOracles["T12 redo"]);
        break;
      }
      case "T12 join": {
        carets.set("A", { position: structuralCaret(a, "R2", 0) });
        join(ha, "R2", "R1", "jA");
        queue.flush(order);
        carets.set("B", insertText(hb, "R2", 1, "Z", ["b1"]));
        check(trace, beatOracles[trace]);
        undo(ha, "Alice");
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      case "U-H1 glue rewrite": {
        formatRange(ha, "R1", 0, 1, { i: true });
        join(ha, "R2", "R1", "jA");
        queue.flush(order);
        insertText(hb, "R2", 1, "Z", ["b1"]);
        clearGlue(b, "R2");
        queue.flush(order);
        if (order === "late-C") harness.lateJoin(b);
        undo(ha, "Alice");
        check(trace, glueRewriteOracle);
        break;
      }
      case "U-H1 top item": {
        a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
        queue.flush("D2");
        insertText(ha, "R1", 2, "Z", ["a1"]);
        setScalar(ha, "R1", "status", "ready");
        setScalar(hb, "R1", "status", "shot");
        queue.flush(order);
        if (order === "late-C") harness.lateJoin(b);
        const overwritten = undo(ha, "Alice");
        assert.equal(overwritten.effective, false, "an overwritten scalar undo must change nothing");
        check(trace, topItemOracle);
        break;
      }
      case "T21": {
        const selection = { position: structuralCaret(a, "R1", 1), selectionEnd: structuralCaret(a, "R1", 3, -1) };
        insertText(hb, "R1", 2, "X", ["b1"], {});
        if (order === "D3") queue.deliverFrom("B", order);
        formatSelection(ha, selection, { b: true });
        check(trace, markOracles[trace]);
        const undone = undo(ha, "Alice");
        if (!undone.selection) throw new Error("Format undo restored no selection");
        carets.set("A", undone.selection);
        check(`${trace} undo`, markOracles[`${trace} undo`]);
        break;
      }
      case "T21 comment": {
        addComment(ha, "C1", "R1", 1, 2, "Alice");
        queue.flush(order);
        addReply(hb, "r1", "C1", "Bob");
        addComment(hb, "C2", "R1", 2, 2, "Bob");
        queue.flush(order);
        undo(ha, "Alice");
        check(`${trace} undo`, markOracles[`${trace} undo`]);
        const redone = ha.redo();
        queue.history.push(`Alice redo ${redone.label ?? "none"} effective=${String(redone.effective)}`);
        check(`${trace} redo`, markOracles[`${trace} redo`]);
        break;
      }
      case "T21 scalar": {
        a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
        queue.flush("D2");
        insertText(ha, "R1", 2, "Z", ["a1"]);
        changeStatus(ha, "R1", "sA", "ready", "Alice");
        changeStatus(hb, "R1", "sB", "shot", "Bob");
        check(trace, markOracles[trace]);
        undo(ha, "Alice");
        check("T21 scalar first undo", markOracles[trace]);
        undo(ha, "Alice");
        check(`${trace} undo`, markOracles[`${trace} undo`]);
        break;
      }
      case "MOVE concurrent": {
        carets.set("A", { position: structuralCaret(a, "R3", 0) });
        assert.equal(moveBeat(ha, "R3", "R1"), true);
        assert.equal(moveBeat(hb, "R3", "R2"), true);
        carets.set("B", insertText(hb, "R3", 1, "X", ["b1"]));
        check(`${trace} B`, beatOracles[`${trace} B`]);
        undo(ha, "Alice");
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      case "MOVE destination": {
        carets.set("A", { position: structuralCaret(a, "R3", 0) });
        remote(() => { insertText(hb, "R1", 0, "Y", ["b1"]); carets.set("B", insertText(hb, "R2", 2, "W", ["b2"])); });
        assert.equal(moveBeat(ha, "R3", "R1"), true);
        check(`${trace} B`, beatOracles[`${trace} B`]);
        undo(ha, "Alice");
        check(`${trace} A`, beatOracles[`${trace} A`]);
        break;
      }
      case "MOVE delete": {
        const aCaret = structuralCaret(a, "R3", 0);
        const bCaret = structuralCaret(b, "R3", 0);
        assert.equal(moveBeat(ha, "R3", "R1"), true);
        removeBeat(hb, "R3", "rB", "Bob");
        carets.set("A", { position: aCaret });
        check(trace, beatOracles[trace]);
        undo(hb, "Bob");
        carets.set("B", { position: bCaret });
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      default: throw new Error(`Unknown record trace ${trace}`);
    }
    return { trace, order, swapped, checks, failure: null, history: [...queue.history] };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return { trace, order, swapped, checks, failure, history: [...queue.history, `FAIL ${failure}`] };
  } finally {
    harness.destroy();
  }
}

export function runRecordTraces(): RecordRunResult[] {
  return Object.entries(recordTraces).flatMap(([trace, orders]) => (trace === "T06" ? [false, true] : [false]).flatMap(swapped => orders.map(order => runRecord(trace, order, swapped))));
}
