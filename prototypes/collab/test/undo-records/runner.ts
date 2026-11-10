import assert from "node:assert/strict";
import * as Y from "yjs";
import { ReplicaHarness } from "../../src/delivery.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { checkModel } from "../../src/model.ts";
import type { ScriptOracle } from "../../src/model.ts";
import type { ReplicaCaretAnchor } from "../../src/reader.ts";
import { identityAt, mapValue } from "../../src/schema.ts";
import type { SchemaReplica, SeedBeat } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { structuralCaret } from "../../src/structure-selection.ts";
import { storedMarkNames } from "../../src/marks/projection.ts";
import { clearGlue, cutPaste, seedJoinMetadata, visualInsert } from "../../src/structure.ts";
import { addComment, addReply, captureRange, changeStatus, createHeadingRecord, formatRange, formatSelection, insertText, join, moveBeat, removeBeat, removeHeadingRecord, replaceRange, setScalar, split } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import type { UndoDefect, UndoOutcome } from "../../src/undo-records/history.ts";
import { markOracles } from "../marks/oracles.ts";
import { commentsOracle, commentsRemovedOracle, commentsReplyOracle, commentsRestoredOracle, joinBoldUndoOracle, joinOracle, joinUndoOracle, removedOracle, restorationOracle } from "../oracles.ts";
import { beatOracles } from "../structure-oracles.ts";

export interface RecordRunResult {
  trace: string;
  order: DeliveryOrder;
  swapped: boolean;
  checks: number;
  failure: string | null;
  history: string[];
}

const glueRewriteOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", { i: true }], ["s2", "b", {}]] }, { id: "R2", characters: [["s3", "c", {}], ["b1", "Z", {}], ["s4", "d", {}]] }], carets: {}, recovery: []
};
const topItemOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "Z", {}]], status: "shot" }], carets: {}, recovery: []
};

