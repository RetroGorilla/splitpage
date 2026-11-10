import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as Y from "yjs";
import { createProjectionReplica, fromDocument } from "../../proj/document.ts";
import { isProjectionEntry } from "../../proj/entry.ts";
import { statusValue } from "../../marks/commands.ts";
import type { SchemaReplica } from "../../schema.ts";

export const reviewerStatusEvents = {
  a: { target: "R1", value: "ready", prior: "todo", parents: [] as string[] },
  c: { target: "R1", value: "shot", prior: "ready", parents: ["a"] },
  b: { target: "R1", value: "shot", prior: "todo", parents: [] as string[] },
  d: { target: "R1", value: "ready", prior: "shot", parents: ["b"] }
};

function permutations(values: string[]): string[][] {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, at) => at !== index)).map(rest => [value, ...rest])) : [[]];
}

export function observeStatusOrder(order: readonly string[], recreate: boolean, clients: readonly [number, number] = [1, 2]) {
  const seed = fromDocument({ title: "Status order", rows: [{ id: "R1", audioText: "abcd", visualText: "", status: "todo" }] }, "B", 100);
  const writers = clients.map(client => createProjectionReplica("B", client));
  const readers = [createProjectionReplica("B", 10), createProjectionReplica("B", 11), createProjectionReplica("B", 12)];
  const updates = new Map<string, Uint8Array>();
  const capture = (writer: SchemaReplica, key: string, edit: () => void): void => {
    const found: Uint8Array[] = [], listener = (update: Uint8Array): void => { found.push(update); };
    writer.doc.on("update", listener);
    try { edit(); } finally { writer.doc.off("update", listener); }
    assert.equal(found.length, 1); const update = found[0]; assert.ok(update); updates.set(key, update);
  };
  try {
    const initial = Y.encodeStateAsUpdate(seed.doc);
    for (const replica of [...writers, ...readers.slice(0, 2)]) Y.applyUpdate(replica.doc, initial);
    for (const [index, keys] of [[0, ["a", "c"]], [1, ["b", "d"]]] as const) {
      const writer = writers[index]; assert.ok(writer);
      for (const key of keys) capture(writer, key, () => writer.doc.getMap("statusEvents").set(key, structuredClone(reviewerStatusEvents[key])));
    }
    const first = readers[0], second = readers[1], late = readers[2], alice = writers[0]; assert.ok(first && second && late && alice);
    for (const [reader, delivery] of [[first, order], [second, [...order].reverse()]] as const) for (const key of delivery) {
      const update = updates.get(key); assert.ok(update); Y.applyUpdate(reader.doc, update);
    }
    if (recreate) {
      capture(alice, "delete-c", () => alice.doc.getMap("statusEvents").delete("c"));
      capture(alice, "recreate-c", () => alice.doc.getMap("statusEvents").set("c", structuredClone(reviewerStatusEvents.c)));
      for (const reader of [first, second]) for (const key of ["delete-c", "recreate-c"]) { const update = updates.get(key); assert.ok(update); Y.applyUpdate(reader.doc, update); }
    }
    const state = Y.encodeStateAsUpdate(first.doc), other = Y.encodeStateAsUpdate(second.doc);
    assert.deepEqual(state, other, "Delivery changed encoded converged state");
    assert.equal(late.doc.getMap("beats").size, 0); assert.equal(late.doc.getMap("statusEvents").size, 0);
    Y.applyUpdate(late.doc, state);
    assert.deepEqual(Y.encodeStateAsUpdate(late.doc), state, "Late join changed encoded state");
    const observations = readers.map((reader, index) => ({ replica: ["first", "reverse", "late"][index],
      keys: [...reader.doc.getMap("statusEvents").keys()], status: statusValue(reader, "R1") }));
    return { clients: [...clients], delivery: [...order], reverseDelivery: [...order].reverse(), recreate, stateSha256: createHash("sha256").update(state).digest("hex"),
      identicalEncodedState: true, records: [...first.doc.getMap("statusEvents")].sort(([a], [b]) => a.localeCompare(b)), observations,
      agrees: new Set(observations.map(row => row.status)).size === 1 };
  } finally { for (const replica of [...writers, ...readers]) replica.destroy(); seed.destroy(); }
}

export function statusOrderEvidence() {
  const rows = [];
  for (const clients of [[1, 2], [2, 1]] as const) for (const recreate of [false, true]) for (const order of permutations(["a", "c", "b", "d"])) rows.push(observeStatusOrder(order, recreate, clients));
  return { events: reviewerStatusEvents, rows, total: rows.length, disagreements: rows.filter(row => !row.agrees).length };
}

export function statusOrderHistory(evidence = statusOrderEvidence()): string {
  const examples = [false, true].map(recreate => observeStatusOrder(["a", "c", "b", "d"], recreate));
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
  writeFileSync(new URL("status-order.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
  writeFileSync(new URL("../../../histories/T21-scalar-map-order.md", import.meta.url), statusOrderHistory(evidence));
  process.stdout.write(`${evidence.disagreements}/${evidence.total} delivery cases disagree.\n`);
}
