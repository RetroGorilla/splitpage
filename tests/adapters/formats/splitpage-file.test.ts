import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSplitpageFile } from "../../../src/adapters/formats/splitpage-file.ts";

test("parseSplitpageFile returns the parsed object when it has a rows list", () => {
  const parsed = parseSplitpageFile('{"title":"T","rows":[{"id":"a"}],"extra":1}');
  assert.deepEqual(parsed, { title: "T", rows: [{ id: "a" }], extra: 1 });
  assert.deepEqual(parseSplitpageFile('{"rows":[]}'), { rows: [] });
});

test("parseSplitpageFile refuses anything that is not an object with a rows list", () => {
  for (const text of ["null", "7", '"x"', "[]", '[{"rows":[]}]', "{}", '{"rows":"no"}', '{"rows":{}}']) {
    assert.throws(() => parseSplitpageFile(text), /not-a-splitpage-file/, text);
  }
});

test("parseSplitpageFile lets malformed JSON throw its own error", () => {
  assert.throws(() => parseSplitpageFile("{"), SyntaxError);
});
