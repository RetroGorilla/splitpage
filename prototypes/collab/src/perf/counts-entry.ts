import * as Y from "yjs";
import { readFileSync } from "node:fs";
import { createProjectionReplica, fromDocument } from "../proj/document.ts";
import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { records } from "../proj/value.ts";
import type { PerfFixture } from "./fixtures.ts";
import { PerfBlockIndex } from "./blocks.ts";
import { capturePerfBeat, resolvePerfIdentity } from "./operations.ts";
import { applyWritingCycle, retainedCounts } from "./history.ts";
import { isProjectionEntry } from "../proj/entry.ts";

export interface PerfTraversalCounts {
  relativeItems: number;
  absoluteItems: number;
  storeProbes: number;
}

const globals = globalThis as unknown as { perfTraversal: PerfTraversalCounts };

function reset(): void { globals.perfTraversal = { relativeItems: 0, absoluteItems: 0, storeProbes: 0 }; }

export function countIdentityWork(replica: SchemaReplica, chosen?: string) {
  const index = new PerfBlockIndex(replica.doc, replica.candidate);
  const ids = index.spans.filter(span => span.block.kind === "b" && !mapValue(mapValue(replica.doc.getMap("beats").get(span.block.id)).get("removals")).size).map(span => span.block.id);
  const target = chosen ?? ids.slice(Math.floor(ids.length * 0.75)).reduce((best, id) => {
    const span = index.locate(id), old = index.locate(best);
    return span.end - span.start >= old.end - old.start ? id : best;
  });
  reset();
  const identities = capturePerfBeat(index, target);
  const capture = { ...globals.perfTraversal };
  const anchor = identities.at(-1);
  if (!anchor) throw new Error("Identity count fixture has no characters");
  reset();
  const resolved = resolvePerfIdentity(index, anchor);
  if (!resolved || resolved.beat !== target || resolved.offset !== identities.length - 1) throw new Error("Counted lookup failed");
  return { target, characters: identities.length, publicCaptureCalls: identities.length, capture, lookup: { ...globals.perfTraversal, projectedSpans: index.lastLookupSpansScanned }, resolved };
}

export function collectStructuralCounts(fixtures: PerfFixture[]) {
  const rows = [];
  for (const fixture of fixtures) for (const candidate of ["A", "B"] as const) {
    const replica = fromDocument(fixture.document, candidate);
    try {
      const checkpoints = [];
      const checkpoint = (operations: number) => {
        const encoded = Y.encodeStateAsUpdate(replica.doc);
        const loaded = createProjectionReplica(candidate, 3);
        try {
          Y.applyUpdate(loaded.doc, encoded);
          const counts = retainedCounts(replica);
          if (JSON.stringify(retainedCounts(loaded)) !== JSON.stringify(counts)) throw new Error("Structural checkpoint changed on encoded reload");
          return { operations, encodedBytes: encoded.length, counts, identities: countIdentityWork(loaded), gc: loaded.doc.gc };
        } finally { loaded.destroy(); }
      };
      checkpoints.push(checkpoint(0));
      if (fixture.name === "large") {
        const ids = records(fixture.document.rows).map(row => String(row.id));
        const comments = records(fixture.document.comments).map(comment => String(comment.id));
        let operations = 0;
        for (let cycle = 0; cycle < 500; cycle++) {
          operations += applyWritingCycle(replica, cycle, ids[cycle % ids.length] as string, comments[cycle % comments.length] as string);
          if ([99, 249, 499].includes(cycle)) checkpoints.push(checkpoint(operations));
        }
      }
      rows.push({ fixture: fixture.name, candidate, copies: fixture.copies, fileBytes: fixture.fileBytes, inputSha256: fixture.sha256, checkpoints });
    } finally { replica.destroy(); }
  }
  const controls = [];
  for (const candidate of ["A", "B"] as const) {
    const replica = fromDocument({ title: "Count", rows: [{ id: "R1", audioText: "ab", visualText: "", status: "todo" }, { id: "R2", audioText: "cd", visualText: "", status: "todo" }], comments: [], people: [], productionTags: [], brollShots: [] }, candidate);
    try { controls.push({ candidate, ...countIdentityWork(replica, "R2") }); } finally { replica.destroy(); }
  }
  return { rows, controls };
}

if (isProjectionEntry(import.meta.url) && process.argv[2]) {
  const fixtures = JSON.parse(readFileSync(process.argv[2], "utf8")) as PerfFixture[];
  process.stdout.write(JSON.stringify(collectStructuralCounts(fixtures)));
}
