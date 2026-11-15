import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBrollKeying, sharedBrollRepeats } from "../../../src/core/collab/broll-keying.ts";
import type { BrollState } from "../../../src/core/production/broll.ts";
import { bufferReaders } from "../../collab/buffer-readers.ts";

const AUTHOR = { id: "w1_1", by: "Alice" };
const KEY = (id: string, text = "B-roll:") => '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">' + text + "</span>";
const plain = (html: unknown): string => String(html ?? "").replace(/<[^>]*>/g, "");
const SHOT = { desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "Pour the coffee", location: "", props: [], origin: "script" };

function state(visualText: string, shots: BrollState["brollShots"] = []): BrollState {
  return { rows: [{ id: "R1", audioText: "Pour the coffee", visualText }, { id: "R2", audioText: "Drink", visualText: "B-roll: Elsewhere" }], brollShots: shots, productionTags: [] };
}

function keyed(visualText: string, shots: BrollState["brollShots"] = [], lineKey = (at: number): string | null => "bs_k1_" + at) {
  const left = { rowId: "R1", cell: bufferReaders.cellOf(visualText), state: state(visualText, shots) };
  return sharedBrollKeying(left, bufferReaders, plain, lineKey, AUTHOR);
}

interface KeyingRow { readonly name: string; readonly cell: string; readonly shots?: BrollState["brollShots"]; readonly keys: readonly string[]; readonly shotIds: readonly string[]; readonly kinds: readonly string[] }

const KEYING: readonly KeyingRow[] = [
  { name: "one typed line is keyed by its first character and gets a shot", cell: "B-roll: Close up", keys: ["bs_k1_0"], shotIds: ["bs_k1_0"],
    kinds: ["text-insert", "text-delete", "record-create"] },
  { name: "two lines in one cell are keyed in one list, each by its own first character", cell: "Wide<br>B-roll: Close up<br>b roll - Mug", keys: ["bs_k1_5", "bs_k1_22"],
    shotIds: ["bs_k1_5", "bs_k1_22"], kinds: ["text-insert", "text-delete", "text-insert", "text-delete", "record-create", "record-create"] },
  { name: "a line naming an unclaimed shot takes that shot's id and makes no shot", cell: "B-roll: Mug", shots: [{ id: "bs_mug", name: "Mug", origin: "list" }],
    keys: ["bs_mug"], shotIds: [], kinds: ["text-insert", "text-delete"] },
  { name: "a keyed line is left alone while an unkeyed one beside it is keyed", cell: KEY("bs_old") + " Old<br>B-roll: New", shots: [{ id: "bs_old", name: "Old", origin: "script" }],
    keys: ["bs_k1_6"], shotIds: ["bs_k1_6"], kinds: ["text-insert", "text-delete", "record-create"] }
];

for (const row of KEYING) test(`keying a left cell: ${row.name}`, () => {
  const result = keyed(row.cell, row.shots);
  assert.ok(result);
  assert.deepEqual({ keys: result.keys, shots: result.shots, kinds: result.operations.map(operation => operation.kind) },
    { keys: row.keys, shots: row.shotIds, kinds: row.kinds });
});

test("keying a left cell: the shot is seeded from the beat as a normal script seeds it, authored by the leaving copy", () => {
  const result = keyed("B-roll: Close up");
  assert.deepEqual(result?.operations.at(-1), { kind: "record-create", id: "w1_1:shot:0", by: "Alice", target: { collection: "shots", record: "bs_k1_0" },
    fields: { name: "Close up", ...SHOT } });
  assert.deepEqual(result?.operations.slice(0, 2), [
    { kind: "text-insert", id: "w1_1:0", by: "Alice", target: { owner: "R1", segment: "R1", field: "visualText" },
      at: { left: null, right: '["flow-base","R1","visualText",0,0]', affinity: "before" }, content: [{ value: { atom: "broll", id: "bs_k1_0", text: "B-roll:" }, marks: [] }] },
    { kind: "text-delete", id: "w1_1:1", by: "Alice", target: { owner: "R1", segment: "R1", field: "visualText" }, observed: ['["flow-base","R1","visualText",0,7]'] }]);
});

