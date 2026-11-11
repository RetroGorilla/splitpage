import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryOrders } from "../../collab/delivery.ts";
import { agree, execute, ref, replicas } from "./executor-support.ts";
import { recordReplicas, createRecord, setRecord, deleteRecord } from "./record-support.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedDocumentFieldProjection as projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import type { SharedRecordCollection } from "../../../src/core/collab/operations.ts";

for (const writers of [2, 3]) for (const order of deliveryOrders) test(`projection seeded scalar/status/all-record checkpoints: ${writers} writers ${order}`, () => {
  let random = 0x6a1414, checkpoints = 0, commands = 0, expectedLength = 0;
  const run = recordReplicas(writers), handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])];
  const kinds: readonly SharedRecordCollection[] = ["comments", "replies", "people", "tags", "shots", "gallery", "visuals"];
  const covered = new Set<string>();
  const submit = (handle: typeof run.a, ...values: unknown[]) => { execute(handle, ...values); commands += values.length; if (order === "D2") run.queue.flush(order); };
  const checkpoint = () => {
    run.queue.flush(order); agree("projection checkpoint " + checkpoints++, order, handles, projectSharedDocument);
    for (const handle of handles) {
      const row = (projectSharedDocument(handle).document.rows as Record<string, unknown>[])[0]; assert.ok(row);
      assert.equal(row.lengthSeconds, expectedLength);
      assert.equal(row.status, order === "D2" || order === "D3" ? writers === 2 ? "shot" : "ready" : "todo");
    }
  };
  try {
    for (let round = 0; round < 3; round++) {
      const created: { writer: number; kind: SharedRecordCollection; key: string; by: string; name: string }[] = [];
      handles.forEach((handle, writer) => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const by = `Writer${writer}`, suffix = `${round}-${writer}`, name = `Name${random}`, comment = `C${suffix}`;
        for (const kind of kinds) {
          const key = kind === "replies" ? JSON.stringify([comment, `RP${suffix}`]) : `${kind === "comments" ? "C" : kind}${suffix}`;
          const fields = kind === "comments" ? { rowId: "R1", field: "audioText", createdAt: round, text: name }
            : kind === "replies" ? { id: `RP${suffix}`, commentId: comment, createdAt: round, text: name }
            : kind === "people" ? { name } : kind === "tags" ? { cat: "prop", name } : kind === "shots" ? { name }
            : kind === "gallery" ? { beat: "R1", rank: suffix, picture: {}, links: [] } : { beat: "R1", rank: suffix };
          submit(handle, createRecord(kind, key, fields, by)); covered.add(kind); created.push({ writer, kind, key, by, name });
        }
        expectedLength = random % 100;
        submit(handle, { kind: "scalar", id: `length${suffix}`, by, target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: expectedLength },
          { kind: "status", id: `status${suffix}`, by, target: { scope: "beat", record: "R1" }, value: writer % 2 ? "shot" : "ready", parents: readSharedStatusHeads(handle, { scope: "beat", record: ref("R1") }) });
        if (order === "D3") run.queue.flush(order);
      }); checkpoint();
      for (const entry of created) {
        const field = entry.kind === "comments" || entry.kind === "replies" ? "text" : entry.kind === "gallery" || entry.kind === "visuals" ? "rank" : "name";
        const handle = handles[entry.writer]; assert.ok(handle); submit(handle, setRecord(entry.kind, entry.key, field, "updated" + entry.name, entry.by));
      } checkpoint();
      for (const entry of created) { const handle = handles[entry.writer]; assert.ok(handle); submit(handle, deleteRecord(entry.kind, entry.key, entry.by)); }
      checkpoint();
    }
    assert.equal(checkpoints, 9); assert.equal(commands, writers * 69); assert.deepEqual([...covered].sort(), [...kinds].sort());
  } finally { run.close(); }
});

function permutations(values: readonly string[]): string[][] {
  return values.length ? values.flatMap((value, index) => permutations(values.filter((_, position) => position !== index)).map(rest => [value, ...rest])) : [[]];
}
test("projection T21 common-root fallback: all 96 delivery/client/recreation cases return literal todo", () => {
  let cases = 0;
  for (const clients of [[1, 2], [2, 1]]) for (const recreate of [false, true]) for (const order of permutations(["a", "c", "b", "d"])) {
    const run = replicas(), first = createMonitoredSharedDocument(), reverse = createMonitoredSharedDocument();
    const updates = new Map<string, Uint8Array>();
    try {
      for (const reader of [first, reverse]) assert.ok(applySharedUpdate(reader, encodeSharedState(run.a)).ok);
      [run.a, run.b].forEach((handle, index) => { const client = clients[index]; assert.ok(client); collabState(handle).doc.clientID = client; });
      for (const [handle, commands] of [[run.a, [["a", "ready", []], ["c", "shot", ["a"]]]], [run.b, [["b", "shot", []], ["d", "ready", ["b"]]]]] as const) {
        for (const [id, value, parents] of commands) {
          const listener = (update: Uint8Array) => { updates.set(id, update); };
          collabState(handle).doc.on("update", listener);
          try { execute(handle, { kind: "status", id, by: "Writer", target: { scope: "beat", record: "R1" }, value, parents }); }
          finally { collabState(handle).doc.off("update", listener); }
        }
      }
      for (const [reader, delivery] of [[first, order], [reverse, [...order].reverse()]] as const) for (const id of delivery) {
        const update = updates.get(id); assert.ok(update); assert.ok(applySharedUpdate(reader, update).ok); assert.ok(applySharedUpdate(reader, update).ok);
      }
      if (recreate) {
        const key = JSON.stringify([String(clients[0]), "c"]), root = collabState(run.a).roots.statusEvents, event = root.get(key);
        transactSharedDocument(run.a, "local-command", () => root.delete(key));
        for (const reader of [first, reverse]) assert.ok(applySharedUpdate(reader, encodeSharedState(run.a)).ok);
        transactSharedDocument(run.a, "local-command", () => root.set(key, event));
        for (const reader of [first, reverse]) assert.ok(applySharedUpdate(reader, encodeSharedState(run.a)).ok);
      }
      assert.deepEqual(encodeSharedState(first), encodeSharedState(reverse));
      agree("96-case status projection", "rev", [first, reverse], projectSharedDocument);
      for (const reader of [first, reverse]) assert.equal((projectSharedDocument(reader).document.rows as Record<string, unknown>[])[0]?.status, "todo");
      cases++;
    } finally { run.close(); destroySharedDocument(first); destroySharedDocument(reverse); }
  }
  assert.equal(cases, 96);
});
