import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecord } from "./record-support.ts";
import { recordProjectionReplicas, submitRecords, rawGalleryJoin, checkRecordProjection, pictureA, annotationA, plainRow } from "./projection-record-support.ts";
import { literalMergedDocument } from "./projection-merged-support.ts";
import { joinWithPrevious } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const runtime = createFlowLoadRuntime();
for (const order of ["D1", "rev", "dup"] as const) for (const shape of ["hash-only", "empty-marks", "hash-only-then-valid"] as const)
  test(`gallery annotation eligibility matches the standalone reader: ${shape} ${order}`, () => {
    const run = recordProjectionReplicas(3, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }] });
    const invalid = shape === "empty-marks" ? { imageRef: annotationA.imageRef, marks: [] }
      : { imageRef: { sha256: annotationA.imageRef.sha256 }, marks: annotationA.marks };
    const valid = shape === "hash-only-then-valid";
    try {
      submitRecords(run.a, [createRecord("gallery", "first", { beat: "R1", rank: "0", picture: { imageRef: pictureA, annotation: invalid }, links: [] })]);
      if (valid) submitRecords(run.b, [createRecord("gallery", "later", { beat: "R2", rank: "0", picture: { imageRef: pictureA, annotation: annotationA }, links: [] })]);
      rawGalleryJoin(run.c);
      const row = { ...plainRow("R1", "a b"), imageRef: pictureA, ...(valid ? { imageAnnotation: annotationA } : {}) };
      const standalone = joinWithPrevious({ rows: [
        { ...plainRow("R1", "a"), imageRef: pictureA, imageAnnotation: invalid },
        { ...plainRow("R2", "b"), ...(valid ? { imageRef: pictureA, imageAnnotation: annotationA } : {}) }
      ], comments: [] }, "R2", runtime.ports);
      assert.ok(standalone && "rows" in standalone);
      assert.deepEqual(standalone.rows[0]?.imageAnnotation, valid ? annotationA : undefined);
      checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: [row] });
      assert.deepEqual(runtime.load({ ...literalMergedDocument(""), rows: [row] }).rows[0]?.imageAnnotation, valid ? annotationA : undefined);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const removed of [false, true])
  test(`gallery folds duplicate pictures, first metadata and URL/file links like standalone: ${copies} ${order} removed=${removed}`, () => {
    const run = recordProjectionReplicas(copies, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }] });
    try {
      submitRecords(run.a, [createRecord("gallery", "z", { beat: "R1", rank: "9", picture: { imageRef: pictureA, name: "", annotation: { imageRef: annotationA.imageRef, marks: [] } }, links: [
        { href: "https://example.test/v", duration: 3 }, { name: "clip.mp4", size: 7, duration: 4 }] })]);
      submitRecords(run.b, [createRecord("gallery", "a", { beat: "R2", rank: "0", picture: { imageRef: pictureA, name: "First name", annotation: annotationA }, links: [
        { href: "https://example.test/v", duration: 99, poster: true }, { name: "clip.mp4", size: 7, duration: 99 }, { href: "https://example.test/other" }] }),
      createRecord("gallery", "b", { beat: "R2", rank: "1", picture: { imageRef: pictureA, name: "Later name", annotation: { ...annotationA, marks: [{ ...annotationA.marks[0], text: "Later note" }] } }, links: [] })]);
      rawGalleryJoin(copies === 3 ? run.c : run.a, removed);
      const expected = { ...plainRow("R1", "a b"), imageRef: pictureA, imageAnnotation: annotationA,
        imageLinks: [{ href: "https://example.test/v", duration: 3, poster: true }, { name: "clip.mp4", size: 7, duration: 4 }, { href: "https://example.test/other" }], imageName: "First name" };
      const standalone = joinWithPrevious({ rows: [
        { ...plainRow("R1", "a"), imageRef: pictureA, imageAnnotation: { imageRef: annotationA.imageRef, marks: [] }, imageLinks: [{ href: "https://example.test/v", duration: 3 }, { name: "clip.mp4", size: 7, duration: 4 }] },
        { ...plainRow("R2", "b"), imageRef: pictureA, imageName: "First name", imageAnnotation: annotationA,
          imageLinks: [{ href: "https://example.test/v", duration: 99, poster: true }, { name: "clip.mp4", size: 7, duration: 99 }, { href: "https://example.test/other" }] }
      ], comments: [] }, "R2", runtime.ports);
      assert.ok(standalone && "rows" in standalone); const row = standalone.rows[0]; assert.ok(row);
      for (const key of ["imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages"]) assert.deepEqual(expected[key as keyof typeof expected], row[key]);
      checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: removed ? [] : [expected] },
        removed ? [{ kind: "removed-beat", row: expected, members: ["R1", "R2"] }] : []);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const equal of [false, true]) test(`gallery ranks precede UTF-16 item ids, independent of writer: ${copies} ${order} equal=${equal}`, () => {
  const run = recordProjectionReplicas(copies, { rows: [{ id: "R1", audioText: "a" }] });
  try {
    submitRecords(run.a, [createRecord("gallery", "á", { beat: "R1", rank: equal ? "1" : "0", picture: { imageRef: pictureA, name: "Z" }, links: [] })]);
    submitRecords(run.b, [createRecord("gallery", "a\u0301", { beat: "R1", rank: equal ? "1" : "9", picture: { imageRef: pictureA, name: "A" }, links: [] })]);
    checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: [{ ...plainRow("R1", "a"), imageRef: pictureA, imageName: equal ? "A" : "Z" }] });
  } finally { run.close(); }
});
for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`gallery uses merged beat order when the join root comes later: ${copies} ${order}`, () => {
  const run = recordProjectionReplicas(copies, { rows: [{ id: "R2", audioText: "b" }, { id: "R1", audioText: "a" }] });
  try {
    submitRecords(run.a, [createRecord("gallery", "root", { beat: "R1", rank: "0", picture: { imageRef: pictureA, name: "Root" }, links: [] })]);
    submitRecords(run.b, [createRecord("gallery", "child", { beat: "R2", rank: "9", picture: { imageRef: pictureA, name: "Child" }, links: [] })]);
    rawGalleryJoin(run.a);
    checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: [{ ...plainRow("R1", "a b"), imageRef: pictureA, imageName: "Child" }] });
  } finally { run.close(); }
});
for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`gallery items without pictures never fold: ${copies} ${order}`, () => {
  const run = recordProjectionReplicas(copies, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "b" }] });
  try {
    submitRecords(run.a, [createRecord("gallery", "z", { beat: "R1", rank: "1", picture: { imageRef: null }, links: [{ href: "https://example.test/one", poster: true }] })]);
    submitRecords(run.b, [createRecord("gallery", "a", { beat: "R2", rank: "1", picture: { imageRef: null }, links: [{ href: "https://example.test/two", poster: true }] })]);
    rawGalleryJoin(run.a);
    checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: [{ ...plainRow("R1", "a b"),
      imageLinks: [{ href: "https://example.test/one", poster: true }], moreImages: [{ imageRef: null, links: [{ href: "https://example.test/two", poster: true }] }] }] });
  } finally { run.close(); }
});