test("keying a left cell: nothing to key, or no line identity, writes nothing", () => {
  assert.equal(keyed("Wide shot"), null);
  assert.equal(keyed(""), null);
  assert.equal(keyed(KEY("bs_old") + " Old", [{ id: "bs_old", name: "Old" }]), null);
  assert.equal(keyed("B-roll: Close up", [], () => null), null);
});

interface RepeatRow { readonly name: string; readonly cell: string; readonly shots: readonly string[]; readonly deleted: readonly string[] }

const REPEAT = (original: string, client: number, clock: number) => "broll_" + [...original].map(ch => ch.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "_" + client + "_" + clock;

const REPEATS: readonly RepeatRow[] = [
  { name: "the later of two keys a line got at once is deleted", cell: KEY("bs_k1_0") + KEY(REPEAT("bs_k1_0", 2, 9)) + " Close up", shots: ["bs_k1_0"],
    deleted: ['["flow-base","R1","visualText",1,2]'] },
  { name: "three copies at once leave two later keys, both deleted", cell: KEY("bs_k1_0") + KEY(REPEAT("bs_k1_0", 2, 9)) + KEY(REPEAT("bs_k1_0", 3, 4)) + " Close up",
    shots: ["bs_k1_0"], deleted: ['["flow-base","R1","visualText",1,3]'] },
  { name: "a later adjacent key and its unheld shot are removed", cell: KEY("bs_k1_0") + KEY(REPEAT("bs_k1_0", 2, 9)) + " Close up",
    shots: ["bs_k1_0", REPEAT("bs_k1_0", 2, 9)], deleted: ['["flow-base","R1","visualText",1,2]', "record-delete"] },
  { name: "two real lines with equal text are not touched", cell: KEY("bs_a") + " Close up<br>" + KEY("bs_b") + " Close up", shots: ["bs_a", "bs_b"], deleted: [] },
  { name: "a repeat of the same id on a second line is not touched", cell: KEY("bs_k1_0") + " Close up<br>" + KEY(REPEAT("bs_k1_0", 2, 9)) + " Close up",
    shots: ["bs_k1_0"], deleted: [] },
  { name: "an adjacent key with a different id is removed", cell: KEY("bs_k1_0") + KEY("bs_other") + " Close up", shots: ["bs_k1_0"], deleted: ['["flow-base","R1","visualText",1,2]'] }
];

for (const row of REPEATS) test(`repeated keys: ${row.name}`, () => {
  const result = sharedBrollRepeats({ rowId: "R1", cell: bufferReaders.cellOf(row.cell) }, row.shots, AUTHOR);
  assert.deepEqual(result?.map(operation => operation.kind === "text-delete" ? operation.observed[0] : operation.kind) ?? [], row.deleted);
  if (result) assert.deepEqual(result.map(operation => [operation.id, operation.by]), row.deleted.map((kind, index) => [kind === "record-delete" ? "w1_1:drop-shot:" + index : "w1_1:repeat:" + index, "Alice"]));
});

test("nameless markers wait; a named existing key with no shot gets its record unless it was removed", () => {
  assert.equal(keyed("B-roll: "), null);
  assert.deepEqual(keyed(KEY("bs_missing") + " Close up")?.shots, ["bs_missing"]);
  const left = { rowId: "R1", cell: bufferReaders.cellOf(KEY("bs_missing") + " Close up"), state: state(KEY("bs_missing") + " Close up") };
  assert.equal(sharedBrollKeying(left, bufferReaders, plain, () => null, AUTHOR, () => true), null);
});

test("cleanup keeps a dropped key's shot while another line in the script holds its id", () => {
  const cell = bufferReaders.cellOf(KEY("bs_first") + KEY("bs_later") + " Close up");
  const other = bufferReaders.cellOf(KEY("bs_later") + " Elsewhere");
  const result = sharedBrollRepeats({ rowId: "R1", cell }, ["bs_first", "bs_later"], AUTHOR, [other]);
  assert.deepEqual(result?.map(operation => operation.kind), ["text-delete"]);
});
