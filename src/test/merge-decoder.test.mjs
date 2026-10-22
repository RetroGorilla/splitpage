import "./_dom.mjs";
import "./_preferences-started.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mergeStates } from "../js/03-sync.js";
import { cellOf, fromHtml } from "../js/04c-doc-model.js";
import { CONTRACT_HTML, mergeDecoderBreaks } from "../../tests/core/merge/decoder-contract.ts";

function doc(audio) {
  return {
    title: "Contract", docId: "d" + "4".repeat(32), comments: [], people: [], productionTags: [], brollShots: [],
    wordsPerMinute: 150, rev: 1, schema: 2,
    rows: [{ id: "r1", status: "todo", visualText: "", audioText: audio, imageRef: null, updatedAt: "", updatedBy: null }]
  };
}

test("fromHtml, the decoder 03-sync.js hands the merge, meets the merge decoder contract", () => {
  assert.deepEqual(mergeDecoderBreaks(fromHtml), []);
});

test("cellOf ignores the options, so it fails the contract and must never be the merge's decoder", () => {
  assert.deepEqual(mergeDecoderBreaks(cellOf),
    ["onMedia", "tagId", "a picture mine added beside a word theirs changed is a conflict"]);
});

test("mergeStates keeps a picture mine added beside a word theirs changed as a conflict", () => {
  const res = mergeStates(doc(CONTRACT_HTML.base), doc(CONTRACT_HTML.minePicture), doc(CONTRACT_HTML.theirsWord));
  assert.deepEqual(res.conflicts, [{ rowId: "r1", field: "audioText", mine: CONTRACT_HTML.minePicture, theirs: CONTRACT_HTML.theirsWord }]);
  assert.equal(res.merged.rows[0].audioText, CONTRACT_HTML.theirsWord);
  assert.equal(res.merged.comments.filter((c) => c.kind === "conflict").length, 1);
});
