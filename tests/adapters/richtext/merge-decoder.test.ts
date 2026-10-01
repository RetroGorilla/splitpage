import { test } from "node:test";
import assert from "node:assert/strict";
import type { MergeDecoder } from "../../../src/core/merge/text-field.ts";
import { mergeDecoderBreaks } from "../../core/merge/decoder-contract.ts";
import { adapterWith, fakePorts } from "./fakes.ts";

test("the adapter's decode meets the merge decoder contract", () => {
  const decode: MergeDecoder = adapterWith(fakePorts()).decode;
  assert.deepEqual(mergeDecoderBreaks(decode), []);
});

test("the adapter's cached cell reader ignores the options, so it must never be the merge's decoder", () => {
  const cellOf: MergeDecoder = adapterWith(fakePorts()).createCellReader();
  assert.deepEqual(mergeDecoderBreaks(cellOf),
    ["onMedia", "tagId", "a picture mine added beside a word theirs changed is a conflict"]);
});
