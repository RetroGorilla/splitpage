import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface StatusTimingChanges {
  trackingIssue: string;
  retainedRows: string;
  dependencies: { before: string; after: string };
  counts: { before: string; after: string };
  files: { path: string; before: string | null; after: string; change: string }[];
  reviewChanges?: { path: string; before: string; after: string }[];
  reviewDependencies?: { before: string; after: string };
  reviewCounts?: { before: string; after: string };
}

export function statusTimingChanges(): StatusTimingChanges {
  return JSON.parse(readFileSync(new URL("status-timing-changes.json", import.meta.url), "utf8")) as StatusTimingChanges;
}

export function currentStatusHash(path: string): string {
  const changes = statusTimingChanges(), original = changes.files.find(file => file.path === path);
  assert.ok(original);
  const reviewed = changes.reviewChanges?.find(file => file.path === path);
  if (reviewed) assert.equal(reviewed.before, original.after);
  return reviewed?.after ?? original.after;
}

export function validateStatusTimingChanges(changes = statusTimingChanges()): void {
  assert.equal(changes.trackingIssue, "https://github.com/RetroGorilla/splitpage/issues/1376");
  assert.equal(new Set(changes.files.map(file => file.path)).size, changes.files.length);
  assert.equal(new Set(changes.reviewChanges?.map(file => file.path)).size, changes.reviewChanges?.length ?? 0);
  for (const reviewed of changes.reviewChanges ?? []) {
    const original = changes.files.find(file => file.path === reviewed.path); assert.ok(original);
    assert.equal(reviewed.before, original.after);
  }
  if (changes.reviewDependencies) assert.equal(changes.reviewDependencies.before, changes.dependencies.after);
  if (changes.reviewCounts) assert.equal(changes.reviewCounts.before, changes.counts.after);
  assert.deepEqual(changes.files.map(file => file.path).sort(), [
    "src/marks/commands.ts", "src/marks/projection.ts", "src/marks/status-resolution.ts", "src/marks/status-source-audit.ts",
    "src/perf/lifetime/audit.ts", "src/perf/lifetime/projector.ts", "src/perf/lifetime/report.ts", "src/perf/lifetime/status-order.ts",
    "src/perf/report.ts", "src/perf/setup.ts", "src/structure-reader.ts"
  ].sort());
  for (const file of changes.files) {
    const reviewed = changes.reviewChanges?.find(change => change.path === file.path);
    assert.equal(createHash("sha256").update(readFileSync(new URL(`../../${file.path}`, import.meta.url))).digest("hex"), reviewed?.after ?? file.after, `Status source changed: ${file.path}`);
  }
}
