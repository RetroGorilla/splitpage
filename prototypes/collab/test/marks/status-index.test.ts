import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { changeStatus, statusValue } from "../../src/marks/commands.ts";
import { IndexedStructureProjection } from "../../src/perf/lifetime/projector.ts";
import { observeStatusOrder } from "../../src/perf/lifetime/status-order.ts";
import { fromDocument, createProjectionReplica } from "../../src/proj/document.ts";
import { mapValue } from "../../src/schema.ts";
import { structureManager } from "../../src/structure.ts";
import { readStructure } from "../../src/structure-reader.ts";
import { IdentityBook } from "../../src/model.ts";

test("a new event records literal todo prior on all replicas of the branched history", () => {
  const events: unknown[] = [];
  observeStatusOrder(["a", "c", "b", "d"], true, [2, 1], replica => {
    const manager = structureManager(replica);
    try {
      changeStatus(replica, manager, "R1", "next", "shot", "writer");
      events.push(replica.doc.getMap("statusEvents").get("next"));
      return statusValue(replica, "R1");
    } finally { manager.destroy(); }
  });
  assert.deepEqual(events, Array.from({ length: 3 }, () => ({ target: "R1", value: "shot", prior: "todo", parents: ["c", "d"], by: "writer" })));
});

test("status index updates only changed keys, handles reassignment and invalidates stored fallback", () => {
  const replica = fromDocument({ title: "", rows: ["R1", "R2"].map(id => ({ id, audioText: "", visualText: "", status: "todo" })) }, "B");
  const indexed = new IndexedStructureProjection(replica), document = { rows: [{ id: "R1" }, { id: "R2" }] };
  const events = replica.doc.getMap("statusEvents");
  const statuses = () => indexed.view(document).groups.map(group => group.status);
  try {
    events.set("a", { by: "writer", target: "R1", value: "ready", prior: "todo", parents: [] });
    events.set("b", { by: "writer", target: "R1", value: "shot", prior: "todo", parents: [] });
    assert.deepEqual(statuses(), ["todo", "todo"]);
    mapValue(replica.doc.getMap("beats").get("R1")).set("status", "shot");
    assert.deepEqual(statuses(), ["shot", "todo"]);
    const before = indexed.statusRecordsRead;
    events.set("a", { by: "writer", target: "R2", value: "ready", prior: "todo", parents: [] });
    assert.equal(indexed.statusRecordsRead - before, 1);
    assert.deepEqual(statuses(), ["shot", "ready"]);
    events.delete("b"); assert.deepEqual(statuses(), ["shot", "ready"]);
  } finally { indexed.destroy(); replica.destroy(); }
});

test("resolved statuses reach removed beats and join-group ranking", () => {
  const replica = fromDocument({ title: "", rows: ["R1", "R2"].map(id => ({ id, audioText: "", visualText: "", status: "todo" })) }, "B");
  replica.doc.getMap("gallery").clear();
  try {
    replica.doc.getMap("statusEvents").set("a", { by: "writer", target: "R2", value: "shot", prior: "todo", parents: [] });
    replica.join("R2", "R1", "join");
    assert.equal(readStructure(replica.doc, "B", new IdentityBook()).rows[0]?.status, "shot");
    replica.doc.getMap("retiredJoins").set("join", true);
    replica.remove("R2", "remove", "Alice");
    assert.equal(readStructure(replica.doc, "B", new IdentityBook()).recovery[0]?.row.status, "shot");
  } finally { replica.destroy(); }
});

test("other-reader finding: concurrent removals choose replica-local recovery author", () => {
  const seed = fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, "B", 100);
  const [a, b, first, reverse, late] = [1, 2, 10, 11, 12].map(id => createProjectionReplica("B", id));
  assert.ok(a && b && first && reverse && late);
  try {
    const initial = Y.encodeStateAsUpdate(seed.doc);
    for (const replica of [a, b, first, reverse]) Y.applyUpdate(replica.doc, initial);
    a.remove("R1", "rA", "Alice"); b.remove("R1", "rB", "Bob");
    const alice = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(seed.doc)), bob = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(seed.doc));
    for (const update of [alice, bob]) Y.applyUpdate(first.doc, update);
    for (const update of [bob, alice]) Y.applyUpdate(reverse.doc, update);
    assert.deepEqual(Y.encodeStateAsUpdate(first.doc), Y.encodeStateAsUpdate(reverse.doc));
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(first.doc));
    assert.deepEqual([first, reverse, late].map(replica => readStructure(replica.doc, "B", new IdentityBook()).recovery[0]?.by), ["Alice", "Bob", "Bob"]);
  } finally { for (const replica of [seed, a, b, first, reverse, late]) replica.destroy(); }
});

test("other-reader finding: concurrent visual components concatenate in replica-local map order", () => {
  const seed = fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, "B", 100);
  seed.doc.getMap("visuals").clear();
  const [a, b, first, reverse, late] = [1, 2, 10, 11, 12].map(id => createProjectionReplica("B", id));
  assert.ok(a && b && first && reverse && late);
  try {
    const initial = Y.encodeStateAsUpdate(seed.doc);
    for (const replica of [a, b, first, reverse]) Y.applyUpdate(replica.doc, initial);
    for (const [replica, id, value] of [[a, "vA", "X"], [b, "vB", "Y"]] as const) replica.doc.transact(() => {
      const record = new Y.Map<unknown>(); replica.doc.getMap("visuals").set(id, record);
      record.set("beat", "R1"); const text = new Y.Text(); record.set("text", text); text.insert(0, value);
    });
    const alice = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(seed.doc)), bob = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(seed.doc));
    for (const update of [alice, bob]) Y.applyUpdate(first.doc, update);
    for (const update of [bob, alice]) Y.applyUpdate(reverse.doc, update);
    assert.deepEqual(Y.encodeStateAsUpdate(first.doc), Y.encodeStateAsUpdate(reverse.doc));
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(first.doc));
    const observations = [first, reverse, late].map(replica => {
      const book = new IdentityBook();
      for (const value of replica.doc.getMap("visuals").values()) {
        const text = mapValue(value).get("text"); assert.ok(text instanceof Y.Text);
        const identity = Y.createRelativePositionFromTypeIndex(text, 0).item; assert.ok(identity);
        book.bind(`visual-${identity.client}-${identity.clock}`, identity);
      }
      return readStructure(replica.doc, "B", book).rows[0]?.visualText;
    });
    assert.deepEqual(observations, ["X<br>Y", "Y<br>X", "Y<br>X"]);
  } finally { for (const replica of [seed, a, b, first, reverse, late]) replica.destroy(); }
});
