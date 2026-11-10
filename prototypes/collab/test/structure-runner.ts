import assert from "node:assert/strict";
import * as Y from "yjs";
import { ReplicaHarness } from "../src/delivery.ts";
import type { DeliveryOrder } from "../src/delivery.ts";
import { checkModel } from "../src/model.ts";
import type { ScriptOracle } from "../src/model.ts";
import type { ReplicaCaretAnchor } from "../src/reader.ts";
import { identityAt, mapValue, textValue } from "../src/schema.ts";
import type { SchemaCandidate, SchemaReplica, SeedBeat } from "../src/schema.ts";
import { readStructure } from "../src/structure-reader.ts";
import { clearGlue, createHeading, cutPaste, moveBeat, removeHeading, seedJoinMetadata, structureManager, undoJoin, undoOne, visualInsert } from "../src/structure.ts";
import { joinBoldUndoOracle, joinOracle, joinUndoOracle, removedOracle, restorationOracle } from "./oracles.ts";
import { beatOracles } from "./structure-oracles.ts";

export const structureTraces: Record<string, readonly DeliveryOrder[]> = {
  "T05 two splits": ["D1", "dup", "rev", "late-C"], T06: ["D1", "dup", "rev", "late-C"],
  T07: ["D1", "D3", "dup", "late-C"], "T08 remove": ["D1", "D3", "dup", "late-C"],
  "T08 create": ["D1", "D3", "dup", "late-C"], "T08 race": ["D1", "dup", "late-C"],
  T09: ["D1", "D3", "dup", "late-C"], "T09 header": ["D1", "D3"],
  T10: ["D1", "dup", "rev", "late-C"], T12: ["D2", "dup", "late-C"], "T12 join": ["D2"],
  "MOVE concurrent": ["D1", "dup", "late-C"], "MOVE destination": ["D1", "D3", "dup", "late-C"],
  "MOVE delete": ["D1", "late-C"], "MOVE cut-paste": ["D1"]
};

export interface StructureRunResult {
  trace: string;
  candidate: SchemaCandidate;
  order: DeliveryOrder;
  checks: number;
  failure: string | null;
  history: string[];
}

function fixture(trace: string): SeedBeat[] {
  if (trace === "T05 two splits" || trace === "T12") return [{ id: "R1", text: "abcd" }];
  if (trace === "T07") return [{ id: "R1", text: "" }, { id: "R2", text: "" }];
  if (trace === "T08 remove") return [{ id: "R0", text: "x" }, { id: "H1", kind: "heading", text: "In" }, { id: "R1", text: "ab" }];
  if (trace === "T08 create") return [{ id: "R1", text: "x" }, { id: "R2", text: "# Ab" }, { id: "R3", text: "cd" }];
  if (trace === "T08 race") return [{ id: "R1", text: "x" }, { id: "R2", text: "# Ab\nrest" }];
  if (trace === "T09") return [{ id: "R1", text: "abc" }, { id: "R2", text: "de" }, { id: "R3", text: "fgh" }];
  if (trace === "T09 header") return [{ id: "R1", text: "ab" }, { id: "H1", kind: "heading", text: "Cd" }, { id: "R2", text: "ef" }];
  if (trace === "MOVE cut-paste") return [{ id: "H1", kind: "heading", text: "A" }, { id: "R1", text: "ab" }, { id: "H2", kind: "heading", text: "B" }, { id: "R2", text: "cd" }];
  return [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }, ...(trace === "T10" || trace.startsWith("MOVE") ? [{ id: "R3", text: "ef" }] : [])];
}

export function structureCaret(replica: SchemaReplica, beat: string, offset: number, assoc = 0): Y.RelativePosition {
  const { text, start } = replica.locate(beat);
  return Y.createRelativePositionFromTypeIndex(text, start + offset, assoc);
}

