import test from "node:test";
import assert from "node:assert/strict";
import { detectTwoColumnFormat, parseImportRows } from "./import-text.ts";

for (const [mode, text, expected] of [
  ["paragraph", " First\r\nline \n\n Second ", [{ visualText: "", audioText: "First\nline" }, { visualText: "", audioText: "Second" }]],
  ["line", " First\r\n\n Second ", [{ visualText: "", audioText: "First" }, { visualText: "", audioText: "Second" }]],
  ["sentence", "First!\nSecond? Last", [{ visualText: "", audioText: "First!" }, { visualText: "", audioText: "Second?" }, { visualText: "", audioText: "Last" }]],
  ["twocolumn", "Visual: Forest\nAudio: Hello\ncontinued\nVisual: River\nAudio: Goodbye", [{ visualText: "Forest", audioText: "Hello continued" }, { visualText: "River", audioText: "Goodbye" }]],
  ["twocolumn", "Audio\tVisual\nHello\tForest\nGoodbye\tRiver", [{ visualText: "Forest", audioText: "Hello" }, { visualText: "River", audioText: "Goodbye" }]],
  ["twocolumn", "Forest\nHello\nRiver", [{ visualText: "Forest", audioText: "Hello" }, { visualText: "River", audioText: "" }]]
] as const) {
  test("import parser: " + mode + " chunks retain their content and columns", () => {
    assert.deepEqual(parseImportRows(text, mode), expected);
  });
}

test("empty input produces no rows in every mode", () => {
  for (const mode of ["paragraph", "line", "sentence", "twocolumn"]) assert.deepEqual(parseImportRows(" \r\n ", mode), []);
});

test("detection keeps its label and delimiter thresholds", () => {
  assert.equal(detectTwoColumnFormat("Visual: Forest\nAudio: Hello"), "labels");
  assert.equal(detectTwoColumnFormat("Introduction\nVisual: Forest\nAudio: Hello"), null);
  assert.equal(detectTwoColumnFormat("one | two"), null);
  assert.equal(detectTwoColumnFormat("one | two\nthree | four"), "table");
  assert.equal(detectTwoColumnFormat("one\ttwo\nthree\tfour"), "tab");
});
