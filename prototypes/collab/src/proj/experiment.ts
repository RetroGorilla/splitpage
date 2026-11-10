import { readFileSync } from "node:fs";
import { fileOrderedCopy } from "../readers/output.ts";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { canonicalFixtures } from "./fixtures.ts";
import { createProjectionReplica, fromDocument, toDocument } from "./document.ts";
import { projectionReferences, serializeProjection } from "./reference.ts";
import type { ProjectionBag } from "./value.ts";
import type { SchemaCandidate } from "../schema.ts";
import { assertProjectionBytes, projectionExclusion } from "./exclusions.ts";

export interface ProjectionDifference {
  path: string;
  before?: unknown;
  after?: unknown;
}

export function differences(before: unknown, after: unknown, path = "$"): ProjectionDifference[] {
  // why: This is the file-evidence comparison; reader objects have a separate literal field-order contract.
  if (path === "$") { before = fileOrderedCopy(before); after = fileOrderedCopy(after); }
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
  const references = projectionReferences();
  for (const [index, reference] of references.entries()) {
    const fixture = fixtures[index];
    if (!fixture || fixture.name !== reference.name) throw new Error("Reference fixture order changed");
    if (Buffer.byteLength(fixture.bytes) !== reference.original.bytes || createHash("sha256").update(fixture.bytes).digest("hex") !== reference.original.sha256) throw new Error(`Stale reference source: ${fixture.name}`);
    const saved = serializeProjection(reference.document);
    if (Buffer.byteLength(saved) !== reference.appSaved.bytes || createHash("sha256").update(saved).digest("hex") !== reference.appSaved.sha256) throw new Error(`Prototype file encoding differs from direct app save: ${fixture.name}`);
  }
  const projections: { candidate: SchemaCandidate; index: number; document: ProjectionBag; encoded: number; plainDifferences: ProjectionDifference[] }[] = [];
  for (const candidate of ["A", "B"] as const) {
    references.forEach((reference, index) => {
      const replica = fromDocument(reference.document, candidate);
      const second = createProjectionReplica(candidate, 11);
      try {
        const update = Y.encodeStateAsUpdate(replica.doc);
        Y.applyUpdate(second.doc, update);
        const vector = Y.encodeStateVector(second.doc);
        const document = toDocument(second.doc, candidate);
        if (Buffer.compare(vector, Y.encodeStateVector(second.doc)) !== 0) throw new Error("Projection wrote shared state");
        projections.push({ candidate, index, document, encoded: update.byteLength, plainDifferences: differences(reference.document, document) });
      } finally {
        replica.destroy();
        second.destroy();
      }
    });
  }
  return projections.map(projection => {
    const fixture = fixtures[projection.index];
    const reference = references[projection.index];
    if (!fixture || !reference) throw new Error("Missing projection fixture");
    const saved = serializeProjection(projection.document);
    const appSaved = reference.appSaved.full ?? fixture.bytes;
    assertProjectionBytes(fixture.name, appSaved, saved);
    return {
      candidate: projection.candidate, fixture: fixture.name, source: fixture.source,
      fileBytes: Buffer.byteLength(fixture.bytes), savedBytes: Buffer.byteLength(saved), encodedBytes: projection.encoded,
      byteIdentical: fixture.bytes === saved, appSaveIdentical: fixture.bytes === appSaved,
      sameAsAppSave: reference.appSaved.bytes === Buffer.byteLength(saved) && reference.appSaved.sha256 === createHash("sha256").update(saved).digest("hex"),
      ...(fixture.name === projectionExclusion.fixture ? { declaredExclusions: projectionExclusion.fields } : {}),
      originalDifference: firstByteDifference(fixture.bytes, saved),
      appSaveDifference: firstByteDifference(appSaved, saved),
      appNormalizations: differences(JSON.parse(fixture.bytes), JSON.parse(appSaved)),
      projectionDifferences: projection.plainDifferences,
      savedDifferences: differences(JSON.parse(appSaved), JSON.parse(saved))
    };
  });
}