export function runStructure(trace: string, candidate: SchemaCandidate, order: DeliveryOrder, nativeJoinUndo = false, swapped = false): StructureRunResult {
  const harness = new ReplicaHarness(candidate, fixture(trace), swapped);
  const { alice: a, bob: b, queue } = harness;
  const ua = structureManager(a);
  const ub = structureManager(b);
  const carets = new Map<string, ReplicaCaretAnchor>();
  let checks = 0;
  const check = (phase: string, explicit?: ScriptOracle): void => {
    queue.flush(order);
    if (order === "late-C" && harness.replicas.length === 2) harness.lateJoin(b);
    const oracle = explicit ?? beatOracles[phase];
    if (!oracle) throw new Error(`Missing literal oracle ${phase}`);
    queue.history.push(`check ${phase}`);
    for (const replica of harness.replicas) {
      checkModel(readStructure(replica.doc, candidate, harness.identities, carets), oracle, harness.identities, `${phase}/client${replica.doc.clientID}`);
      checks++;
    }
  };
  const remote = (action: () => void): void => {
    action();
    if (order === "D3") queue.deliverFrom("B", order);
  };
  try {
    queue.history.push(`fixture ${JSON.stringify(fixture(trace))}`);
    switch (trace) {
      case "T05 two splits": {
        a.split("R1", 2, "Ra", "a1");
        carets.set("A", { position: structureCaret(a, "Ra", 0, -1) });
        b.split("R1", 2, "Rb", "b1");
        carets.set("B", { position: structureCaret(b, "Rb", 0, -1) });
        check(trace);
        undoOne(ua);
        carets.set("A", { position: structureCaret(a, "R1", 2, -1) });
        check(`${trace} undo`);
        break;
      }
      case "T06": {
        seedJoinMetadata(a);
        queue.flush("D2");
        a.format("R1", 0, 2, { b: true });
        ua.stopCapturing();
        queue.flush("D2");
        carets.set("A", { position: structureCaret(a, "R2", 0) });
        carets.set("B", { position: structureCaret(b, "R2", 0) });
        a.join("R2", "R1", "jA");
        b.join("R2", "R1", "jB");
        check(trace, joinOracle);
        if (nativeJoinUndo) undoOne(ua);
        else undoJoin(a, ua, "R2", "R1");
        check("T06 Alice undo", joinUndoOracle);
        undoJoin(b, ub, "R2", "R1");
        check("T06 Bob undo consumed", joinUndoOracle);
        undoOne(ua);
        check("T06 bold undo", joinBoldUndoOracle);
        break;
      }
      case "T07": {
        a.doc.transact(() => {
          for (const [id, beat, value, names] of [["V1", "R1", "v", ["v1"]], ["V2", "R2", "wz", ["w1", "w2"]]] as const) {
            const component = new Y.Map<unknown>();
            a.doc.getMap("visuals").set(id, component);
            component.set("beat", beat);
            component.set("rank", "0");
            const text = new Y.Text();
            component.set("text", text);
            text.insert(0, value, {});
            names.forEach((name, index) => harness.identities.bind(name, identityAt(text, index)));
          }
        }, "fixture");
        queue.flush("D2");
        remote(() => visualInsert(b, "V2", 1, "Q", "b1"));
        const text = textValue(mapValue(b.doc.getMap("visuals").get("V2")).get("text"));
        carets.set("B", { position: Y.createRelativePositionFromTypeIndex(text, 2, -1) });
        a.join("R2", "R1", "jA");
        check(trace);
        undoJoin(a, ua, "R2", "R1");
        check(`${trace} undo`);
        break;
      }
      case "T08 remove": {
        const original = structureCaret(a, "H1", 0);
        const before = a.locate("H1");
        const boundary = before.start ? identityAt(before.text, before.start - 1) : null;
        remote(() => { b.insert("H1", 2, "Z", ["b1"]); b.insert("R1", 2, "Y", ["b2"]); });
        removeHeading(a, "H1", "Rn", "R1");
        carets.set("A", { position: original });
        check(trace);
        undoOne(ua);
        if (boundary) {
          const after = a.locate("H1");
          assert.notDeepEqual(identityAt(after.text, after.start - 1), boundary);
        }
        check(`${trace} undo`);
        break;
      }
      case "T08 create": {
        a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R2")).set("paragraphStart", true), "fixture");
        queue.flush("D2");
        const restores = a.captureUndoIdentities(["s2", "s3"]);
        const next = structureCaret(a, "R3", 0);
        remote(() => { b.insert("R2", 4, "e", ["b1"]); b.insert("R3", 0, "Q", ["b2"]); });
        createHeading(a, "R2", "H2", 2, false, ["a1"]);
        carets.set("A", { position: next });
        check(trace);
        undoOne(ua);
        a.bindUndoRestores(restores);
        carets.clear();
        check(`${trace} undo`);
        break;
      }
      case "T08 race": {
        createHeading(a, "R2", "Ha", 2, true, ["a1", "a2"]);
        createHeading(b, "R2", "Hb", 2, true, ["b1", "b2"]);
        check(trace);
        break;
      }
      case "T09": {
        const restores = a.captureUndoIdentities(["s2", "s3", "s6", "s7"]);
        const observed = a.characters().filter(character => character.beat === "R2").map(character => character.identity);
        remote(() => { b.insert("R1", 2, "W", ["b1"]); b.insert("R2", 1, "X", ["b2"]); b.insert("R3", 2, "Y", ["b3"]); });
        a.doc.transact(() => {
          a.remove("R2", "rA", "Alice", observed);
          a.insert("R1", 1, "Z", ["a1"]);
          a.deleteIdentities(["s2", "s3", "s6", "s7"]);
        }, a.localOrigin);
        carets.set("A", { position: structureCaret(a, "R1", 2, -1) });
        check(trace);
        undoOne(ua);
        a.bindUndoRestores(restores);
        carets.set("A", { position: structureCaret(a, "R1", 1), selectionEnd: structureCaret(a, "R3", 2, -1) });
        check(`${trace} undo`);
        break;
      }
      case "T09 header": {
        const restores = a.captureUndoIdentities(["s2", "s3"]);
        remote(() => b.insert("H1", 2, "Q", ["b1"]));
        a.deleteIdentities(["s2", "s3"]);
        carets.set("A", { position: structureCaret(a, "R1", 1, -1) });
        check(trace);
        undoOne(ua);
        a.bindUndoRestores(restores);
        carets.clear();
        check(`${trace} undo`);
        break;
      }
      case "T10": {
        const target = structureCaret(a, "R2", 0);
        carets.set("A", { position: target });
        a.remove("R2", "rA", "Alice");
        b.insert("R2", 1, "X", ["b1"]);
        check(trace, removedOracle);
        if (harness.replicas.length === 2) harness.lateJoin(b);
        check("T10 late recovery", removedOracle);
        undoOne(ua);
        check("T10 undo", restorationOracle);
        break;
      }
      case "T12": {
        const restore = structureCaret(a, "R1", 2);
        a.split("R1", 2, "Ra", "a1");
        const oldBoundary = harness.identities.identity("a1");
        queue.flush(order);
        b.insert("R1", 2, "Y", ["b1"]);
        b.insert("Ra", 0, "X", ["b2"]);
        queue.flush(order);
        if (order === "late-C") harness.lateJoin(b);
        undoOne(ua);
        carets.set("A", { position: restore });
        check("T12 undo");
        ua.redo();
        const redone = a.locate("Ra");
        assert.notDeepEqual(identityAt(redone.text, redone.start - 1), oldBoundary);
        carets.clear();
        check("T12 redo");
        break;
      }
      case "T12 join": {
        carets.set("A", { position: structureCaret(a, "R2", 0) });
        a.join("R2", "R1", "jA");
        queue.flush(order);
        b.insert("R2", 1, "Z", ["b1"]);
        carets.set("B", { position: structureCaret(b, "R2", 2, -1) });
        check(trace);
        undoJoin(a, ua, "R2", "R1");
        check(`${trace} undo`);
        break;
      }
      case "MOVE concurrent": {
        carets.set("A", { position: structureCaret(a, "R3", 0) });
        assert.equal(moveBeat(a, "R3", "R1"), candidate === "B");
        assert.equal(moveBeat(b, "R3", "R2"), candidate === "B");
        b.insert("R3", 1, "X", ["b1"]);
        carets.set("B", { position: structureCaret(b, "R3", 2, -1) });
        check(`${trace} ${candidate}`);
        if (candidate === "B") {
          undoOne(ua);
          check(`${trace} undo`);
        } else assert.equal(ua.undoStack.length, 0);
        break;
      }
      case "MOVE destination": {
        carets.set("A", { position: structureCaret(a, "R3", 0) });
        remote(() => { b.insert("R1", 0, "Y", ["b1"]); b.insert("R2", 2, "W", ["b2"]); });
        carets.set("B", { position: structureCaret(b, "R2", 3, -1) });
        assert.equal(moveBeat(a, "R3", "R1"), candidate === "B");
        check(`${trace} ${candidate}`);
        if (candidate === "B") {
          undoOne(ua);
          check(`${trace} A`);
        } else assert.equal(ua.undoStack.length, 0);
        break;
      }
      case "MOVE delete": {
        const aCaret = structureCaret(a, "R3", 0);
        const bCaret = structureCaret(b, "R3", 0);
        assert.equal(moveBeat(a, "R3", "R1"), candidate === "B");
        b.remove("R3", "rB", "Bob");
        if (candidate === "B") carets.set("A", { position: aCaret });
        check(candidate === "B" ? trace : `${trace} A`);
        undoOne(ub);
        if (candidate === "B") {
          carets.set("B", { position: bCaret });
          check(`${trace} undo`);
        } else {
          queue.flush(order);
          assert.equal(ua.undoStack.length, 0);
        }
        break;
      }
      case "MOVE cut-paste": {
        carets.set("A", { position: structureCaret(a, "R1", 0), selectionEnd: structureCaret(a, "R1", 2, -1) });
        const before = Y.encodeStateVector(a.doc);
        const cut = { consumed: false };
        if (cutPaste()) cut.consumed = true;
        assert.equal(cut.consumed, false);
        assert.deepEqual(Y.encodeStateVector(a.doc), before);
        assert.equal(ua.undoStack.length, 0);
        check(trace);
        break;
      }
      default: throw new Error(`Unknown structural trace ${trace}`);
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

export function runBeatExperiments(): StructureRunResult[] {
  return Object.entries(structureTraces).flatMap(([trace, orders]) => (["A", "B"] as const).flatMap(candidate => orders.map(order => runStructure(trace, candidate, order))));
}

export function runGlueRewrite(candidate: SchemaCandidate): StructureRunResult {
  const harness = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]);
  const manager = structureManager(harness.alice);
  try {
    harness.alice.format("R1", 0, 1, { i: true });
    manager.stopCapturing();
    harness.alice.join("R2", "R1", "jA");
    harness.queue.flush("D2");
    harness.bob.insert("R2", 1, "Z", ["b1"]);
    clearGlue(harness.bob, "R2");
    harness.queue.flush("D2");
    undoJoin(harness.alice, manager, "R2", "R1");
    harness.queue.flush("D2");
    const oracle: ScriptOracle = {
      rows: [{ id: "R1", characters: [["s1", "a", { i: true }], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["b1", "Z", {}], ["s4", "d", {}]] }], carets: {}, recovery: []
    };
    for (const replica of harness.replicas) checkModel(readStructure(replica.doc, candidate, harness.identities), oracle, harness.identities, "U-H1 glue rewrite");
    return { trace: "U-H1 glue rewrite", candidate, order: "D2", checks: 2, failure: null, history: [...harness.queue.history] };
  } finally {
    manager.destroy();
    harness.destroy();
  }
}
