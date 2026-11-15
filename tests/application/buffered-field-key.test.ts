import test from "node:test";
import assert from "node:assert/strict";
import { unsettledTitle } from "../../src/application/editing/buffered-field-key.ts";

test("a title already past its cap can be shortened while additional growth is refused", () => {
  const stored = "t".repeat(302);
  assert.equal(unsettledTitle("t".repeat(301), stored), null);
  assert.equal(unsettledTitle("t".repeat(300), stored), null);
  assert.deepEqual(unsettledTitle(stored + "t", stored), { reason: "buffer-title-length", hold: false });
});
