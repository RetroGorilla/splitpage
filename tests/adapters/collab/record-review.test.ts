import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedStatus, readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { encodeSharedState, encodeSharedStateVector, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { agree, execute, operation, ref } from "./executor-support.ts";
import { storedValue } from "./helpers.ts";
import { createRecord, setRecord, deleteRecord, recordReplicas } from "./record-support.ts";

for (const type of ["array", "text"] as const) for (const action of ["change", "remove"] as const) test(`stored shared ${type} hides a person and refuses ${action} without writes`, () => {
  const run = recordReplicas();
  try {
    execute(run.a, createRecord("people", "person", { name: "Alice", future: [1, 2] })); run.queue.flush("D1");
    agree("plain JSON remains editable", "D1", [run.a, run.b], handle => readSharedRecords(handle, "people").map(record => record.fields),
      [{ id: "person", name: "Alice", future: [1, 2] }]);
    execute(run.a, setRecord("people", "person", "name", "Alicia"), deleteRecord("people", "person"),
      createRecord("people", "person", { name: "Alice", future: [1, 2] })); run.queue.flush("D1");
    transactSharedDocument(run.a, "local-command", () => {
      const value = type === "array" ? new Y.Array<number>() : new Y.Text("opaque");
      if (value instanceof Y.Array) value.push([1, 2]);
      (collabState(run.a).roots.people.get("person") as Y.Map<unknown>).set("future", value);
    }); run.queue.flush("D1");
    agree("shared field is invalid JSON storage", "D1", [run.a, run.b], handle => readSharedRecords(handle, "people"), []);
    for (const handle of [run.a, run.b]) {
      const before = encodeSharedState(handle), vector = encodeSharedStateVector(handle);
      const command = operation(action === "change" ? setRecord("people", "person", "name", "Alicia") : deleteRecord("people", "person"));
      assert.deepEqual(executeSharedOperations(handle, [command]), { ok: false, index: 0, operation: command, reason: "missing-or-invalid-record" });
      assert.deepEqual(encodeSharedState(handle), before); assert.deepEqual(encodeSharedStateVector(handle), vector);
    }
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`reconciling links preserves hidden identities and refuses a hidden target ${order}`, () => {
  const run = recordReplicas();
  try {
    const key = "u:https://bad\ufffd.test";
    transactSharedDocument(run.a, "local-command", () => {
      const slot = collabState(run.a).roots.gallery.get("R1:slot:0") as Y.Map<unknown>, links = slot.get("links") as Y.Map<unknown>;
      links.set(key, new Y.Map<unknown>([["href", "https://bad\ufffd.test"], ["rank", "0"]]));
      links.set("u:https://hidden.test", new Y.Map<unknown>([["href", "https://hidden.test"], ["rank", 3]]));
    }); run.queue.flush(order);
    const originals = [run.a, run.b].map(handle => {
      const links = (collabState(handle).roots.gallery.get("R1:slot:0") as Y.Map<unknown>).get("links") as Y.Map<unknown>;
      const hidden = links.get(key) as Y.Map<unknown>, bytes = new TextEncoder().encode(JSON.stringify(storedValue(hidden)));
      let changes = 0; hidden.observeDeep(() => { changes++; });
      return { links, hidden, bytes, changes: () => changes };
    });
    execute(run.a, setRecord("gallery", "R1:slot:0", "links", [{ href: "https://visible.test" }])); run.queue.flush(order);
    for (const original of originals) {
      assert.equal(original.links.get(key), original.hidden); assert.equal(original.changes(), 0);
      assert.deepEqual(new TextEncoder().encode(JSON.stringify(storedValue(original.links.get(key)))), original.bytes);
      assert.ok(original.links.has("u:https://hidden.test"));
    }
    agree("hidden identity bytes survive sync and reload", order, [run.a, run.b], handle => {
      const links = (collabState(handle).roots.gallery.get("R1:slot:0") as Y.Map<unknown>).get("links") as Y.Map<unknown>;
      return storedValue(links.get(key));
    }, { href: "https://bad\ufffd.test", rank: "0" });
    agree("only visible links are read", order, [run.a, run.b], handle => readSharedRecords(handle, "gallery")[0]?.fields.links,
      [{ key: "u:https://visible.test", fields: { href: "https://visible.test", rank: "0000000000", extra: "{}" } }]);
    for (const handle of [run.a, run.b]) {
      const before = encodeSharedState(handle), command = operation(setRecord("gallery", "R1:slot:0", "links", [{ href: "https://hidden.test" }]));
      const result = executeSharedOperations(handle, [command]); assert.ok(!result.ok); assert.equal(result.reason, "invalid-record-field");
      assert.deepEqual(encodeSharedState(handle), before);
    }
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`recreated tag and shot identities keep their status events ${order}`, () => {
  const run = recordReplicas();
  try {
    const tag = { scope: "tag" as const, record: ref("t_1") }, shot = { scope: "shot" as const, record: ref("S1") };
    execute(run.a, { kind: "status", id: "tag-event", by: "Alice", target: tag, value: "have", parents: [] },
      { kind: "status", id: "shot-event", by: "Alice", target: shot, value: "shot", parents: [] }); run.queue.flush(order);
    const heads = [['["1","tag-event"]'], ['["1","shot-event"]']];
    agree("authored event identities", order, [run.a, run.b], handle => [readSharedStatusHeads(handle, tag), readSharedStatusHeads(handle, shot)], heads);
    execute(run.a, deleteRecord("tags", "t_1"), deleteRecord("shots", "S1")); run.queue.flush(order);
    execute(run.b, createRecord("tags", "t_1", { cat: "prop", name: "Recreated", status: "needed" }, "Bob"),
      createRecord("shots", "S1", { name: "Recreated", status: "unshot", origin: "list" }, "Bob")); run.queue.flush(order);
    agree("recreated statuses", order, [run.a, run.b], handle => [readSharedStatus(handle, tag), readSharedStatus(handle, shot)], ["have", "shot"]);
    agree("retained event identities", order, [run.a, run.b], handle => [readSharedStatusHeads(handle, tag), readSharedStatusHeads(handle, shot)], heads);
    assert.equal(collabState(run.a).roots.statusEvents.size, 2);
  } finally { run.close(); }
});