function fixture(trace: string): SeedBeat[] {
  if (trace === "T05 two splits" || trace === "T12") return [{ id: "R1", text: "abcd" }];
  if (trace === "T07") return [{ id: "R1", text: "" }, { id: "R2", text: "" }];
  if (trace === "T08 remove") return [{ id: "R0", text: "x" }, { id: "H1", kind: "heading", text: "In" }, { id: "R1", text: "ab" }];
  if (trace === "T08 create") return [{ id: "R1", text: "x" }, { id: "R2", text: "# Ab" }, { id: "R3", text: "cd" }];
  if (trace === "T08 race") return [{ id: "R1", text: "x" }, { id: "R2", text: "# Ab\nrest" }];
  if (trace === "T09") return [{ id: "R1", text: "abc" }, { id: "R2", text: "de" }, { id: "R3", text: "fgh" }];
  if (trace === "T09 header") return [{ id: "R1", text: "ab" }, { id: "H1", kind: "heading", text: "Cd" }, { id: "R2", text: "ef" }];
  if (trace === "MOVE cut-paste") return [{ id: "H1", kind: "heading", text: "A" }, { id: "R1", text: "ab" }, { id: "H2", kind: "heading", text: "B" }, { id: "R2", text: "cd" }];
  if (trace === "T11") return [{ id: "R1", text: "abcd" }, { id: "R2", text: "ef" }];
  if (trace.startsWith("T20")) return [{ id: "R1", text: "the red mug" }];
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
  const check = (phase: string, oracle: ScriptOracle | undefined, joinLate = true): void => {
    queue.flush(order);
    if (joinLate && order === "late-C" && harness.replicas.length === 2) harness.lateJoin(b);
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
    if (trace.startsWith("T20")) {
      a.doc.transact(() => { a.doc.getMap("tags").set("P", { kind: "Prop" }); a.doc.getMap("tags").set("S", { kind: "Sound" }); }, "fixture");
      queue.flush("D2");
    }
    switch (trace) {
      case "T05 two splits": {
        const original = { position: structuralCaret(a, "R1", 2, -1) };
        carets.set("A", split(ha, "R1", 2, "Ra", "a1", undefined, original));
        carets.set("B", split(hb, "R1", 2, "Rb", "b1"));
        check(trace, beatOracles[trace]);
        const undone = undo(ha, "Alice");
        if (!undone.selection) throw new Error("Split undo restored no caret");
        carets.set("A", undone.selection);
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
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
        remote(() => carets.set("B", { position: visualInsert(b, "V2", 1, "Q", "b1") }));
        join(ha, "R2", "R1", "jA");
        check(trace, beatOracles[trace]);
        undo(ha, "Alice");
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      case "T08 remove": {
        const original = structuralCaret(a, "H1", 0);
        remote(() => { insertText(hb, "H1", 2, "Z", ["b1"]); insertText(hb, "R1", 2, "Y", ["b2"]); });
        removeHeadingRecord(ha, "H1", "Rn", "R1");
        carets.set("A", { position: original });
        check(trace, beatOracles[trace]);
        undo(ha, "Alice");
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      case "T08 create": {
        a.doc.transact(() => mapValue(a.doc.getMap("beats").get("R2")).set("paragraphStart", true), "fixture");
        queue.flush("D2");
        const caret = { position: structuralCaret(a, "R3", 0) };
        remote(() => { insertText(hb, "R2", 4, "e", ["b1"]); insertText(hb, "R3", 0, "Q", ["b2"]); });
        createHeadingRecord(ha, "R2", "H2", 2, false, ["a1"]);
        carets.set("A", caret);
        check(trace, beatOracles[trace]);
        undo(ha, "Alice");
        carets.clear();
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      case "T08 race": {
        createHeadingRecord(ha, "R2", "Ha", 2, true, ["a1", "a2"]);
        createHeadingRecord(hb, "R2", "Hb", 2, true, ["b1", "b2"]);
        check(trace, beatOracles[trace]);
        break;
      }
      case "T09": {
        const capture = captureRange(ha, "R1", 1, "R3", 2);
        remote(() => { insertText(hb, "R1", 2, "W", ["b1"]); insertText(hb, "R2", 1, "X", ["b2"]); insertText(hb, "R3", 2, "Y", ["b3"]); });
        carets.set("A", replaceRange(ha, capture, "Z", ["a1"], "Alice"));
        check(trace, beatOracles[trace]);
        const undone = undo(ha, "Alice");
        if (!undone.selection) throw new Error("Range undo restored no selection");
        carets.set("A", undone.selection);
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      case "T09 header": {
        const capture = captureRange(ha, "R1", 1, "H1", 1);
        remote(() => insertText(hb, "H1", 2, "Q", ["b1"]));
        carets.set("A", replaceRange(ha, capture, "", [], "Alice"));
        check(trace, beatOracles[trace]);
        undo(ha, "Alice");
        carets.clear();
        check(`${trace} undo`, beatOracles[`${trace} undo`]);
        break;
      }
      case "MOVE cut-paste": {
        carets.set("A", { position: structuralCaret(a, "R1", 0), selectionEnd: structuralCaret(a, "R1", 2, -1) });
        const before = Y.encodeStateVector(a.doc);
        assert.equal(cutPaste(), false);
        assert.deepEqual(Y.encodeStateVector(a.doc), before);
        assert.equal(ha.undoStack.length, 0);
        check(trace, beatOracles[trace]);
        assert.equal(ha.undo().label, null);
        break;
      }
      case "T11": {
        addComment(ha, "C1", "R1", 1, 2, "Alice");
        addComment(hb, "C2", "R1", 2, 2, "Bob");
        check("T11 overlap", commentsOracle, false);
        addReply(hb, "r1", "C1", "Bob");
        check("T11 reply", commentsReplyOracle, false);
        carets.set("A", { position: structuralCaret(a, "R1", 0) });
        removeBeat(ha, "R1", "rA", "Alice");
        carets.set("B", split(hb, "R1", 2, "Rb", "b1", "Bob"));
        check("T11 removed/split", commentsRemovedOracle);
        undo(ha, "Alice");
        check("T11 restored", commentsRestoredOracle);
        break;
      }
      case "T20 nest":
      case "T20 cross": {
        formatRange(ha, "R1", 4, 11, { "t:oA": "P" });
        const [from, to] = trace === "T20 nest" ? [8, 11] : [0, 7];
        formatRange(hb, "R1", from, to, { "t:oB": "S" });
        check(trace, markOracles[trace]);
        undo(trace === "T20 nest" ? ha : hb, trace === "T20 nest" ? "Alice" : "Bob");
        check(`${trace} undo`, markOracles[`${trace} undo`]);
        break;
      }
      case "T20 mark": {
        formatRange(hb, "R1", 8, 11, { "c:C1": true });
        formatRange(hb, "R1", 4, 7, { "l:L1": "http://x" });
        if (order === "D3") queue.deliverFrom("B", order);
        formatRange(ha, "R1", 4, 11, { "t:oA": "P" });
        check(trace, markOracles[trace]);
        for (const replica of harness.replicas) {
          const raw = replica.characters().map(character => ({ ...character, notation: harness.identities.notation(character.identity) }));
          assert.deepEqual(storedMarkNames("c:C1", raw), ["s9", "s10", "s11"]);
          assert.deepEqual(storedMarkNames("l:L1", raw), ["s5", "s6", "s7"]);
        }
        undo(hb, "Bob");
        check(`${trace} undo`, markOracles[`${trace} undo`]);
        break;
      }
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
