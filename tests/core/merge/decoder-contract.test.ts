import { test } from "node:test";
import assert from "node:assert/strict";
import type { MergeDecoder } from "../../../src/core/merge/text-field.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { T } from "../text/cells.ts";
import { CONTRACT_HTML, CONTRACT_PICTURE, mergeDecoderBreaks } from "./decoder-contract.ts";
import { fakeDecoder } from "./fakes.ts";

const TAGGED = [T("mug", { tag: "t:prop:Mug" }), T(" out")];

function contractFake(): MergeDecoder {
  return fakeDecoder([
    [T("one two")], [T("one TWO")], TAGGED,
    { html: CONTRACT_HTML.minePicture, cell: [T("one two")], media: [{ kind: "image", ref: CONTRACT_PICTURE }] }
  ]).decode;
}

test("the contract's tagged cell is the one toHtml writes", () => {
  assert.equal(toHtml(TAGGED), CONTRACT_HTML.tag);
});

test("a decoder that reports media and maps tags through tagId meets the merge decoder contract", () => {
  assert.deepEqual(mergeDecoderBreaks(contractFake()), []);
});

test("a decoder that ignores its options breaks every clause, a dropped picture among them", () => {
  const decode = contractFake();
  const ignoring: MergeDecoder = function (html) { return decode(html, {}); };
  assert.deepEqual(mergeDecoderBreaks(ignoring),
    ["onMedia", "tagId", "a picture mine added beside a word theirs changed is a conflict"]);
});
