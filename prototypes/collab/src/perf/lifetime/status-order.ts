import assert from "node:assert/strict";
import { compareCodeUnits } from "../../readers/order.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { createProjectionReplica, fromDocument } from "../../proj/document.ts";
import { isProjectionEntry } from "../../proj/entry.ts";
import { changeStatus, statusValue, undoStatus } from "../../marks/commands.ts";
import { structureManager } from "../../structure.ts";
import type { SchemaReplica } from "../../schema.ts";
import type { BeatStatusEvent } from "../../marks/status-resolution.ts";
import { readStatusEvent } from "../../marks/status-resolution.ts";

export const legacyReviewerStatusEvents = {
  a: { target: "R1", value: "ready", prior: "todo", parents: [] as string[] },
  c: { target: "R1", value: "shot", prior: "ready", parents: ["a"] },
  b: { target: "R1", value: "shot", prior: "todo", parents: [] as string[] },
  d: { target: "R1", value: "ready", prior: "shot", parents: ["b"] }
};

export const reviewerStatusEvents = {
  a: { ...legacyReviewerStatusEvents.a, by: "Alice" }, c: { ...legacyReviewerStatusEvents.c, by: "Alice" },
  b: { ...legacyReviewerStatusEvents.b, by: "Bob" }, d: { ...legacyReviewerStatusEvents.d, by: "Bob" }
};

function permutations(values: string[]): string[][] {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, at) => at !== index)).map(rest => [value, ...rest])) : [[]];
}

export function observeStatusOrder(order: readonly string[], recreate: boolean, clients: readonly [number, number] = [1, 2], read = statusValue,
  retired: readonly string[] = [], events: Readonly<Record<string, unknown>> = reviewerStatusEvents,
  shared: Readonly<Record<string, BeatStatusEvent>> = {}, undo: readonly number[] = []) {
  const seed = fromDocument({ title: "Status order", rows: [{ id: "R1", audioText: "abcd", visualText: "", status: "todo" }] }, "B", 100);
  const writers = clients.map(client => createProjectionReplica("B", client));
  const readers = [createProjectionReplica("B", 10), createProjectionReplica("B", 11), createProjectionReplica("B", 12)];
  const managers = writers.map(writer => structureManager(writer));
  const updates = new Map<string, Uint8Array>();
  const capture = (writer: SchemaReplica, key: string, edit: () => void): void => {
    const found: Uint8Array[] = [], listener = (update: Uint8Array): void => { found.push(update); };
    writer.doc.on("update", listener);
    try { edit(); } finally { writer.doc.off("update", listener); }
    assert.equal(found.length, 1); const update = found[0]; assert.ok(update); updates.set(key, update);
  };
  try {
    for (const [id, event] of Object.entries(shared)) seed.doc.getMap("statusEvents").set(id, structuredClone(event));
    const initial = Y.encodeStateAsUpdate(seed.doc);
    for (const replica of [...writers, ...readers.slice(0, 2)]) Y.applyUpdate(replica.doc, initial);
    for (const [index, keys] of [[0, ["a", "c"]], [1, ["b", "d"]]] as const) {
      const writer = writers[index]; assert.ok(writer);
      for (const key of keys) capture(writer, key, () => {
        if (undo.length) { const event = readStatusEvent(events[key]), manager = managers[index]; assert.ok(event && manager); changeStatus(writer, manager, "R1", key, event.value, `writer${index}`); }
        else writer.doc.transact(() => {
          writer.doc.getMap("statusEvents").set(key, structuredClone(events[key]));
          if (retired.includes(key)) writer.doc.getMap("retiredStatus").set(key, true);
        });
      });
    }
    const first = readers[0], second = readers[1], late = readers[2], alice = writers[0]; assert.ok(first && second && late && alice);
    for (const [reader, delivery] of [[first, order], [second, [...order].reverse()]] as const) for (const key of delivery) {
      const update = updates.get(key); assert.ok(update); Y.applyUpdate(reader.doc, update);
    }
    if (recreate) {
      capture(alice, "delete-c", () => alice.doc.getMap("statusEvents").delete("c"));
      capture(alice, "recreate-c", () => alice.doc.getMap("statusEvents").set("c", structuredClone(events.c)));
      for (const reader of [first, second]) for (const key of ["delete-c", "recreate-c"]) { const update = updates.get(key); assert.ok(update); Y.applyUpdate(reader.doc, update); }
    }
    if (undo.length) {
      for (const writer of writers) Y.applyUpdate(writer.doc, Y.encodeStateAsUpdate(first.doc));
      const retirements: Uint8Array[] = [];
      for (const index of undo) {
        const writer = writers[index], manager = managers[index]; assert.ok(writer && manager);
        const vector = Y.encodeStateVector(writer.doc);
        undoStatus(writer, manager);
        const update = Y.encodeStateAsUpdate(writer.doc, vector); retirements.push(update);
        for (const other of writers) Y.applyUpdate(other.doc, update);
      }
      for (const [reader, delivery] of [[first, retirements], [second, [...retirements].reverse()]] as const) {
        for (const update of delivery) { Y.applyUpdate(reader.doc, update); Y.applyUpdate(reader.doc, update); }
      }
    }
    const state = Y.encodeStateAsUpdate(first.doc), other = Y.encodeStateAsUpdate(second.doc);
    assert.deepEqual(state, other, "Delivery changed encoded converged state");
    assert.equal(late.doc.getMap("beats").size, 0); assert.equal(late.doc.getMap("statusEvents").size, 0);
    Y.applyUpdate(late.doc, state);
    assert.deepEqual(Y.encodeStateAsUpdate(late.doc), state, "Late join changed encoded state");
    const observations = readers.map((reader, index) => ({ replica: ["first", "reverse", "late"][index],
      keys: [...reader.doc.getMap("statusEvents").keys()], status: read(reader, "R1") }));
    return { clients: [...clients], delivery: [...order], reverseDelivery: [...order].reverse(), recreate, stateSha256: createHash("sha256").update(state).digest("hex"),
      identicalEncodedState: true, records: [...first.doc.getMap("statusEvents")].sort(([a], [b]) => compareCodeUnits(a, b)), observations,
      agrees: new Set(observations.map(row => row.status)).size === 1 };
  } finally { for (const manager of managers) manager.destroy(); for (const replica of [...writers, ...readers]) replica.destroy(); seed.destroy(); }
}

