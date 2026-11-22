import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import type { SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import { agree } from "./executor-support.ts";
import { recordExamples, recordKey, recordReplicas } from "./record-support.ts";

const kinds: readonly SharedRecordCollection[] = ["comments", "replies", "people", "tags", "shots", "gallery", "visuals"];

test("seeded arbitrary values in every record root have total, wire-stable readers", () => {
  let checkpoints = 0, accepted = 0, refused = 0;
  for (const seed of [1414, 1416, 0x5eed, 0xfeed]) {
    const run = recordReplicas();
    let random = seed;
    try {
      for (const kind of kinds) for (let step = 0; step < 52; step++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const valid = new Y.Map<unknown>(Object.entries(recordExamples[kind]));
        const broken = new Y.Map<unknown>([["id", recordKey(kind)], ["name", random % 2 ? [] : null], ["beat", {}], ["author", 2]]);
        const inherited = Object.create({ author: "inherited" }) as Record<string, unknown>;
        inherited.createdAt = 0;
        const accessor = Object.defineProperty({ id: "P1" }, "name", { get: () => "Alice", enumerable: true });
        const options: unknown[] = [undefined, null, true, false, 0, NaN, Infinity, 3n, "\ud800", "é", "é", [], new Array(2),
          Object.assign(new Array(3), { 0: "x", 2: "y" }), {}, { id: "P1", name: "Alice", zFuture: 1, aFuture: 2 }, inherited, accessor, new Date(0),
          new Uint8Array([1]), new Uint16Array([1]), new ArrayBuffer(2), Symbol("x"), () => 1, Object.create(null),
          new Y.Text("text"), new Y.Map(), valid, broken];
        const value = options[step < options.length ? step : random % options.length];
        try {
          transactSharedDocument(run.a, "remote", () => collabState(run.a).roots[kind].set(recordKey(kind), value)); accepted++;
        } catch { refused++; }
        agree(`malformed ${seed}/${kind}/${step}`, "rev", [run.a], handle => Object.fromEntries(kinds.map(kind => [kind, readSharedRecords(handle, kind)])));
        checkpoints++;
        if (step % 4 === 3) {
          transactSharedDocument(run.a, "remote", () => collabState(run.a).roots[kind].delete(recordKey(kind)));
          agree("malformed deletion", "dup", [run.a], handle => readSharedRecords(handle, kind)); checkpoints++;
        }
      }
    } finally { run.close(); }
  }
  assert.equal(checkpoints, 1820); assert.equal(accepted + refused, 1456); assert.ok(accepted > 0); assert.ok(refused > 0);
});

test("unstable stored keys are absent while stable unknown fields retain code-unit order", () => {
  const run = recordReplicas();
  try {
    for (const kind of kinds) {
      transactSharedDocument(run.a, "remote", () => {
        for (const key of ["\ud800", "\udc00", "\ufffd", "é", "é"]) {
          const fields: Record<string, unknown> = { ...recordExamples[kind], id: key, zFuture: { z: 1, a: 2 }, aFuture: [1, 2] };
          collabState(run.a).roots[kind].set(key, new Y.Map(Object.entries(fields).reverse()));
        }
      });
      agree(`identity ${kind}`, "rev", [run.a], handle => readSharedRecords(handle, kind));
    }
    agree("unstable keys are absent", "rev", [run.a], handle => readSharedRecords(handle, "people"),
      [{ key: "e\u0301", fields: { id: "e\u0301", name: "Alice", aFuture: [1, 2], zFuture: { a: 2, z: 1 } } },
        { key: "\u00e9", fields: { id: "\u00e9", name: "Alice", aFuture: [1, 2], zFuture: { a: 2, z: 1 } } }]);
  } finally { run.close(); }
});
