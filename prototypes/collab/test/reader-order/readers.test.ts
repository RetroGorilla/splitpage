import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { DeliveryQueue, deliveryOrders, ReplicaHarness } from "../../src/delivery.ts";
import { IdentityBook } from "../../src/model.ts";
import { fromDocument, toDocument } from "../../src/proj/document.ts";
import { SchemaReplica, identityAt } from "../../src/schema.ts";
import type { SchemaCandidate } from "../../src/schema.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { readReplica } from "../../src/reader.ts";
import { structureManager, undoOne } from "../../src/structure.ts";
import { removeWithUndo, undoRemoval } from "../../src/readers/removal-commands.ts";
import { perfStructureView } from "../../src/perf/operations.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";
import { ReaderConvergence } from "../reader-convergence.ts";
import { legacyRemovalReader, legacyVisualReader } from "./legacy.ts";

function fixture(candidate: SchemaCandidate, swapped: boolean, reversed = false) {
  const identities = new IdentityBook(), order = reversed ? ["R2", "R1"] : ["R1", "R2"];
  const seed = fromDocument({ title: "", rows: order.map(id => ({ id, audioText: "", visualText: "", status: "todo" })) }, candidate, 200);
  seed.doc.getMap("gallery").clear(); seed.doc.getMap("visuals").clear();
  const alice = new SchemaReplica(candidate, swapped ? 2 : 1, identities), bob = new SchemaReplica(candidate, swapped ? 1 : 2, identities);
  for (const replica of [alice, bob]) Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(seed.doc), "seed");
  seed.destroy();
  const queue = new DeliveryQueue({ A: alice, B: bob }), replicas = [alice, bob];
  return { alice, bob, identities, queue, replicas, order,
    destroy() { queue.destroy(); for (const replica of replicas) replica.destroy(); } };
}

function permutations(values: number[]): number[][] {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, at) => at !== index)).map(rest => [value, ...rest])) : [[]];
}

const deliveries = permutations([0, 1, 2, 3]);
const visualCases = [
  { reversed: false, ids: ["a", "c", "b", "d"], expected: "Y<br>X<br>Z<br>W" },
  { reversed: true, ids: ["z", "x", "y", "w"], expected: "Z<br>W<br>Y<br>X" }
] as const;

for (const candidate of ["A", "B"] as const) for (const swapped of [false, true]) for (const data of visualCases) {
  test(`${candidate}: visuals follow beat then rank order, ids ${data.ids}, clients swapped ${swapped}: all 24 deliveries`, () => {
    for (const delivery of deliveries) {
      const h = fixture(candidate, swapped, data.reversed), guard = new ReaderConvergence(h, deliveryOrders);
      try {
        for (const [index, [replica, beat, rank, value]] of [[h.alice, "R1", "20", "X"], [h.alice, "R1", "10", "Y"], [h.bob, "R2", "20", "W"], [h.bob, "R2", "10", "Z"]].entries()) {
          assert.ok(replica instanceof SchemaReplica && typeof beat === "string" && typeof rank === "string" && typeof value === "string");
          const id = data.ids[index]; assert.ok(id);
          replica.doc.transact(() => {
            const component = new Y.Map<unknown>(); replica.doc.getMap("visuals").set(id, component);
            component.set("beat", beat); component.set("rank", rank); const text = new Y.Text(); component.set("text", text); text.insert(0, value);
            h.identities.bind(`v${index}`, identityAt(text, 0));
          });
        }
        const queued = [...h.queue.pending];
        for (const index of delivery) { const item = queued[index]; assert.ok(item); h.queue.deliver(item.id, 2); }
        h.alice.join(h.order[1] ?? "", h.order[0] ?? "", "join"); h.queue.flush("rev");
        guard.check("visuals full output");
        for (const replica of h.replicas) {
          const model = readStructure(replica.doc, candidate, h.identities);
          assert.equal(model.rows[0]?.visualText, data.expected);
          const plain = toDocument(replica.doc, candidate), indexed = new IndexedStructureProjection(replica);
          try {
            assert.equal(perfStructureView(replica, plain).groups[0]?.visual, data.expected);
            assert.equal(indexed.view(plain).groups[0]?.visual, data.expected);
          } finally { indexed.destroy(); }
        }
        assert.throws(() => guard.check("legacy visual control", new Map(), legacyVisualReader), /full output or no-throw check failed/);
      } finally { h.destroy(); }
    }
  });
}

