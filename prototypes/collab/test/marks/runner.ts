import assert from "node:assert/strict";
import * as Y from "yjs";
import { ReplicaHarness } from "../../src/delivery.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { addComment, addReply, changeStatus, formatCapturedMarks, undoCapturedMarks, undoStatus } from "../../src/marks/commands.ts";
import { storedMarkNames } from "../../src/marks/projection.ts";
import { checkModel } from "../../src/model.ts";
import type { ScriptOracle } from "../../src/model.ts";
import type { ReplicaCaretAnchor } from "../../src/reader.ts";
import { initializeSchemaRoots, mapValue, SchemaReplica } from "../../src/schema.ts";
import type { SchemaCandidate } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { captureStructuralRange, structuralCaret, splitWithCaret } from "../../src/structure-selection.ts";
import { structureManager, undoOne } from "../../src/structure.ts";
import type { StructureRunResult } from "../structure-runner.ts";
import { commentsOracle, commentsRemovedOracle, commentsReplyOracle, commentsRestoredOracle } from "../oracles.ts";
import { markOracles } from "./oracles.ts";
import { statusReaders } from "./status-readers.ts";

export const markTraces: Record<string, readonly DeliveryOrder[]> = {
  T11: ["D1", "dup", "late-C"], "T20 nest": ["D1", "dup", "late-C"], "T20 cross": ["D1", "dup", "rev", "late-C"],
  "T20 mark": ["D1", "D3"], T21: ["D1", "D3", "late-C"], "T21 comment": ["D2", "late-C"], "T21 scalar": ["D1"]
};

export function runMark(trace: string, candidate: SchemaCandidate, order: DeliveryOrder, defect?: "single-tag" | "lww-status"): StructureRunResult {
  const seed = trace === "T11" ? [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }] : [{ id: "R1", text: trace.startsWith("T20") ? "the red mug" : trace === "T21 scalar" ? "ab" : "abcd" }];
  const harness = new ReplicaHarness(candidate, seed);
  const { alice: a, bob: b, queue } = harness;
  const ua = structureManager(a);
  const ub = structureManager(b);
  const carets = new Map<string, ReplicaCaretAnchor>();
  let checks = 0;
  const check = (phase: string, explicit?: ScriptOracle, join = true): void => {
    queue.flush(order);
    if (join && (order === "late-C" || trace === "T21 scalar") && harness.replicas.length === 2) harness.lateJoin(b);
    const oracle = explicit ?? markOracles[phase];
    if (!oracle) throw new Error(`Missing literal mark oracle ${phase}`);
    queue.history.push(`check ${phase}`);
    for (const replica of harness.replicas) {
      let updates = 0;
      const countUpdate = (): void => { updates++; };
      replica.doc.on("update", countUpdate);
      try {
        checkModel(readStructure(replica.doc, candidate, harness.identities, carets), oracle, harness.identities, `${phase}/client${replica.doc.clientID}`);
        if (trace === "T21 scalar" && defect !== "lww-status") {
          for (const [reader, status] of Object.entries(statusReaders(replica))) assert.equal(status, oracle.rows[0]?.status, `${phase}/${reader}`);
        }
        assert.equal(updates, 0, "projection emitted a repair update");
      } finally { replica.doc.off("update", countUpdate); }
      checks++;
    }
  };
  try {
    queue.history.push(`fixture ${JSON.stringify(seed)}${defect ? `, defect ${defect}` : ""}`);
    if (trace.startsWith("T20")) {
      a.doc.transact(() => { a.doc.getMap("tags").set("P", { kind: "Prop" }); a.doc.getMap("tags").set("S", { kind: "Sound" }); }, "fixture");
      queue.flush("D2");
    }
    switch (trace) {
      case "T11": {
        addComment(a, "C1", "R1", 1, 2, "Alice");
        addComment(b, "C2", "R1", 2, 2, "Bob");
        check("T11 overlap", commentsOracle, false);
        addReply(b, "r1", "C1", "Bob");
        check("T11 reply", commentsReplyOracle, false);
        ua.stopCapturing();
        ub.stopCapturing();
        carets.set("A", { position: structuralCaret(a, "R1", 0) });
        a.remove("R1", "rA", "Alice");
        carets.set("B", splitWithCaret(b, "R1", 2, "Rb", "b1", "Bob"));
        check("T11 removed/split", commentsRemovedOracle);
        undoOne(ua);
        check("T11 restored", commentsRestoredOracle);
        break;
      }
      case "T20 nest":
      case "T20 cross": {
        a.format("R1", 4, 7, defect === "single-tag" ? { tag: "P" } : { "t:oA": "P" });
        b.format("R1", trace === "T20 nest" ? 8 : 0, trace === "T20 nest" ? 3 : 7, defect === "single-tag" ? { tag: "S" } : { "t:oB": "S" });
        check(trace);
        undoOne(trace === "T20 nest" ? ua : ub);
        check(`${trace} undo`);
        break;
      }
      case "T20 mark": {
        b.format("R1", 8, 3, { "c:C1": true });
        ub.stopCapturing();
        b.format("R1", 4, 3, { "l:L1": "http://x" });
        if (order === "D3") queue.deliverFrom("B", order);
        a.format("R1", 4, 7, { "t:oA": "P" });
        check(trace);
        for (const replica of harness.replicas) {
          const raw = replica.characters().map(character => ({ ...character, notation: harness.identities.notation(character.identity) }));
          assert.deepEqual(storedMarkNames("c:C1", raw), ["s9", "s10", "s11"]);
          assert.deepEqual(storedMarkNames("l:L1", raw), ["s5", "s6", "s7"]);
        }
        undoOne(ub);
        check(`${trace} undo`);
        break;
      }
      case "T21": {
        const selection = captureStructuralRange(a, "R1", 1, "R1", 3);
        b.insert("R1", 2, "X", ["b1"], {});
        if (order === "D3") queue.deliverFrom("B", order);
        formatCapturedMarks(a, selection, { b: true });
        check(trace);
        carets.set("A", undoCapturedMarks(a, ua, selection));
        check(`${trace} undo`);
        break;
      }
      case "T21 comment": {
        addComment(a, "C1", "R1", 1, 2, "Alice");
        queue.flush(order);
        addReply(b, "r1", "C1", "Bob");
        addComment(b, "C2", "R1", 2, 2, "Bob");
        queue.flush(order);
        undoOne(ua);
        check(`${trace} undo`);
        ua.redo();
        check(`${trace} redo`);
        break;
      }
      case "T21 scalar": {
        a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "todo"), "fixture");
        queue.flush("D2");
        a.insert("R1", 2, "Z", ["a1"]);
        ua.stopCapturing();
        if (defect === "lww-status") {
          a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R1")).set("status", "ready"), a.localOrigin);
          b.doc.transact(() => mapValue(b.doc.getMap("beats").get("R1")).set("status", "shot"), b.localOrigin);
        } else {
          changeStatus(a, ua, "R1", "sA", "ready", "Alice");
          changeStatus(b, ub, "R1", "sB", "shot", "Bob");
        }
        check(trace);
        undoStatus(a, ua);
        check("T21 scalar first undo", markOracles[trace]);
        undoOne(ua);
        check(`${trace} undo`);
        break;
      }
      default: throw new Error(`Unknown mark trace ${trace}`);
    }
    return { trace, candidate, order, checks, failure: null, history: [...queue.history] };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return { trace, candidate, order, checks, failure, history: [...queue.history, `FAIL ${failure}`] };
  } finally {
    ua.destroy();
    ub.destroy();
    harness.destroy();
  }
}

