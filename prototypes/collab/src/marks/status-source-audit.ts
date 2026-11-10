import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface StatusTimingChanges {
  trackingIssue: string;
  retainedRows: string;
  dependencies: { before: string; after: string };
  counts: { before: string; after: string };
  files: { path: string; before: string | null; after: string; change: string }[];
}

export function statusTimingChanges(): StatusTimingChanges {
  return JSON.parse(readFileSync(new URL("status-timing-changes.json", import.meta.url), "utf8")) as StatusTimingChanges;
}

export function validateStatusTimingChanges(changes = statusTimingChanges()): void {
  assert.equal(changes.trackingIssue, "https://github.com/RetroGorilla/splitpage/issues/1376");
  assert.equal(new Set(changes.files.map(file => file.path)).size, changes.files.length);
  assert.deepEqual(changes.files.map(file => file.path).sort(), [
    "src/marks/commands.ts", "src/marks/projection.ts", "src/marks/status-resolution.ts", "src/marks/status-source-audit.ts",
    "src/perf/lifetime/audit.ts", "src/perf/lifetime/projector.ts", "src/perf/lifetime/report.ts", "src/perf/lifetime/status-order.ts",
    "src/perf/report.ts", "src/perf/setup.ts", "src/structure-reader.ts"
  ].sort());
  for (const file of changes.files) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(`../../${file.path}`, import.meta.url))).digest("hex"), file.after, `Status source changed: ${file.path}`);
  }
}
