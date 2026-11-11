import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { fieldMappingSource } from "./mapping-source.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { readSharedDocumentFieldProjection } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument, encodeSharedState, encodeSharedStateVector, readSharedRevision, observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { agree } from "./executor-support.ts";

test("field projection emits zero transactions or updates and leaves bytes, vector and revision unchanged", () => {
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, fieldMappingSource());
    const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
    let transactions = 0, updates = 0;
    const detach = observeSharedTransactions(handle, () => { transactions++; });
    collabState(handle).doc.on("update", () => { updates++; });
    const first = readSharedDocumentFieldProjection(handle), before = JSON.stringify(first);
    const rows = first.document.rows as Record<string, unknown>[]; assert.ok(rows[0]); rows[0].lengthSeconds = 8;
    assert.equal(JSON.stringify(readSharedDocumentFieldProjection(handle)), before);
    assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector);
    assert.equal(readSharedRevision(handle), revision); assert.equal(transactions, 0); assert.equal(updates, 0); detach();
  } finally { destroySharedDocument(handle); }
});

test("seeded malformed records, unstable identities and structural values project identically after encoded reload", () => {
  const handle = createMonitoredSharedDocument(), values: unknown[] = [null, undefined, 0, false, "x", {}, [], new Array(2), { b: "bad\ud800" }, { h: "bad\ufffd" }];
  let seed = 1414;
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "x" }] }));
    for (let index = 0; index < 40; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      transactSharedDocument(handle, "remote", () => {
        const roots = collabState(handle).roots;
        for (const root of [roots.comments, roots.replies, roots.people, roots.tags, roots.shots, roots.visuals, roots.gallery, roots.segments]) root.set("malformed", values[seed % values.length]);
        const unstable = new Y.Map<unknown>(); roots.people.set("bad\ud800", unstable); unstable.set("id", "bad\ud800"); unstable.set("name", "Hidden");
        roots.order.push(["malformed"]);
        const segment = roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map); segment.set("head", values[(seed >>> 8) % values.length]);
        roots.meta.set("capture", values[(seed >>> 12) % values.length]);
      });
      const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
      agree("malformed field projection " + seed, "rev", [handle], readSharedDocumentFieldProjection);
      assert.deepEqual(readSharedDocumentFieldProjection(handle).document.people, []);
      assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector); assert.equal(readSharedRevision(handle), revision);
    }
  } finally { destroySharedDocument(handle); }
});

test("field projection keeps every reply while applying oldest-first and UTF-16 id ties", () => {
  const input = validatedFixture({ rows: [{ id: "R1" }], comments: [{ id: "C1", replies: [
    { id: "z", author: "A", body: "third", createdAt: "2026-01-03T00:00:00Z" },
    { id: "constructor", author: "A", body: "second", createdAt: "2026-01-01T00:00:00Z" },
    { id: "__proto__", author: "A", body: "first", createdAt: "2026-01-01T00:00:00Z" }
  ] }] });
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, input);
    const comment = (readSharedDocumentFieldProjection(handle).document.comments as { replies: unknown }[])[0]; assert.ok(comment);
    assert.deepEqual(comment.replies, [
      { id: "__proto__", author: "A", body: "first", createdAt: "2026-01-01T00:00:00Z" },
      { id: "constructor", author: "A", body: "second", createdAt: "2026-01-01T00:00:00Z" },
      { id: "z", author: "A", body: "third", createdAt: "2026-01-03T00:00:00Z" }
    ]);
  } finally { destroySharedDocument(handle); }
});
