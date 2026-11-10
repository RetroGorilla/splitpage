import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface ReaderOrderChanges {
  baseHead: string;
  dependencies: { before: string; after: string };
  counts: { before: string; after: string };
  files: { path: string; before: string | null; after: string; original: string | null }[];
  bundles: Record<string, { before: string; after: string }>;
}

export function readerOrderChanges(): ReaderOrderChanges {
  return JSON.parse(readFileSync(new URL("source-changes.json", import.meta.url), "utf8")) as ReaderOrderChanges;
}

export function readerCurrentHash(path: string, previous: string | null): string | null {
  const change = readerOrderChanges().files.find(file => file.path === path);
  if (!change) return previous;
  assert.equal(change.before, previous, `Reader audit chain broken: ${path}`);
  return change.after;
}

export function validateReaderOrderChanges(changes = readerOrderChanges()): void {
  assert.equal(changes.baseHead, "8efcff798f7d92ab890207d414ec2f416b69f695");
  assert.equal(new Set(changes.files.map(file => file.path)).size, changes.files.length);
  assert.deepEqual(changes.files.map(file => file.path).sort(), [
    "src/editing-buffer.ts", "src/marks/commands.ts", "src/marks/mutation-audit.ts", "src/marks/projection.ts",
    "src/marks/status-browser-audit.ts", "src/marks/status-source-audit.ts", "src/marks/status-resolution.ts", "src/perf/blocks.ts", "src/perf/counts.ts", "src/perf/delta.ts", "src/perf/history.ts", "src/perf/incremental.ts",
    "src/perf/lifetime/attribution.ts", "src/perf/lifetime/audit.ts", "src/perf/lifetime/counts.ts", "src/perf/lifetime/projector.ts",
    "src/perf/lifetime/record.ts", "src/perf/lifetime/report.ts", "src/perf/lifetime/status-order.ts", "src/perf/operations.ts",
    "src/perf/report.ts", "src/perf/setup.ts", "src/proj/document.ts", "src/proj/richtext.ts", "src/proj/value.ts", "src/reader.ts",
    "src/readers/identity.ts", "src/readers/joins.ts", "src/readers/order.ts", "src/readers/perf.ts", "src/readers/records.ts", "src/readers/removal-commands.ts",
    "src/readers/removals.ts", "src/readers/source-audit.ts", "src/readers/spans.ts", "src/readers/structure.ts", "src/schema.ts", "src/structure.ts", "src/structure-reader.ts"
  ].sort());
  for (const file of changes.files) {
    assert.equal(file.original === null ? null : createHash("sha256").update(file.original).digest("hex"), file.before);
    assert.equal(createHash("sha256").update(readFileSync(new URL(`../../${file.path}`, import.meta.url))).digest("hex"), file.after, `Reader source changed: ${file.path}`);
  }
}
