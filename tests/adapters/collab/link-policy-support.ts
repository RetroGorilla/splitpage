import assert from "node:assert/strict";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { readSharedTextTarget } from "../../../src/adapters/collab/text-target.ts";
import { explode } from "../../../src/core/text/edits.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

let runtime: ReturnType<typeof createFlowLoadRuntime> | null = null;
let totals: { documents: number; fields: number; linkRuns: number; linkedUnits: number } | null = null;

export function hydrateWithDecodedLinkAudit(handle: SharedDocumentHandle, source: ValidatedDocument): void {
  hydrateSharedDocument(handle, source);
  runtime ??= createFlowLoadRuntime(); totals ??= { documents: 0, fields: 0, linkRuns: 0, linkedUnits: 0 };
  totals.documents++;
  for (const row of source.rows) for (const field of ["audioText", "visualText"] as const) {
    const target = readSharedTextTarget({ owner: row.id, segment: field === "audioText" ? "b:" + row.id : row.id, field }); assert.ok(target);
    const decoded = runtime.cells(row[field]), actual = readSharedMarkCharacters(handle, target); assert.ok(actual);
    const expected = explode(decoded).flatMap(char => {
      const marks = char.atom ? char.atom.marks : char.marks;
      return marks.href ? [{ value: char.atom ? "\ufffc" : char.ch, href: marks.href }] : [];
    });
    const found = actual.flatMap(char => [...new Set(char.marks.filter(group => group.kind === "link").flatMap(group => group.values))].sort()
      .map(href => ({ value: char.value, href })));
    assert.deepEqual(found, expected, `${row.id}/${field}: hydration dropped or changed a decoder link`);
    totals.fields++; totals.linkRuns += decoded.filter(run => !!run.marks.href).length; totals.linkedUnits += expected.length;
  }
}

export function readHydrationLinkAudit() {
  return { documents: totals?.documents ?? 0, fields: totals?.fields ?? 0, linkRuns: totals?.linkRuns ?? 0, linkedUnits: totals?.linkedUnits ?? 0 };
}
