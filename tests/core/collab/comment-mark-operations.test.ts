import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedCommentMarkRemovals, sharedCommentRewriteRefused } from "../../../src/core/collab/comment-mark-operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createFlowLoadRuntime } from "../flow/load.ts";

const cells = createFlowLoadRuntime().cells;
const anchor = (id: string, text: string) => '<span class="cmt-anchor" data-cmt="' + id + '">' + text + "</span>";
const TOKEN = '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>';

test("comment mark removals cover every span of the comment's mark in every cell and no other comment's mark", () => {
  const removal = (owner: string, field: "audioText" | "visualText", spans: readonly [number, number][]) => ({ kind: "mark", target: { owner, segment: owner, field },
    observed: spans.map(([from, to]) => flowBaseReference(owner, field, from, to)), mark: { kind: "comment", id: "C1", value: null } });
  assert.deepEqual(sharedCommentMarkRemovals("C1", [
    { owner: "R1", field: "audioText", runs: cells(anchor("C1", "ab") + "c" + anchor("C1", "d")) },
    { owner: "R1", field: "visualText", runs: cells(anchor("C2", "x")) },
    { owner: "R3", field: "audioText", runs: cells("a" + anchor("C0", "b" + anchor("C1", "c")) + anchor("C1", "d") + TOKEN + anchor("C1", TOKEN)) }
  ]), [removal("R1", "audioText", [[0, 2], [3, 4]]), removal("R3", "audioText", [[2, 4], [5, 6]])]);
  assert.deepEqual(sharedCommentMarkRemovals("C1", [{ owner: "R1", field: "audioText", runs: cells("ab") }]), []);
});

test("an unwrap rewrite may only take away the comment's own marks, on words and on tokens", () => {
  const refused = (before: string, after: string) => sharedCommentRewriteRefused("C1", [{ owner: "R1", field: "audioText", before: cells(before), after: cells(after) }]);
  assert.equal(refused(anchor("C1", "ab") + "c" + anchor("C1", "d"), "abc" + anchor("C1", "d")), false);
  assert.equal(refused(anchor("C1", TOKEN + "b"), TOKEN + "b"), false);
  assert.equal(refused(anchor("C1", "a" + TOKEN + "b"), "a" + TOKEN + "b"), false);
  assert.equal(refused(anchor("C1", "ab" + TOKEN), "ab" + TOKEN), false);
  assert.equal(refused(anchor("C1", "ab"), "ab "), true);
  assert.equal(refused(anchor("C1", "ab"), "aB"), true);
  assert.equal(refused("ab", anchor("C1", "ab")), true);
  assert.equal(refused(anchor("C2", "ab"), "ab"), true);
  assert.equal(refused(anchor("C1", TOKEN), '<span class="broll-key" data-broll-id="S2" contenteditable="false">B-roll:</span>'), true);
});
