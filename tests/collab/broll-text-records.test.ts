import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBrollIntroducedByText } from "../../src/core/collab/text-records.ts";
import type { BrollState } from "../../src/core/production/broll.ts";
import { readSharedRecords } from "../../src/adapters/collab/record-reader.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { bufferReaders } from "./buffer-readers.ts";
import { deliveryOrders } from "./delivery.ts";
import { agree, execute } from "../adapters/collab/executor-support.ts";
import { recordReplicas } from "../adapters/collab/record-support.ts";

const AUTHOR = { id: "Alice:1", by: "Alice" };
const KEY = (id: string) => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span>';
const plain = (html: unknown): string => String(html ?? "").replace(/<[^>]*>/g, "");

function state(visualText: string): BrollState {
  return { rows: [{ id: "R1", audioText: "Pour the coffee", visualText }, { id: "R2", audioText: "Drink", visualText: "" }],
    brollShots: [{ id: "bs_mug", name: "Mug", desc: "", status: "unshot", origin: "list" }], productionTags: [] };
}

function introduced(before: string, after: string) {
  let serial = 0;
  const ids = { id: (prefix: string) => prefix + "_" + ++serial, docId: () => "d" };
  const result = sharedBrollIntroducedByText({ rowId: "R1", before, after: bufferReaders.cellOf(after), state: state(before) }, bufferReaders, ids, plain, AUTHOR);
  return { html: toHtml(result.cell), keyed: result.keyed, records: result.records };
}

const SHOT = { name: "Close up", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "Pour the coffee", location: "", props: [], origin: "script" };

test("a B-roll line typed into a beat is keyed and gets a shot seeded from the beat, named by its key", () => {
  assert.deepEqual(introduced("", "B-roll: Close up"), { html: KEY("bs_1") + " Close up", keyed: 1, records: [
    { kind: "record-create", id: "Alice:1:shot:0", by: "Alice", target: { collection: "shots", record: "bs_1" }, fields: SHOT }] });
});

test("an unkeyed line naming a shot no line holds takes that shot's key and makes no shot", () => {
  assert.deepEqual(introduced("", "B-roll: Mug"), { html: KEY("bs_mug") + " Mug", keyed: 1, records: [] });
});

test("a pasted keyed line whose shot is missing gets that shot under its own key, and is not keyed again", () => {
  assert.deepEqual(introduced("", KEY("bs_paste") + " Close up"), { html: KEY("bs_paste") + " Close up", keyed: 0, records: [
    { kind: "record-create", id: "Alice:1:shot:0", by: "Alice", target: { collection: "shots", record: "bs_paste" }, fields: SHOT }] });
});

test("a keyed line the cell already held makes no shot, and plain typing makes nothing", () => {
  assert.deepEqual(introduced(KEY("bs_old") + " Close", KEY("bs_old") + " Close up"), { html: KEY("bs_old") + " Close up", keyed: 0, records: [] });
  assert.deepEqual(introduced("Wide", "Wide shot"), { html: "Wide shot", keyed: 0, records: [] });
});

test("the shot a typed line introduces shows on every copy, as a normal script stores it", () => {
  const { records } = introduced("", "B-roll: Close up");
  for (const order of deliveryOrders) {
    const run = recordReplicas();
    try {
      execute(run.a, ...records); run.queue.flush(order);
      agree("shot from a typed line", order, [run.a, run.b], handle => readSharedRecords(handle, "shots").find(record => record.key === "bs_1")?.fields,
        { id: "bs_1", name: "Close up", desc: "", status: "unshot", reshoot: false, notes: "", audioRef: "Pour the coffee", location: "", owner: "", origin: "script", props: [] });
    } finally { run.close(); }
  }
});
