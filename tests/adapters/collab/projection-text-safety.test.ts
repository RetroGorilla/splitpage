import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { migrateRows } from "../../../src/bootstrap/document-ports.ts";
import "../../../src/test/_dom.mjs";
import { projectionReferences } from "./projection-roundtrip-support.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { destroySharedDocument, encodeSharedState, encodeSharedStateVector, readSharedRevision, observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { agree, ref } from "./executor-support.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";

test("projection is read-only: zero transactions, unchanged encoded bytes, vector and revision on 291 fixtures", () => {
  for (const fixture of projectionReferences) {
    const handle = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, migrateRows(structuredClone(fixture.document)));
      const bytes = encodeSharedState(handle), vector = encodeSharedStateVector(handle), revision = readSharedRevision(handle);
      let transactions = 0, updates = 0;
      const detach = observeSharedTransactions(handle, () => { transactions++; });
      collabState(handle).doc.on("update", () => { updates++; });
      const first = projectSharedDocument(handle), before = JSON.stringify(first);
      first.title = "Mutated output";
      assert.equal(JSON.stringify(projectSharedDocument(handle)), before, fixture.name);
      assert.deepEqual(encodeSharedState(handle), bytes); assert.deepEqual(encodeSharedStateVector(handle), vector);
      assert.equal(readSharedRevision(handle), revision); assert.equal(transactions, 0); assert.equal(updates, 0); detach();
    } finally { destroySharedDocument(handle); }
  }
});

test("projection chooses the UTF-16 smallest serialized payload for an identified mark in both arrangements", () => {
  for (const values of [["https://z.test", "https://a.test"], ["https://a.test", "https://z.test"]]) {
    const handle = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "x" }] }));
      const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
      values.forEach((value, index) => {
        const id = `add${index}`, record = prepareSharedMarkRecord(handle, target, id, 0, 1, { type: "add", mark: { kind: "link", id: ref("L"), value } });
        assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, target, id, record), { ok: true });
      });
      agree("identified payload arrangements", "rev", [handle], projectSharedDocument);
      assert.equal(projectSharedDocument(handle).rows[0]?.audioText, '<a href="https://a.test" target="_blank" rel="noopener">x</a>');
    } finally { destroySharedDocument(handle); }
  }
});

for (const kind of ["comment", "tag"] as const) test(`projection ${kind} payload collisions use the same rule in both arrangements`, () => {
  for (const values of [["Z", "A"], ["A", "Z"]]) {
    const handle = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "x" }],
        productionTags: [{ id: "t_a", cat: "prop", name: "Alpha" }, { id: "t_z", cat: "prop", name: "Zulu" }],
        comments: [{ id: "recordA", anchorId: "A", rowId: "R1", field: "visualText" }, { id: "recordZ", anchorId: "Z", rowId: "R1", field: "visualText" }] }));
      const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
      values.forEach((value, index) => {
        const id = `payload${index}`, record = prepareSharedMarkRecord(handle, target, id, 0, 1,
          { type: "add", mark: { kind, id: ref("occurrence-only"), value: ref(kind === "tag" ? "t_" + value.toLowerCase() : value) } });
        assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, target, id, record), { ok: true });
      });
      agree("identified " + kind + " payload arrangements", "rev", [handle], projectSharedDocument);
      const doc = projectSharedDocument(handle);
      assert.equal(doc.rows[0]?.audioText, kind === "comment" ? '<span class="cmt-anchor" data-cmt="A">x</span>'
        : '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Alpha" contenteditable="false">x</span>');
      if (kind === "comment") { assert.equal(doc.comments.find(comment => comment.id === "recordA")?.field, "audioText"); assert.equal(doc.comments.find(comment => comment.id === "recordZ")?.field, "visualText"); }
    } finally { destroySharedDocument(handle); }
  }
});

test("projection comment occurrence needs only its anchor payload, with no comment-record lookup", () => {
  const handle = createMonitoredSharedDocument();
  try {
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "x" }] }));
    const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const record = prepareSharedMarkRecord(handle, target, "comment", 0, 1, { type: "add", mark: { kind: "comment", id: ref("native-occurrence"), value: ref("standalone-anchor") } });
    assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, target, "comment", record), { ok: true });
    assert.deepEqual(projectSharedDocument(handle).comments, []);
    assert.equal(projectSharedDocument(handle).rows[0]?.audioText, '<span class="cmt-anchor" data-cmt="standalone-anchor">x</span>');
    agree("comment without record", "rev", [handle], projectSharedDocument);
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
      });
      agree("malformed projection " + seed, "rev", [handle], projectSharedDocument);
      assert.deepEqual(projectSharedDocument(handle).people, []);
    }
  } finally { destroySharedDocument(handle); }
});
