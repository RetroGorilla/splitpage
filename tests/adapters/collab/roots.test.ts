import { createMonitoredNativeDocument, createLibraryControlNativeDocument } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { collabRootTypes, declareCollabRoots } from "../../../src/adapters/collab/roots.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";
import { DeliveryQueue } from "../../collab/delivery.ts";
import type { DeliveryReplica } from "../../collab/delivery.ts";
import { formattingLibraryControl } from "./formatting-controls.ts";

const expectedRoots = [
  ["segments", "map"],
  ["order", "array"],
  ["beats", "map"],
  ["visuals", "map"],
  ["gallery", "map"],
  ["comments", "map"],
  ["replies", "map"],
  ["people", "map"],
  ["tags", "map"],
  ["shots", "map"],
  ["meta", "map"],
  ["removalRecords", "map"],
  ["retiredJoins", "map"],
  ["statusEvents", "map"],
  ["retiredStatus", "map"],
  ["headings", "map"],
  ["discards", "map"],
  ["retiredDiscards", "map"]
] as const;

function assertDeclared(doc: Y.Doc): void {
  assert.deepEqual([...doc.share.keys()].sort(), expectedRoots.map(([name]) => name).sort());
  for (const [name, kind] of expectedRoots) {
    assert.ok(doc.share.get(name) instanceof (kind === "map" ? Y.Map : Y.Array), name);
  }
}

