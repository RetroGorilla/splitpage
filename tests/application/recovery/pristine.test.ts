import { test } from "node:test";
import assert from "node:assert/strict";
import { neverWrittenOut } from "../../../src/application/recovery/pristine.ts";

test("#483: a document is never written out when it has no revision and no editor name once normalised", () => {
  assert.equal(neverWrittenOut({ rev: 0, lastEditedBy: "" }), true);
  assert.equal(neverWrittenOut({ rev: 0, lastEditedBy: "   " }), true, "a whitespace-only name is no name");
  assert.equal(neverWrittenOut({}), true);
  assert.equal(neverWrittenOut(null), true);
  assert.equal(neverWrittenOut({ rev: 2, lastEditedBy: "" }), false);
  assert.equal(neverWrittenOut({ rev: 0, lastEditedBy: "Sam" }), false);
});
