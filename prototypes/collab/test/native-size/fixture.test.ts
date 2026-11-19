import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTarget, buildSizeFixture, loadSizeReplica, readSizeScript, sizeSignature } from "../../src/native-size/fixture.ts";

test("E8 history fixture meets its size target and reloads the intended script", () => {
  const fixture = buildSizeFixture(0.5);
  assertTarget(0.5, fixture.state.byteLength);
  const replica = loadSizeReplica(fixture.state);
  try {
    const script = readSizeScript(replica);
    assert.deepEqual(sizeSignature(script), fixture.expected);
    assert.equal(script.rows.length, 300);
    assert.equal(script.headings.length, 20);
    assert(script.rows.some(row => row.audio.some(part => part.attributes?.b === true)));
  } finally {
    replica.destroy();
  }
});