function deliveryReplica(doc: Y.Doc): DeliveryReplica<Uint8Array> {
  return {
    onLocalUpdate: listener => {
      const receive = (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void => {
        if (transaction.local) listener(update);
      };
      doc.on("update", receive);
      return () => doc.off("update", receive);
    },
    apply: update => Y.applyUpdate(doc, update, "delivery")
  };
}

function queue(): DeliveryQueue<Uint8Array> {
  return new DeliveryQueue(update => update.slice(), update => `${update.length} bytes`);
}

function seedRoots(doc: Y.Doc): void {
  for (const [name, kind] of expectedRoots) {
    if (kind === "array") doc.getArray<string>(name).push(["seg-R1"]);
    else doc.getMap<unknown>(name).set("probe", "value");
  }
}

test("the root table declares every named root with its literal candidate B type", () => {
  const doc = createMonitoredNativeDocument();
  try {
    const roots = declareCollabRoots(doc);
    assertDeclared(doc);
    assert.deepEqual(Object.keys(collabRootTypes).sort(), expectedRoots.map(([name]) => name).sort());
    assert.deepEqual(Object.keys(roots).sort(), Object.keys(collabRootTypes).sort());
    for (const [name, type] of Object.entries(collabRootTypes)) {
      assert.ok(doc.share.get(name) instanceof type, name);
      assert.equal(Reflect.get(roots, name), doc.share.get(name), name);
    }
  } finally { doc.destroy(); }
});

test("declaration is idempotent and emits no document update", () => {
  const doc = createMonitoredNativeDocument();
  let updates = 0;
  doc.on("update", () => { updates++; });
  try {
    const first = declareCollabRoots(doc);
    const second = declareCollabRoots(doc);
    for (const name of Object.keys(first)) assert.equal(Reflect.get(first, name), Reflect.get(second, name));
    assert.equal(updates, 0);
    assert.deepEqual(Y.encodeStateVector(doc), new Uint8Array([0]));
    assert.deepEqual(Y.encodeStateAsUpdate(doc), new Uint8Array([0, 0]));
  } finally { doc.destroy(); }
});

for (const [name, kind] of expectedRoots) for (const mode of ["fresh", "hydrated", "late joiner"] as const) {
  test(`${name} ${mode}: a wrong typed read before declaration prevents initialization`, () => {
    const doc = createMonitoredNativeDocument();
    const source = createMonitoredNativeDocument();
    const deliveries = queue();
    try {
      if (mode !== "fresh") seedRoots(source);
      if (mode === "hydrated") Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
      if (mode === "late joiner") {
        deliveries.addReplica("A", deliveryReplica(source));
        deliveries.lateJoin("C", deliveryReplica(doc), "A", Y.encodeStateAsUpdate(source));
      }
      if (kind === "map") doc.getArray(name);
      else doc.getMap(name);
      assert.throws(() => declareCollabRoots(doc), /already been defined with a different constructor/);
    } finally {
      deliveries.destroy();
      source.destroy();
      doc.destroy();
    }
  });
}

for (const mode of ["fresh", "hydrated", "late joiner"] as const) {
  test(`${mode}: declaring first fixes every root type before any read or update`, () => {
    const source = createMonitoredNativeDocument();
    const target = createMonitoredNativeDocument();
    const deliveries = queue();
    try {
      seedRoots(source);
      declareCollabRoots(target);
      assertDeclared(target);
      if (mode === "hydrated") Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
      if (mode === "late joiner") {
        deliveries.addReplica("A", deliveryReplica(source));
        deliveries.lateJoin("C", deliveryReplica(target), "A", Y.encodeStateAsUpdate(source));
        assert.deepEqual(deliveries.history, ["late-C full state from A"]);
      }
      assertDeclared(target);
      for (const [name, kind] of expectedRoots) {
        if (kind === "map") {
          assert.throws(() => target.getArray(name), /already been defined with a different constructor/);
          assert.deepEqual(target.getMap(name).toJSON(), mode === "fresh" ? {} : { probe: "value" });
        } else {
          assert.throws(() => target.getMap(name), /already been defined with a different constructor/);
          assert.deepEqual(target.getArray(name).toArray(), mode === "fresh" ? [] : ["seg-R1"]);
        }
      }
    } finally {
      deliveries.destroy();
      source.destroy();
      target.destroy();
    }
  });
}

function segmentText(doc: Y.Doc): Y.Text {
  const segment = doc.getMap("segments").get("seg-R1");
  assert.ok(segment instanceof Y.Map);
  const text: unknown = segment.get("text");
  assert.ok(text instanceof Y.Text);
  return text;
}

function readMarks(doc: Y.Doc): unknown {
  return {
    order: doc.getArray("order").toArray(),
    text: segmentText(doc).toDelta(),
    comment: doc.getMap("comments").get("C1"),
    reply: doc.getMap("replies").get("r1")
  };
}

for (const gc of [true, false]) for (const deleter of ["live", "late joiner", "reload"] as const) {
  test(formattingLibraryControl(`T11: ${deleter} deletes original commented bc, leaving ad unmarked (gc=${gc})`), () => {
    const readings: ReplicaReading<unknown>[] = [];
    for (const order of ["D1", "dup", "rev", "late-C"] as const) {
      const seed = createLibraryControlNativeDocument({ gc });
      const alice = createLibraryControlNativeDocument({ gc });
      const bob = createLibraryControlNativeDocument({ gc });
      const carol = createLibraryControlNativeDocument({ gc });
      const reloaded = createLibraryControlNativeDocument({ gc });
      const deliveries = queue();
      try {
        seed.clientID = 10;
        alice.clientID = 1;
        bob.clientID = 2;
        carol.clientID = 3;
        reloaded.clientID = 4;
        const roots = declareCollabRoots(seed);
        const segment = new Y.Map<unknown>();
        roots.segments.set("seg-R1", segment);
        segment.set("head", { b: "R1" });
        const text = new Y.Text();
        segment.set("text", text);
        text.insert(0, "abcd", {});
        roots.order.push(["seg-R1"]);
        for (const doc of [alice, bob, carol, reloaded]) {
          declareCollabRoots(doc);
          assertDeclared(doc);
        }
        for (const doc of [alice, bob]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
        deliveries.addReplica("A", deliveryReplica(alice));
        deliveries.addReplica("B", deliveryReplica(bob));
        segmentText(alice).format(1, 2, { "c:C1": true });
        alice.getMap("comments").set("C1", { author: "Alice", text: "", rowId: "R1", field: "audioText" });
        assert.equal(deliveries.pending.length, 2);
        deliveries.flush(order);
        bob.getMap("replies").set("r1", { commentId: "C1", author: "Bob", text: "" });
        deliveries.flush(order);
        if (deleter === "late joiner") {
          deliveries.lateJoin("C", deliveryReplica(carol), "B", Y.encodeStateAsUpdate(bob));
        } else if (deleter === "reload") {
          Y.applyUpdate(carol, Y.encodeStateAsUpdate(bob));
          deliveries.addReplica("C", deliveryReplica(carol));
        }
        segmentText(deleter === "live" ? bob : carol).delete(1, 2);
        deliveries.flush(order);
        if (deleter === "live") {
          deliveries.lateJoin("C", deliveryReplica(carol), "B", Y.encodeStateAsUpdate(bob));
        }
        Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(bob));
        const expected = {
          order: ["seg-R1"],
          text: [{ insert: "ad" }],
          comment: { author: "Alice", text: "", rowId: "R1", field: "audioText" },
          reply: { commentId: "C1", author: "Bob", text: "" }
        };
        for (const [replica, doc] of [["A", alice], ["B", bob], ["C", carol]] as const) {
          assertDeclared(doc);
          const output = readMarks(doc);
          assert.deepEqual(output, expected);
          readings.push({ order, replica, output });
        }
        assert.deepEqual(readMarks(reloaded), expected);
        assert.equal(deliveries.pending.length, 0);
      } finally {
        deliveries.destroy();
        for (const doc of [seed, alice, bob, carol, reloaded]) doc.destroy();
      }
    }
    assertReplicasAgree("T11 candidate B root initialization", readings);
  });
}