export function statusOrderEvidence(read = statusValue, events: Readonly<Record<string, unknown>> = reviewerStatusEvents) {
  const rows = [];
  for (const clients of [[1, 2], [2, 1]] as const) for (const recreate of [false, true]) for (const order of permutations(["a", "c", "b", "d"])) rows.push(observeStatusOrder(order, recreate, clients, read, [], events));
  return { events, rows, total: rows.length, disagreements: rows.filter(row => !row.agrees).length };
}

export function statusOrderHistory(evidence = JSON.parse(readFileSync(new URL("status-order.json", import.meta.url), "utf8")) as ReturnType<typeof statusOrderEvidence>): string {
  const examples = [false, true].map(recreate => {
    const row = evidence.rows.find(row => row.recreate === recreate && row.clients[0] === 1 && row.delivery.join() === "a,c,b,d");
    assert.ok(row); return row;
  });
  return ["# T21 scalar: replica-dependent status fallback", "",
    "Shows the unchanged legacy reader returning ready and shot for identical encoded state after different delivery orders, with and without deleting/recreating c.", "",
    "Input: one R1 beat with status todo; branch A writes a=ready/prior todo then c=shot/prior ready, parents=[a]; branch B writes b=shot/prior todo then d=ready/prior shot, parents=[b].",
    "First reader receives a,c,b,d; second receives d,b,c,a; third joins from the first reader's encoded state. Recreation deletes c then writes its unchanged value after delivery. No legacy status code is changed.", "",
    ...examples.flatMap(example => ["```json", JSON.stringify(example, null, 2), "```", ""]),
    `Matrix: ${evidence.total} runs (24 delivery permutations × two author-id assignments × with/without recreation); ${evidence.disagreements} runs disagree across the three readers despite byte-identical encoded state on the first two.`, "",
    "Yjs map key/value convergence does not make this observed iteration-based fallback replica-independent. This is a T21 scalar/status-design finding, not a performance-index repair. No replacement resolution policy is chosen here.", "",
    "Reproduce: node src/perf/lifetime/status-order.ts --write, from prototypes/collab. The generated JSON retains every order and observed key sequence.", ""].join("\n");
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--write")) {
  const evidence = statusOrderEvidence();
  assert.equal(evidence.disagreements, 0);
  process.stdout.write(`${evidence.disagreements}/${evidence.total} delivery cases disagree.\n`);
}
