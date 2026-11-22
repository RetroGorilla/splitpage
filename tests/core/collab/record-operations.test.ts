import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedRegistryOperations } from "../../../src/core/collab/record-operations.ts";

type Fields = Record<string, unknown>;
const ANN = { id: "p1", name: "Ann" }, BOB = { id: "p2", name: "Bob" };
const M = "t_1okou1ndmeusp";
const MUG = { id: M, cat: "prop", name: "Mug", owner: "", notes: "", status: "needed" };

test("the registry diff refuses lists it cannot state as record operations", () => {
  const edit = (before: Fields[], after: Fields[]) => sharedRegistryOperations({ before: { people: before, tags: [], shots: [] }, after: { people: after, tags: [], shots: [] },
    ranks: () => [], heads: () => [], author: { id: "w1_1", by: "Alice" } });
  assert.deepEqual(edit([ANN], [ANN, { name: "Cy" }]), { refused: "records-without-id" });
  assert.deepEqual(edit([ANN, ANN], [ANN]), { refused: "records-without-id" });
  assert.deepEqual(sharedRegistryOperations({ before: { people: [], tags: [null], shots: [] }, after: { people: [], tags: [], shots: [] },
    ranks: () => [], heads: () => [], author: { id: "w1_1", by: "Alice" } }), { refused: "records-without-id" });
});

test("the registry diff states a reorder by ranking the fewest records after the highest rank, in their new order", () => {
  const CY = { id: "p3", name: "Cy" }, DI = { id: "p4", name: "Di" };
  const edit = (before: Fields[], after: Fields[]) => sharedRegistryOperations({ before: { people: before, tags: [], shots: [] }, after: { people: after, tags: [], shots: [] },
    ranks: () => ["0000000000", "0000000001", "0000000002"], heads: () => [], author: { id: "w1_1", by: "Alice" } });
  const rank = (index: number, record: string, value: string) => ({ kind: "record-set", id: "w1_1:" + index, by: "Alice", target: { collection: "people", record }, field: "rank", value });
  assert.deepEqual(edit([ANN, BOB], [BOB, ANN]), { operations: [rank(0, "p1", "0000000003")] });
  assert.deepEqual(edit([ANN, BOB, CY], [CY, ANN, BOB]), { operations: [rank(0, "p1", "0000000003"), rank(1, "p2", "0000000004")] });
  assert.deepEqual(edit([ANN, BOB, CY], [ANN, CY, BOB]), { operations: [rank(0, "p2", "0000000003")] });
  assert.deepEqual(edit([ANN, BOB], [DI, ANN, BOB]), { operations: [
    { kind: "record-create", id: "w1_1:0", by: "Alice", target: { collection: "people", record: "p4" }, fields: { name: "Di", rank: "0000000003", extra: "{}" } },
    rank(1, "p1", "0000000004"), rank(2, "p2", "0000000005")] });
});

test("the registry diff clears a stored field the edit drops and sets one it changes", () => {
  assert.deepEqual(sharedRegistryOperations({ before: { people: [], tags: [{ ...MUG, notes: "chipped" }], shots: [] }, after: { people: [], tags: [{ id: M, cat: "prop", name: "Cup", owner: "", status: "needed" }], shots: [] },
    ranks: () => [], heads: () => [], author: { id: "w1_1", by: "Alice" } }), { operations: [
    { kind: "record-set", id: "w1_1:0", by: "Alice", target: { collection: "tags", record: M }, field: "name", value: "Cup" },
    { kind: "record-set", id: "w1_1:1", by: "Alice", target: { collection: "tags", record: M }, field: "notes", clear: true }] });
});

test("the registry diff ranks new records after the highest stored rank", () => {
  const added = (ranks: readonly string[]) => sharedRegistryOperations({ before: { people: [], tags: [], shots: [] },
    after: { people: [{ id: "p7", name: "Di", colour: "red" }, { id: "p8", name: "Ed" }], tags: [], shots: [] },
    ranks: () => ranks, heads: () => [], author: { id: "w1_1", by: "Alice" } });
  const person = (index: number, record: string, name: string, rank: string, extra: string) => ({ kind: "record-create", id: "w1_1:" + index, by: "Alice", target: { collection: "people", record }, fields: { name, rank, extra } });
  assert.deepEqual(added([]), { operations: [person(0, "p7", "Di", "0000000000", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "0000000001", "{}")] });
  assert.deepEqual(added(["0000000004", "0000000012", "0000000003"]), { operations: [person(0, "p7", "Di", "0000000013", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "0000000014", "{}")] });
  assert.deepEqual(added(["9999999999"]), { operations: [person(0, "p7", "Di", "9999999999V", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "9999999999VV", "{}")] });
  assert.deepEqual(added(["5"]), { operations: [person(0, "p7", "Di", "5V", "{\"colour\":\"red\"}"), person(1, "p8", "Ed", "5VV", "{}")] });
});

test("registry changes clear observed ownership, retain extra data and name the status parents", () => {
  const tag = { ...MUG, owner: "p1", custom: "initial" };
  const added = { id: "S1", name: "City", status: "unshot" };
  const next = { ...tag, owner: "", status: "ready", custom: "revised" };
  assert.deepEqual(sharedRegistryOperations({
    before: { people: [ANN, BOB], tags: [tag], shots: [] },
    after: { people: [ANN], tags: [next], shots: [added] },
    ranks: () => [],
    heads: (scope, id) => { assert.deepEqual([scope, id], ["tag", M]); return ["prior"]; },
    author: { id: "command", by: "Alice" }
  }), { operations: [
    { kind: "record-delete", id: "command:0", by: "Alice", target: { collection: "people", record: "p2" } },
    { kind: "record-set", id: "command:1", by: "Alice", target: { collection: "tags", record: M }, field: "owner", clear: true },
    { kind: "record-set", id: "command:2", by: "Alice", target: { collection: "tags", record: M }, field: "extra", value: '{"custom":"revised"}' },
    { kind: "status", id: "command:3", by: "Alice", target: { scope: "tag", record: M }, value: "ready", parents: ["prior"] },
    { kind: "record-create", id: "command:4", by: "Alice", target: { collection: "shots", record: "S1" },
      fields: { status: "unshot", name: "City", rank: "0000000000", extra: "{}" } }
  ] });
});
