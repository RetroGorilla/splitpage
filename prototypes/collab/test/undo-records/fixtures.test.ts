import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { retainedFamilies, retainedUndoSources } from "./retained.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const undoCall = /\b(undoOne|undoJoin|undoStatus|undoCapturedMarks|undoStructuralRange)\(|\.undo\(\)/;

function testFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === "undo-records" ? [] : testFiles(path);
    return entry.name.endsWith(".ts") ? [relative(root, path).replaceAll("\\", "/")] : [];
  });
}

test("every retained test file with an undo step has its families listed, and every listed family runs", () => {
  const withUndo = testFiles(join(root, "test")).filter(file => undoCall.test(readFileSync(join(root, file), "utf8"))).sort();
  assert.deepEqual(Object.keys(retainedUndoSources).sort(), withUndo);
  const families = new Set(retainedFamilies.map(family => family.name));
  assert.equal(families.size, retainedFamilies.length);
  for (const [file, listed] of Object.entries(retainedUndoSources)) {
    assert.ok(listed.length > 0, file);
    for (const name of listed) assert.ok(families.has(name), `${file} lists ${name}, which does not run`);
  }
  const listed = new Set(Object.values(retainedUndoSources).flat());
  for (const family of retainedFamilies) assert.ok(listed.has(family.name), `${family.name} names no source file`);
});

for (const family of retainedFamilies) {
  for (const run of family.runs) {
    test(`B command records, retained family ${family.name}: ${run.label}`, () => {
      const result = run.run();
      assert.equal(result.failure, null, result.history.join("\n"));
      assert.ok(result.checks >= 2);
    });
  }
}
