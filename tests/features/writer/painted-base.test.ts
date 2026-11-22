import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writerFor } from "./painted-base-support.ts";

test("standalone Writer painting, typing and splitting keep their literal rows", () => {
  const page = writerFor();
  try {
    assert.deepEqual(page.session(), ["a=Al", "new=phas", "b=Bravo"]);
    assert.equal(page.writer.settle, undefined);
  } finally { page.writer.dispose(); }
  const wiring = readFileSync(new URL("../../../src/bootstrap/wiring/writer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(wiring, /\bpaintedText\b/);
  assert.match(wiring, /bindNativeWriterPaint\(root\)/);
});
