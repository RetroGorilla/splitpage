import assert from "node:assert/strict";
import { test } from "node:test";
import { runCueProjections } from "../../src/proj/cues.ts";
import { fromDocument, toDocument } from "../../src/proj/document.ts";
import { records } from "../../src/proj/value.ts";

test("PROJ-cue stored versus derived over every canonical document holding cue spans", () => {
  const results = runCueProjections();
  assert.equal(results.length, 12);
  for (const result of results) {
    assert.deepEqual(result.stored, [], `${result.candidate} ${result.fixture}`);
    if (result.fixture === "migrate-golden.json/scenarios/media in cells/output") {
      assert.equal(result.derived.length, 1);
      assert.equal(result.derived[0]?.path, "$.rows.1.audioText");
    } else assert.deepEqual(result.derived, [], `${result.candidate} ${result.fixture}`);
  }
});

for (const candidate of ["A", "B"] as const) test(`PROJ-cue deriving the flag invents it on an intentionally unmarked line ${candidate}`, () => {
  const source = {
    schema: 2, rows: [{ id: "R1", audioText: '<span class="audio-cue">SFX: bell</span><br>SFX: intentionally plain', visualText: "" }]
  };
  const replica = fromDocument(source, candidate);
  try {
    assert.equal(records(toDocument(replica.doc, candidate).rows)[0]?.audioText, '<span class="audio-cue">SFX: bell</span><br>SFX: intentionally plain');
    assert.equal(records(toDocument(replica.doc, candidate, { deriveCue: true }).rows)[0]?.audioText, '<span class="audio-cue">SFX: bell</span><br><span class="audio-cue">SFX: intentionally plain</span>');
  } finally { replica.destroy(); }
});
