import { fileOrderedCopy } from "../readers/output.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { bag, records } from "./value.ts";
import type { ProjectionBag } from "./value.ts";

export const projectionRepo = fileURLToPath(new URL("../../../../", import.meta.url));

export interface ProjectionReference {
  name: string;
  source: string;
  selection: string[];
  original: { bytes: number; sha256: string };
  document: ProjectionBag;
  appSaved: { bytes: number; sha256: string; full?: string };
  stableAppSave?: boolean;
  resaved?: string;
}

export function projectionReferences(file = "app-reference.json"): ProjectionReference[] {
  const manifest = JSON.parse(readFileSync(new URL(`../../test/proj/${file}`, import.meta.url), "utf8")) as { version: number; fixtures: ProjectionReference[] };
  if (manifest.version !== 1) throw new Error("Unsupported projection reference manifest");
  return manifest.fixtures;
}

export function assertProjectionInput(reference: ProjectionReference | undefined, document: ProjectionBag): asserts reference is ProjectionReference {
  if (!reference) throw new Error("Missing projection experiment reference");
  const text = JSON.stringify(fileOrderedCopy(document), null, 2);
  if (reference.original.bytes !== Buffer.byteLength(text) || reference.original.sha256 !== createHash("sha256").update(text).digest("hex")) {
    throw new Error(`Stale experiment input: ${reference.name}`);
  }
}

export function serializeProjection(document: ProjectionBag): string {
  const result = bag(fileOrderedCopy(document));
  for (const row of records(result.rows)) {
    if (Object.hasOwn(row, "imageRef") && row.imageRef === null) {
      delete row.imageRef;
      row.visualImage = null;
    }
  }
  return JSON.stringify(bag(result), null, 2);
}
