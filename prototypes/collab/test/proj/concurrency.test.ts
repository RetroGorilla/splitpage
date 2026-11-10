import assert from "node:assert/strict";
import { test } from "node:test";
import { projectionConcurrentCaseName, projectionConcurrentSeed, runConcurrentProjections } from "../../src/proj/concurrency.ts";
import { runDetachedProjections } from "../../src/proj/detached.ts";
import { assertProjectionInput, projectionReferences } from "../../src/proj/reference.ts";
import { copy, records } from "../../src/proj/value.ts";
import { DocumentProjectionHarness } from "../../src/proj/harness.ts";
import { toDocument } from "../../src/proj/document.ts";
import { mapValue } from "../../src/schema.ts";

test("PROJ different fields merge with literal outcomes; unknown extras survive D1/dup/rev/late-C and swapped ids", () => {
  const results = runConcurrentProjections();
  assert.equal(results.length, 64);
  for (const result of results) for (const document of result.documents) assert.deepEqual(document, result.expected, `${result.candidate} ${result.name} ${result.order}`);
  const references = new Map(projectionReferences("experiment-reference.json").map(reference => [reference.name, reference]));
  for (const result of results) {
    const reference = references.get(projectionConcurrentCaseName(result));
    assertProjectionInput(reference, result.documents[0] as Record<string, unknown>);
    assert.equal(reference.stableAppSave, true);
  }
});

test("PROJ-detached explicit mark-move command retains last location after concurrent deletion", () => {
  const results = runDetachedProjections();
  assert.equal(results.length, 16);
  for (const result of results) {
    for (const document of result.moved) {
      const rows = records(document.rows);
      assert.equal(rows[0]?.audioText, "");
      assert.equal(rows[1]?.audioText, '<span class="cmt-anchor" data-cmt="C1">b</span>');
      const comments = records(document.comments);
      assert.equal(comments[0]?.rowId, "R2");
      assert.equal(comments[0]?.field, "audioText");
      assert.equal(comments[1]?.anchorId, null);
      assert.equal(comments[1]?.rowId, "R1");
      assert.equal(comments[1]?.field, "visualText");
      assert.equal(comments[1]?.author, "Splitpage");
      assert.equal(comments[1]?.body, 'This was in the scene\'s visual column. Pictures and videos go in comments now:<br><img class="comment-img" data-blob="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">');
    }
    for (const document of result.detached) {
      assert.equal(records(document.rows)[1]?.audioText, "");
      assert.equal(records(document.comments)[0]?.rowId, "R2");
      assert.equal(records(document.comments)[0]?.field, "audioText");
      assert.equal(records(document.comments)[1]?.anchorId, null);
      assert.equal(records(document.comments)[1]?.rowId, "R1");
      assert.equal(records(document.comments)[1]?.field, "visualText");
    }
    assert.deepEqual(result.moved[0], result.moved[1]);
    assert.deepEqual(result.detached[0], result.detached[1]);
    if (result.order === "late-C") {
      assert.deepEqual(result.moved[0], result.moved[2]);
      assert.deepEqual(result.detached[0], result.detached[2]);
    }
  }
});

for (const candidate of ["A", "B"] as const) test(`PROJ live anchor derives its row without repairing the shared fallback ${candidate}`, () => {
  const source = copy(projectionConcurrentSeed);
  const row = records(source.rows)[0];
  assert.ok(row);
  row.audioText = '<span class="cmt-anchor" data-cmt="C1">a</span>';
  const harness = new DocumentProjectionHarness(source, candidate);
  try {
    const from = harness.bob.locate("R1"), into = harness.bob.locate("R2");
    harness.bob.doc.transact(() => {
      from.text.format(from.start, 1, { "c:C1": null });
      into.text.format(into.start, 1, { "c:C1": true });
    });
    harness.queue.flush("dup");
    for (const replica of harness.replicas) {
      assert.equal(mapValue(replica.doc.getMap("comments").get("C1")).get("rowId"), "R1");
      assert.equal(records(toDocument(replica.doc, candidate).comments)[0]?.rowId, "R2");
      assert.equal(mapValue(replica.doc.getMap("comments").get("C1")).get("rowId"), "R1");
    }
  } finally { harness.destroy(); }
});
