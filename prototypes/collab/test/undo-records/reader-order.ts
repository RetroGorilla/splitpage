import assert from "node:assert/strict";
import * as Y from "yjs";
import { ReplicaHarness } from "../../src/delivery.ts";
import type { DeliveryOrder } from "../../src/delivery.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";
import { perfStructureView } from "../../src/perf/operations.ts";
import { fromDocument, toDocument } from "../../src/proj/document.ts";
import { readReplica } from "../../src/reader.ts";
import { identityEntries, wireIdentity } from "../../src/readers/identity.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { changeStatus, insertText, removeBeat } from "../../src/undo-records/commands.ts";
import { CommandHistory } from "../../src/undo-records/history.ts";
import { projectionDifference } from "../strict-comparison.ts";
import type { CaseResult } from "./cases.ts";

function readerRemovalCase(name: string, order: DeliveryOrder, swapped: boolean, run: (h: ReplicaHarness, commands: CommandHistory[], history: string[]) => number): CaseResult {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "" }, { id: "R2", text: "" }], swapped), history: string[] = [];
  try {
    const checks = run(h, [new CommandHistory(h.alice), new CommandHistory(h.bob)], history);
    return { name, failure: null, history: [...history, ...h.queue.history], checks };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return { name, failure, history: [...history, ...h.queue.history, `FAIL ${failure}`], checks: 0 };
  } finally { h.destroy(); }
}

export function runReaderRemovals(order: DeliveryOrder, swapped: boolean, ids: readonly [string, string], first: number, early: boolean): CaseResult {
  return readerRemovalCase(`all removers and either undo: ${order}, ids ${ids}, swapped ${swapped}, first ${first}, early ${early}`, order, swapped, (h, commands, history) => {
    let checks = 0;
    const check = (expected: { rows: string[]; recovery: { id: string; by: string; edited: string[] }[] }): void => {
      h.queue.flush(order);
      if (h.replicas.length === 2) h.lateJoin(h.alice);
      history.push(`check ${JSON.stringify(expected)}`);
      for (const read of [readStructure, readReplica]) {
        const reference = read(h.alice.doc, "B", h.identities);
        for (const replica of h.replicas) {
          const model = read(replica.doc, "B", h.identities);
          assert.equal(projectionDifference(reference, model, "removal full output"), null);
          assert.deepEqual({ rows: model.rows.map(row => row.id), recovery: model.recovery.map(entry => ({ id: entry.row.id, by: entry.by, edited: entry.edited })) }, expected);
          checks++;
        }
      }
      for (const replica of h.replicas) {
        const plain = toDocument(replica.doc, "B"), indexed = new IndexedStructureProjection(replica);
        try {
          assert.deepEqual(perfStructureView(replica, plain).recovery, expected.recovery.map(entry => entry.id));
          assert.deepEqual(indexed.view(plain).recovery, expected.recovery.map(entry => entry.id));
          checks += 2;
        } finally { indexed.destroy(); }
      }
    };
    const [alice, bob] = commands; assert.ok(alice && bob);
    removeBeat(alice, "R1", ids[0], "Alice"); removeBeat(bob, "R1", ids[1], "Bob");
    history.push("Alice and Bob concurrently remove R1");
    if (!early) check({ rows: ["R2"], recovery: [{ id: "R1", by: "Alice, Bob", edited: [] }] });
    const writer = commands[first], other = commands[1 - first]; assert.ok(writer && other);
    assert.equal(writer.undo().effective, true);
    check({ rows: ["R1", "R2"], recovery: [] });
    const before = Y.encodeStateAsUpdate(other.replica.doc), outcome = other.undo();
    assert.equal(outcome.effective, false); assert.equal(outcome.consumed, 1);
    assert.deepEqual(Y.encodeStateAsUpdate(other.replica.doc), before);
    assert.equal(other.undoStack.length, 0);
    check({ rows: ["R1", "R2"], recovery: [] });
    removeBeat(other, "R1", "later", "Later");
    check({ rows: ["R2"], recovery: [{ id: "R1", by: "Later", edited: [] }] });
    assert.equal(other.undo().effective, true);
    check({ rows: ["R1", "R2"], recovery: [] });
    return checks;
  });
}

export function runReaderRemovalConsumed(order: DeliveryOrder): CaseResult {
  return readerRemovalCase(`ineffective coalesced removal undo consumes only its own step: ${order}`, order, false, (h, commands, history) => {
    const [alice, bob] = commands; assert.ok(alice && bob);
    insertText(bob, "R2", 0, "Z", ["b1"]); h.queue.flush(order);
    removeBeat(alice, "R1", "a", "Alice"); removeBeat(bob, "R1", "b", "Bob"); h.queue.flush(order);
    alice.undo(); h.queue.flush(order);
    const before = Y.encodeStateAsUpdate(h.bob.doc), outcome = bob.undo();
    assert.equal(outcome.effective, false); assert.equal(outcome.consumed, 1);
    assert.deepEqual(Y.encodeStateAsUpdate(h.bob.doc), before); h.queue.flush(order); h.lateJoin(h.alice);
    history.push("Bob inserts Z into R2; concurrent removals of R1; Alice undoes; Bob consumes only his removal");
    for (const replica of h.replicas) assert.equal(readStructure(replica.doc, "B", h.identities).rows[1]?.characters.map(character => character.value).join(""), "Z");
    assert.equal(bob.undo().effective, true); h.queue.flush(order);
    history.push("Bob undoes his earlier insertion");
    for (const replica of h.replicas) assert.equal(readStructure(replica.doc, "B", h.identities).rows[1]?.characters.length, 0);
    return h.replicas.length * 2;
  });
}

export function runReaderIdentity(): CaseResult {
  const name = "Reader identity-writing commands store normalized keys and references", history: string[] = [];
  const source = fromDocument({ title: "", rows: [{ id: "\ud800", audioText: "ab", visualText: "v", status: "todo" }],
    people: [{ id: "\ud800", name: "Alice" }], productionTags: [{ id: "\ud800", name: "Tag" }], brollShots: [{ id: "\ud800", name: "Shot" }],
    comments: [{ id: "\ud800", rowId: "\ud800", replies: [{ id: "\ud801", body: "Reply" }] }] }, "B", 200);
  const commands = new CommandHistory(source);
  let checks = 0;
  try {
    source.split("\ud800", 1, "split\ud800", "boundary", "Alice");
    source.join("split\ud800", "\ud800", "join\ud800"); source.remove("\ud800", "remove\ud800", "Alice"); source.restore("\ud800", "remove\ud800");
    history.push("split, join, remove and restore with lone-surrogate identities");
    changeStatus(commands, "\ud800", "status\ud800", "ready", "Alice"); commands.undo();
    history.push("changeStatus(target=\\ud800, event=status\\ud800, value=ready), undo");
    const visit = (map: Y.Map<unknown>): void => {
      for (const [key, value] of map) {
        assert.equal(key, wireIdentity(key));
        checks++;
        if (value instanceof Y.Map) visit(value);
      }
    };
    for (const collection of ["comments", "replies", "people", "tags", "shots", "beats", "segments", "visuals", "gallery", "statusEvents", "retiredStatus", "removalRecords"]) {
      history.push(`visit ${collection}`);
      visit(source.doc.getMap(collection));
    }
    assert.deepEqual(identityEntries(source.doc.getMap("statusEvents")).map(([id]) => id), ["status\ufffd"]);
    return { name, failure: null, history, checks: checks + 1 };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return { name, failure, history: [...history, `FAIL ${failure}`], checks };
  } finally { source.destroy(); }
}
