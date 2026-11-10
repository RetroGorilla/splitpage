import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { canonicalFixtures } from "./fixtures.ts";
import { fromDocument, toDocument } from "./document.ts";
import { appReferences } from "./reference.ts";
import type { ProjectionBag } from "./value.ts";
import type { SchemaCandidate } from "../schema.ts";

export interface ProjectionDifference {
  path: string;
  before?: unknown;
  after?: unknown;
}

export function differences(before: unknown, after: unknown, path = "$"): ProjectionDifference[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" && Array.isArray(before) === Array.isArray(after)) {
    const a = before as ProjectionBag, b = after as ProjectionBag;
    const result = [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => differences(a[key], b[key], `${path}.${key}`));
    if (!result.length) result.push({ path: `${path}.[key order]`, before: Object.keys(a), after: Object.keys(b) });
    return result;
  }
  return [{ path, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }];
}

export function firstByteDifference(before: string, after: string): { offset: number; before: string; after: string } | null {
  const a = Buffer.from(before), b = Buffer.from(after);
  let offset = 0;
  while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
  if (offset === a.length && offset === b.length) return null;
  return { offset, before: a.subarray(Math.max(0, offset - 20), offset + 80).toString(), after: b.subarray(Math.max(0, offset - 20), offset + 80).toString() };
}

export function inventoryFields(): string[] {
  const text = readFileSync(new URL("../../../../docs/collaboration/stage-0/2-fields.md", import.meta.url), "utf8").split("## Marks with identity")[0] as string;
  return text.split(/\r?\n/).filter(line => line.startsWith("| ") && !/^\| (Field|Item|---)/.test(line)).map(line => line.split("|")[1]?.trim() as string);
}

export function runRoundTrips() {
  const fixtures = canonicalFixtures();
  const references = appReferences(fixtures.map(fixture => fixture.bytes));
  const projections: { candidate: SchemaCandidate; index: number; document: ProjectionBag; encoded: number; plainDifferences: ProjectionDifference[] }[] = [];
  for (const candidate of ["A", "B"] as const) {
    references.forEach((reference, index) => {
      const replica = fromDocument(reference.document, candidate);
      const second = new Y.Doc();
      try {
        const update = Y.encodeStateAsUpdate(replica.doc);
        Y.applyUpdate(second, update);
        const vector = Y.encodeStateVector(second);
        const document = toDocument(second, candidate);
        if (Buffer.compare(vector, Y.encodeStateVector(second)) !== 0) throw new Error("Projection wrote shared state");
        projections.push({ candidate, index, document, encoded: update.byteLength, plainDifferences: differences(reference.document, document) });
      } finally {
        replica.destroy();
        second.destroy();
      }
    });
  }
  const saved = appReferences([...fixtures.map(fixture => fixture.bytes), ...projections.map(projection => projection.document)]).slice(fixtures.length);
  return projections.map((projection, index) => {
    const fixture = fixtures[projection.index];
    const reference = references[projection.index];
    const result = saved[index];
    if (!fixture || !reference || !result) throw new Error("Missing projection fixture");
    return {
      candidate: projection.candidate, fixture: fixture.name, source: fixture.source,
      fileBytes: Buffer.byteLength(fixture.bytes), savedBytes: Buffer.byteLength(result.saved), encodedBytes: projection.encoded,
      byteIdentical: fixture.bytes === result.saved, appSaveIdentical: fixture.bytes === reference.saved,
      sameAsAppSave: reference.saved === result.saved,
      originalDifference: firstByteDifference(fixture.bytes, result.saved),
      appSaveDifference: firstByteDifference(reference.saved, result.saved),
      appNormalizations: differences(JSON.parse(fixture.bytes), JSON.parse(reference.saved)),
      projectionDifferences: projection.plainDifferences,
      savedDifferences: differences(JSON.parse(reference.saved), JSON.parse(result.saved))
    };
  });
}
