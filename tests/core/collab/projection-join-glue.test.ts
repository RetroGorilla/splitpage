import test from "node:test";
import assert from "node:assert/strict";
import { projectSharedJoinGlue, sharedJoinGlueRegisterField } from "../../../src/core/collab/projection/join-glue.ts";

test("join glue registers accept exactly the vocabulary values and preserve the issued fallback", () => {
  assert.equal(sharedJoinGlueRegisterField("jA"), "joinGlue:jA");
  assert.equal(sharedJoinGlueRegisterField("joinGlue:jA"), "joinGlue:joinGlue:jA");
  assert.equal(projectSharedJoinGlue(" ", ""), ""); assert.equal(projectSharedJoinGlue("", " "), " ");
  for (const invalid of [undefined, null, true, false, 0, 1, "x", "  ", "\n", [], [""], {}, { value: "" }, Object(" ")]) {
    assert.equal(projectSharedJoinGlue(" ", invalid), " "); assert.equal(projectSharedJoinGlue("", invalid), "");
  }
});
