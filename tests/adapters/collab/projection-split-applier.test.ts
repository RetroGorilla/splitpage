import assert from "node:assert/strict";
import { test } from "node:test";
import { validatedFixture } from "./helpers.ts";
import { splitReplicas, submitProjectionOperations, splitOriginal } from "./projection-split-support.ts";
import { readPureMergedProjection, literalMergedDocument, mergedProjectionSave } from "./projection-merged-support.ts";
import { agree } from "./executor-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { startBeat, startParagraph, selectionToOwnBeat, beatPos, enterInHeading, headingPos } from "../../../src/core/flow/flow.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import type { DocumentRow } from "../../../src/core/document/validated.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import * as Y from "yjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";

const runtime = createFlowLoadRuntime();
const box = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">';
const open = '<span class="cmt-anchor" data-cmt="C1"><a href="https://example.test/" target="_blank" rel="noopener">' + box + '<strong>';
const close = '</strong></span></a></span>';
function logicalRows(rows: readonly DocumentRow[], operations: readonly SharedOperation[]) {
  const aliases = new Map(operations.flatMap(op => op.kind === "split" || op.kind === "split-before" || op.kind === "segment-create"
    ? [[JSON.stringify(["structure", "1", op.id, "beat"]), op.beat] as const] : []));
  return rows.map(row => ({ ...row, id: aliases.get(row.id) ?? row.id }));
}
for (const kind of ["beat", "paragraph", "prefix", "blank"] as const) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`traced ${kind} split matches literal marked cells and the independent applier: ${copies} copies ${order}`, () => {
    const source = validatedFixture({ rows: [{ id: "R1", audioText: open + "abcd" + close }], productionTags: [{ id: "t_box", cat: "prop", name: "Box" }],
      comments: [{ id: "C1", anchorId: "C1", rowId: "R1", field: "audioText", quotedText: "abcd", author: "Ada", body: "Typed comment" }] });
    const doc = { rows: source.rows, comments: source.comments }, ports = { ...runtime.ports, newId: () => "fresh", operations: { id: "trace", by: "Writer" } };
    const result = kind === "prefix" ? selectionToOwnBeat(doc, { anchor: beatPos("R1", 0), head: beatPos("R1", 2) }, ports)
      : kind === "paragraph" ? startParagraph(doc, beatPos("R1", 2), ports) : startBeat(doc, beatPos("R1", kind === "blank" ? 4 : 2), ports);
    assert.ok(result && "rows" in result && result.ops);
    const independent = applyFlowOperations(doc, result.ops, runtime.cells);
    const native = '["structure","1","trace:0","beat"]';
    const added = { id: native, status: "todo", visualText: "", audioText: kind === "blank" ? "" : open + (kind === "prefix" ? "ab" : "cd") + close,
      imageRef: null, ...(kind === "paragraph" ? { paragraphStart: true as const } : {}) };
    const original = splitOriginal(open + (kind === "blank" ? "abcd" : kind === "prefix" ? "cd" : "ab") + close);
    const expectedRows = kind === "prefix" ? [added, original] : [original, added];
    assert.deepEqual(logicalRows(expectedRows, result.ops), independent.rows); assert.deepEqual(independent.removedComments, []);
    const run = splitReplicas(copies, source);
    try {
      submitProjectionOperations(run.a, result.ops); run.queue.flush(order);
      const commentRow = kind === "prefix" ? native : "R1";
      const comments = [{ id: "C1", rowId: commentRow, field: "audioText", anchorId: "C1", quotedText: "abcd", author: "Ada", body: "Typed comment",
        resolved: false, resolvedBy: null, resolvedAt: null, assignee: "", updatedAt: null, kind: "anchor", replies: [] }];
      const document = { ...literalMergedDocument(""), rows: expectedRows, comments,
        productionTags: [{ id: "t_box", cat: "prop", name: "Box", owner: "", notes: "", status: "needed" }] };
      for (const handle of run.handles) {
        const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] });
        assert.deepEqual(logicalRows(actual.view.document.rows, result.ops), independent.rows); assert.equal(actual.save, mergedProjectionSave(document));
      }
      agree("traced marked split", order, run.handles, readPureMergedProjection);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`heading tail becomes a beat through the traced entry: ${copies} copies ${order}`, () => {
  const source = validatedFixture({ rows: [{ id: "R1", audioText: "Body" }], sections: [{ id: "H1", name: "ABCD", firstSceneId: "R1" }] });
  const doc = { rows: source.rows, sections: source.sections, comments: source.comments };
  const outcome = enterInHeading(doc, headingPos("H1", 2), { ...runtime.ports, newId: () => "fresh", operations: { id: "heading", by: "Writer" } });
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  const independent = applyFlowOperations(doc, outcome.ops, runtime.cells), native = '["structure","1","heading:0","beat"]';
  const rows = [{ id: native, status: "todo", visualText: "", audioText: "CD", imageRef: null }, { ...splitOriginal("Body"), paragraphStart: true as const }];
  assert.deepEqual(logicalRows(rows, outcome.ops), independent.rows);
  const run = splitReplicas(copies, source);
  try {
    submitProjectionOperations(run.a, outcome.ops); run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows, sections: [{ id: "H1", name: "AB", firstSceneId: native }] };
    for (const handle of run.handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("heading split", order, run.handles, readPureMergedProjection);
  } finally { run.close(); }
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`merged join, status, tags, links and comments work across executed split shapes: ${copies} copies ${order}`, () => {
  const source = validatedFixture({ rows: [{ id: "R1", audioText: open + "abcd" + close }], productionTags: [{ id: "t_box", cat: "prop", name: "Box" }],
    comments: [{ id: "C1", anchorId: "C1", rowId: "R1", field: "audioText", quotedText: "abcd", author: "Ada", body: "Typed comment" }] });
  const doc = { rows: source.rows, comments: source.comments };
  const outcome = startBeat(doc, beatPos("R1", 2), { ...runtime.ports, newId: () => "fresh", operations: { id: "joined", by: "Writer" } });
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  const independent = applyFlowOperations(doc, outcome.ops, runtime.cells);
  const run = splitReplicas(copies, source), native = '["structure","1","joined:0","beat"]';
  try {
    submitProjectionOperations(run.a, outcome.ops); run.queue.flush(order);
    assert.deepEqual(logicalRows(readPureMergedProjection(run.a).view.document.rows, outcome.ops), independent.rows);
    transactSharedDocument(run.b, "local-command", () => {
      const beat = collabState(run.b).roots.beats.get("R1"); assert.ok(beat instanceof Y.Map);
      const joins = beat.get("joins"); assert.ok(joins instanceof Y.Map); joins.set("raw-join", { into: native, glue: " " });
    });
    submitProjectionOperations(run.a, [
      { kind: "scalar", id: "duration", by: "Writer", target: { scope: "beat", record: native }, field: "lengthSeconds", value: 9 },
      { kind: "status", id: "shot", by: "Writer", target: { scope: "beat", record: native }, value: "shot", parents: [] }
    ]); run.queue.flush(order);
    const html = '<span class="cmt-anchor" data-cmt="C1"><a href="https://example.test/" target="_blank" rel="noopener">' + box + '<strong>cd</strong></span> ' + box + '<strong>ab</strong></span></a></span>';
    const document = { ...literalMergedDocument(""), rows: [{ id: native, status: "shot", visualText: "", audioText: html, imageRef: null, lengthSeconds: 9 }],
      comments: [{ id: "C1", rowId: native, field: "audioText", anchorId: "C1", quotedText: "abcd", author: "Ada", body: "Typed comment", resolved: false,
        resolvedBy: null, resolvedAt: null, assignee: "", updatedAt: null, kind: "anchor", replies: [] }],
      productionTags: [{ id: "t_box", cat: "prop", name: "Box", owner: "", notes: "", status: "needed" }] };
    for (const handle of run.handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("split then merged join", order, run.handles, readPureMergedProjection);
  } finally { run.close(); }
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`traced split cuts all inline atom kinds at native boundaries: ${copies} copies ${order}`, () => {
  const who = '<span class="who-anchor" data-who="Ada" contenteditable="false">@Ada</span>';
  const broll = '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>';
  const image = '<img class="comment-img" data-blob="' + "a".repeat(64) + '" data-w="10" data-h="20" data-mime="image/png">';
  const video = '<a class="video-embed-card" href="https://example.test/video" target="_blank" rel="noopener"><span class="vec-play">▶</span><span>Watch video</span><span class="vec-host">· example.test</span></a>';
  const run = splitReplicas(copies, { rows: [{ id: "R1", audioText: "abcd" }] });
  try {
    submitProjectionOperations(run.a, [{ kind: "text-insert", id: "atoms", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 1), affinity: "before" }, content: [
        { value: { atom: "who", name: "Ada" }, marks: [] }, { value: { atom: "broll", id: "S1", text: "B-roll:" }, marks: [] },
        { value: { atom: "image", ref: { sha256: "a".repeat(64), width: 10, height: 20, mime: "image/png" } }, marks: [] },
        { value: { atom: "video", href: "https://example.test/video", host: "example.test" }, marks: [] }
      ] }]);
    run.queue.flush(order);
    const doc = { rows: [splitOriginal("a" + who + broll + image + video + "bcd")], comments: [] };
    const result = startBeat(doc, beatPos("R1", 3), { ...runtime.ports, newId: () => "fresh", operations: { id: "atom-split", by: "Writer" } });
    assert.ok(result && "rows" in result && result.ops);
    const independent = applyFlowOperations(doc, result.ops, runtime.cells), native = '["structure","1","atom-split:0","beat"]';
    const rows = [splitOriginal("a" + who + broll), { id: native, status: "todo", visualText: "", audioText: image + video + "bcd", imageRef: null }];
    assert.deepEqual(logicalRows(rows, result.ops), independent.rows);
    submitProjectionOperations(run.a, result.ops); run.queue.flush(order);
    const document = { ...literalMergedDocument(""), rows };
    for (const handle of run.handles) {
      const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: [] }); assert.equal(actual.save, mergedProjectionSave(document));
    }
    agree("atom split", order, run.handles, readPureMergedProjection);
  } finally { run.close(); }
});
