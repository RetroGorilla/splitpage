import assert from "node:assert/strict";
import { test } from "node:test";
import { replicas, agree } from "./executor-support.ts";
import { validatedFixture } from "./helpers.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { syncCommentAnchors } from "../../../src/core/text/anchors.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import * as Y from "yjs";
import { assertIncremental, nativeMap, nativeText } from "./incremental-support.ts";

const anchor = (words: string) => '<span class="cmt-anchor" data-cmt="C1">' + words + "</span>";
const review = { id: "C1", anchorId: "C1", quotedText: "word", author: "Ada", body: "Review" };

function standalone(source: Record<string, unknown>): unknown[] {
  const document = validatedFixture(source);
  syncCommentAnchors(document, createFlowLoadRuntime().cells);
  return document.comments.map(comment => [comment.id, comment.rowId, comment.field]);
}

function placed(handle: SharedDocumentHandle): unknown[] {
  return (projectSharedDocument(handle).comments ?? []).map(comment => [comment.id, comment.rowId, comment.field]);
}

test("anchor rule: a comment anchored in both columns of one beat is placed in the visual column on every copy, as in a standalone script", () => {
  const source = { rows: [{ id: "R1", audioText: "plain" }, { id: "R2", audioText: anchor("word"), visualText: anchor("shot") }],
    comments: [{ ...review, rowId: "R1", field: "audioText" }] };
  assert.deepEqual(standalone(source), [["C1", "R2", "visualText"]]);
  for (const order of deliveryOrders) {
    const run = replicas(2, source);
    try {
      transactSharedDocument(run.b, "local-command", () => nativeText(run.b, "b:R1").insert(0, "x"));
      run.queue.flush(order);
      agree("comment placement", order, [run.a, run.b], placed, [["C1", "R2", "visualText"]]);
    } finally { run.close(); }
  }
});

test("anchor rule: an earlier beat's narration still wins over a later beat's visual column", () => {
  const source = { rows: [{ id: "R1", audioText: anchor("word") }, { id: "R2", visualText: anchor("shot") }],
    comments: [{ ...review, rowId: "R2", field: "visualText" }] };
  assert.deepEqual(standalone(source), [["C1", "R1", "audioText"]]);
  const run = replicas(2, source);
  try {
    assert.deepEqual(placed(run.a), [["C1", "R1", "audioText"]]);
  } finally { run.close(); }
});

test("anchor rule, incremental: when the first occurrence goes, the comment moves to the next beat's visual column, and every publication agrees with a fresh full projection", () => {
  const run = replicas(2, { rows: [{ id: "R1", audioText: anchor("word") }, { id: "R2", audioText: anchor("word"), visualText: anchor("shot") }],
    comments: [{ ...review, rowId: "R1", field: "audioText" }] });
  const projector = createSharedIncrementalProjector(run.a), stop = projector.observe(() => assertIncremental(run.a, projector));
  const read = () => (projector.read().document.comments ?? []).map(comment => [comment.rowId, comment.field]);
  try {
    assertIncremental(run.a, projector);
    assert.deepEqual(read(), [["R1", "audioText"]]);
    transactSharedDocument(run.a, "local-command", () => { const text = nativeText(run.a, "b:R1"); text.delete(0, text.length); });
    assert.deepEqual(read(), [["R2", "visualText"]]);
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R2").insert(0, "x"));
    assert.deepEqual(read(), [["R2", "visualText"]]);
    transactSharedDocument(run.a, "local-command", () => {
      const text = nativeMap(run.a, "visuals", "R2").get("text"); assert.ok(text instanceof Y.Text); text.delete(0, text.length);
    });
    assert.deepEqual(read(), [["R2", "audioText"]]);
    assertIncremental(run.a, projector);
  } finally { stop(); projector.dispose(); run.close(); }
});