for (const candidate of ["A", "B"] as const) for (const swapped of [false, true]) for (const ids of [["a", "b"], ["z", "a"]]) {
  for (const first of [0, 1]) for (const early of [false, true]) test(`${candidate}: all removers and either undo, ids ${ids}, swapped ${swapped}, first ${first}, early ${early}`, () => {
    const h = fixture(candidate, swapped), guard = new ReaderConvergence(h, deliveryOrders), managers = h.replicas.map(replica => structureManager(replica));
    const check = (expected: string | undefined): void => {
      h.queue.flush("rev"); guard.check("removal full output"); guard.check("earlier removal full output", new Map(), readReplica);
      for (const replica of h.replicas) {
        assert.equal(readStructure(replica.doc, candidate, h.identities).recovery[0]?.by, expected);
        assert.equal(readReplica(replica.doc, candidate, h.identities).recovery[0]?.by, expected);
        const plain = toDocument(replica.doc, candidate), indexed = new IndexedStructureProjection(replica);
        try {
          assert.deepEqual(perfStructureView(replica, plain).recovery, expected === undefined ? [] : ["R1"]);
          assert.deepEqual(indexed.view(plain).recovery, expected === undefined ? [] : ["R1"]);
        } finally { indexed.destroy(); }
      }
    };
    try {
      for (const [index, replica] of h.replicas.entries()) {
        const manager = managers[index], id = ids[index]; assert.ok(manager && id);
        removeWithUndo(replica, manager, "R1", id, index ? "Bob" : "Alice");
      }
      const writer = h.replicas[first], manager = managers[first], other = h.replicas[1 - first], otherManager = managers[1 - first];
      assert.ok(writer && manager && other && otherManager);
      if (!early) { check("Alice, Bob"); assert.throws(() => guard.check("legacy removal control", new Map(), legacyRemovalReader), /full output or no-throw check failed/); }
      undoRemoval(writer, manager); check(undefined);
      const before = Y.encodeStateAsUpdate(other.doc); undoRemoval(other, otherManager); assert.deepEqual(Y.encodeStateAsUpdate(other.doc), before); check(undefined);
      assert.equal(otherManager.undoStack.length, 0);
      removeWithUndo(other, otherManager, "R1", "later", "Later"); check("Later");
      undoRemoval(other, otherManager); check(undefined);
    } finally { for (const manager of managers) manager.destroy(); h.destroy(); }
  });
}

test("ineffective coalesced removal undo consumes only its own step", () => {
  const h = fixture("B", false), managers = h.replicas.map(replica => structureManager(replica));
  const ua = managers[0], ub = managers[1]; assert.ok(ua && ub);
  try {
    h.bob.insert("R2", 0, "Z", ["b1"]); h.queue.flush("D1"); ub.stopCapturing();
    removeWithUndo(h.alice, ua, "R1", "a", "Alice"); removeWithUndo(h.bob, ub, "R1", "b", "Bob"); h.queue.flush("D1");
    undoRemoval(h.alice, ua); h.queue.flush("D1"); undoRemoval(h.bob, ub); h.queue.flush("D1");
    assert.equal(readStructure(h.bob.doc, "B", h.identities).rows[1]?.characters.map(character => character.value).join(""), "Z");
    undoOne(ub); h.queue.flush("D1");
    assert.equal(readStructure(h.bob.doc, "B", h.identities).rows[1]?.characters.length, 0);
  } finally { for (const manager of managers) manager.destroy(); h.destroy(); }
});

test("a character unobserved by at least one applying remover remains an edited identity", () => {
  const h = fixture("B", false), guard = new ReaderConvergence(h, deliveryOrders);
  try {
    h.alice.insert("R1", 0, "abc", ["s1", "s2", "s3"]); h.queue.flush("D1");
    h.alice.remove("R1", "z", "Alice", [h.identities.identity("s1")]);
    h.bob.remove("R1", "a", "Bob", [h.identities.identity("s2")]); h.queue.flush("rev");
    guard.check("combined removal observations");
    for (const replica of h.replicas) {
      for (const read of [readStructure, readReplica]) {
        const recovery = read(replica.doc, "B", h.identities).recovery[0];
        assert.equal(recovery?.by, "Alice, Bob"); assert.deepEqual(recovery?.edited, ["s1", "s2", "s3"]);
      }
    }
  } finally { h.destroy(); }
});

for (const candidate of ["A", "B"] as const) test(`${candidate}: removing a joined group after observing all members keeps one recovery row`, () => {
  for (const order of deliveryOrders) {
    const h = new ReplicaHarness(candidate, [{ id: "R1", text: "ab" }, { id: "R2", text: "cd" }]), guard = new ReaderConvergence(h, deliveryOrders);
    try {
      h.alice.join("R2", "R1", "join");
      h.alice.remove("R1", "remove", "Alice", h.alice.characters().map(character => character.identity)); h.queue.flush(order); h.lateJoin(h.alice);
      guard.check("joined removal observes every member");
      for (const replica of h.replicas) {
        const model = readStructure(replica.doc, candidate, h.identities);
        assert.deepEqual(model.rows, []);
        assert.deepEqual(model.recovery.map(entry => [entry.row.id, entry.row.characters.map(character => character.value).join(""), entry.edited]), [["R1", "ab cd", []]]);
      }
    } finally { h.destroy(); }
  }
});
