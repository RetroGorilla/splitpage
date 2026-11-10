import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readerCurrentHash, validateReaderOrderChanges } from "../readers/source-audit.ts";

interface StatusTimingChanges {
  trackingIssue: string;
  retainedRows: string;
  dependencies: { before: string; after: string };
  counts: { before: string; after: string };
  files: { path: string; before: string | null; after: string; change: string }[];
  reviewChanges?: { path: string; before: string; after: string }[];
  reviewDependencies?: { before: string; after: string };
  reviewCounts?: { before: string; after: string };
  validationChanges?: { path: string; before: string; after: string }[];
  validationDependencies?: { before: string; after: string };
  validationCounts?: { before: string; after: string };
}

export function statusTimingChanges(): StatusTimingChanges {
  return JSON.parse(readFileSync(new URL("status-timing-changes.json", import.meta.url), "utf8")) as StatusTimingChanges;
}

export function currentStatusHash(path: string): string {
  const changes = statusTimingChanges(), original = changes.files.find(file => file.path === path);
  const validated = changes.validationChanges?.find(file => file.path === path);
  if (!original) { assert.equal(path, "src/perf/operations.ts"); assert.ok(validated); return validated.after; }
  const reviewed = changes.reviewChanges?.find(file => file.path === path);
  if (reviewed) assert.equal(reviewed.before, original.after);
  if (validated) assert.equal(validated.before, reviewed?.after ?? original.after);
  return validated?.after ?? reviewed?.after ?? original.after;
}

export function validateStatusTimingChanges(changes = statusTimingChanges()): void {
  validateReaderOrderChanges();
  assert.equal(changes.trackingIssue, "https://github.com/RetroGorilla/splitpage/issues/1376");
  assert.equal(new Set(changes.files.map(file => file.path)).size, changes.files.length);
  assert.equal(new Set(changes.reviewChanges?.map(file => file.path)).size, changes.reviewChanges?.length ?? 0);
  assert.equal(new Set(changes.validationChanges?.map(file => file.path)).size, changes.validationChanges?.length ?? 0);
  for (const reviewed of changes.reviewChanges ?? []) {
    const original = changes.files.find(file => file.path === reviewed.path); assert.ok(original);
    assert.equal(reviewed.before, original.after);
  }
  if (changes.reviewDependencies) assert.equal(changes.reviewDependencies.before, changes.dependencies.after);
  if (changes.reviewCounts) assert.equal(changes.reviewCounts.before, changes.counts.after);
  if (changes.validationDependencies) assert.equal(changes.validationDependencies.before, changes.reviewDependencies?.after ?? changes.dependencies.after);
  if (changes.validationCounts) assert.equal(changes.validationCounts.before, changes.reviewCounts?.after ?? changes.counts.after);
  for (const validated of changes.validationChanges ?? []) {
    const original = changes.files.find(file => file.path === validated.path), reviewed = changes.reviewChanges?.find(file => file.path === validated.path);
    if (original) assert.equal(validated.before, reviewed?.after ?? original.after);
    else assert.equal(validated.path, "src/perf/operations.ts");
  }
  assert.deepEqual(changes.files.map(file => file.path).sort(), [
    "src/marks/commands.ts", "src/marks/projection.ts", "src/marks/status-resolution.ts", "src/marks/status-source-audit.ts",
    "src/perf/lifetime/audit.ts", "src/perf/lifetime/projector.ts", "src/perf/lifetime/report.ts", "src/perf/lifetime/status-order.ts",
    "src/perf/report.ts", "src/perf/setup.ts", "src/structure-reader.ts"
  ].sort());
  for (const file of changes.files) {
    const reviewed = changes.reviewChanges?.find(change => change.path === file.path);
    const validated = changes.validationChanges?.find(change => change.path === file.path);
    assert.equal(createHash("sha256").update(readFileSync(new URL(`../../${file.path}`, import.meta.url))).digest("hex"), readerCurrentHash(file.path, validated?.after ?? reviewed?.after ?? file.after), `Status source changed: ${file.path}`);
  }
  for (const file of changes.validationChanges?.filter(file => !changes.files.some(original => original.path === file.path)) ?? [])
    assert.equal(createHash("sha256").update(readFileSync(new URL(`../../${file.path}`, import.meta.url))).digest("hex"), readerCurrentHash(file.path, file.after), `Status validation source changed: ${file.path}`);
}
