import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedPeopleIntroducedByText } from "../../src/core/collab/text-records.ts";
import { readSharedRecords } from "../../src/adapters/collab/record-reader.ts";
import { bufferReaders } from "./buffer-readers.ts";
import { deliveryOrders } from "./delivery.ts";
import { agree, execute } from "../adapters/collab/executor-support.ts";
import { recordReplicas } from "../adapters/collab/record-support.ts";

const AUTHOR = { id: "Alice:1", by: "Alice" };
const WHO = (name: string) => '<span class="who-anchor" data-who="' + name + '" contenteditable="false">@' + name + "</span>";
const CHAIR = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Chair" contenteditable="false">Chair</span>';

function introduced(before: string, after: string, elsewhere = "", people: readonly { id: string; name: string }[] = []) {
  let serial = 0;
  const ids = { id: (prefix: string) => prefix + "_" + ++serial, docId: () => "d" };
  const state = { rows: [{ id: "R1", visualText: before }, { id: "R2", visualText: elsewhere }], productionTags: [], people };
  return sharedPeopleIntroducedByText({ rowId: "R1", before, after, state }, bufferReaders, ids, AUTHOR);
}

const person = (index: number, id: string, name: string) =>
  ({ kind: "record-create", id: "Alice:1:person:" + index, by: "Alice", target: { collection: "people", record: id }, fields: { name } });

test("an @Name new to the script gets one person, named as typed, with the id a normal script gives", () => {
  assert.deepEqual(introduced("", "Interview " + WHO("Sam")), [person(0, "p_1", "Sam")]);
  assert.deepEqual(introduced("Wide", "Wide on " + WHO("Sam") + " and " + WHO("Lee") + " then " + WHO("sam")),
    [person(0, "p_1", "Sam"), person(1, "p_2", "Lee")]);
});

test("a name a person already has, a name the script already held, and plain typing make no person", () => {
  assert.deepEqual(introduced("", "Interview " + WHO("kim"), "", [{ id: "p_kim", name: "Kim" }]), []);
  assert.deepEqual(introduced("", "Interview " + WHO("Lee"), "Wide on " + WHO("Lee")), []);
  assert.deepEqual(introduced(WHO("Sam"), WHO("Sam") + " again"), []);
  assert.deepEqual(introduced("Wide", "Wide shot"), []);
});

test("a pairing with a name the script already held makes no person here: that person comes with the owner rule", () => {
  assert.deepEqual(introduced("", CHAIR + " for " + WHO("Lee"), "Wide on " + WHO("Lee")), []);
  assert.deepEqual(introduced("", CHAIR + " for " + WHO("Sam")), [person(0, "p_1", "Sam")]);
});

test("the person a typed @Name introduces shows on every copy, as a normal script stores it", () => {
  const records = introduced("", "Interview " + WHO("Sam"));
  for (const order of deliveryOrders) {
    const run = recordReplicas();
    try {
      execute(run.a, ...records); run.queue.flush(order);
      agree("person from a typed @Name", order, [run.a, run.b], handle => readSharedRecords(handle, "people").find(record => record.key === "p_1")?.fields,
        { id: "p_1", name: "Sam" });
    } finally { run.close(); }
  }
});