export function runMarkExperiments(): StructureRunResult[] {
  return Object.entries(markTraces).flatMap(([trace, orders]) => (["A", "B"] as const).flatMap(candidate => orders.map(order => runMark(trace, candidate, order))));
}

export const rootProbeModes = ["lazy", "eager", "promote-before-comment", "destroyed-managers", "gc-off", "late-delete-lazy", "late-delete-eager", "reload-delete-lazy", "reload-delete-eager"] as const;
export type MarkRootProbeMode = typeof rootProbeModes[number];

export function runRootInitializationProbe(candidate: SchemaCandidate, mode: MarkRootProbeMode): StructureRunResult {
  const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "abcd" }], false, mode === "eager");
  const { alice: a, bob: b, queue } = harness;
  const managers = mode === "destroyed-managers" || mode.includes("delete-") ? [structureManager(a), structureManager(b)] : [];
  const trace = mode === "lazy" ? "T11 fully deleted" : `T11 root ${mode}`;
  let checks = 0;
  try {
    queue.history.push(`seed R1 abcd=s1..s4; root control ${mode}`);
    if (mode === "promote-before-comment") initializeSchemaRoots(b.doc, candidate);
    if (mode === "destroyed-managers") for (const manager of managers.splice(0)) manager.destroy();
    if (mode === "gc-off") { a.doc.gc = false; b.doc.gc = false; }
    queue.history.push("A comments C1 on original s2 s3");
    addComment(a, "C1", "R1", 1, 2, "Alice");
    queue.flush("D2");
    addReply(b, "r1", "C1", "Bob");
    queue.flush("D2");
    let deleter = b;
    if (mode.startsWith("late-delete")) deleter = harness.lateJoin(b, mode.endsWith("eager"));
    if (mode.startsWith("reload-delete")) {
      deleter = new SchemaReplica(candidate, 3, harness.identities, mode.endsWith("eager"));
      Y.applyUpdate(deleter.doc, Y.encodeStateAsUpdate(b.doc), "delivery");
      harness.replicas.push(deleter);
      queue.addReplica("C", deleter);
      queue.history.push("reload C from complete encoded state before deletion");
    }
    queue.history.push(`client${deleter.doc.clientID} deletes original s2 s3 in one transaction`);
    if (candidate === "A") {
      const root = deleter.doc.share.get("flow");
      const formatting = (root as { _hasFormatting?: boolean } | undefined)?._hasFormatting;
      queue.history.push(`before promotion: ${root?.constructor.name}, _hasFormatting=${String(formatting)}`);
    }
    deleter.deleteIdentities(["s2", "s3"]);
    if (candidate === "A") {
      const root = deleter.doc.share.get("flow");
      queue.history.push(`after promotion/deletion: ${root?.constructor.name}, _hasFormatting=${String((root as { _hasFormatting?: boolean } | undefined)?._hasFormatting)}`);
    }
    queue.flush("D1");
    if (harness.replicas.length === 2) harness.lateJoin(b);
    const oracle = markOracles["T11 fully deleted"];
    if (!oracle) throw new Error("Missing literal fully-deleted oracle");
    for (const replica of harness.replicas) {
      const actual = readStructure(replica.doc, candidate, harness.identities);
      queue.history.push(`client${replica.doc.clientID} ${JSON.stringify(actual)}`);
    }
    for (const replica of harness.replicas) {
      checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "T11 fully deleted");
      checks++;
    }
    return { trace, candidate, order: "late-C", checks, failure: null, history: [...queue.history] };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return { trace, candidate, order: "late-C", checks, failure, history: [...queue.history, `FAIL ${failure}`] };
  } finally {
    for (const manager of managers) manager.destroy();
    harness.destroy();
  }
}
