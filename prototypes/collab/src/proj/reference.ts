import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bag, copy, records } from "./value.ts";
import type { ProjectionBag } from "./value.ts";

export const projectionRepo = fileURLToPath(new URL("../../../../", import.meta.url));

export interface ProjectionReference {
  name: string;
  source: string;
  selection: string[];
  original: { bytes: number; sha256: string };
  document: ProjectionBag;
  appSaved: { bytes: number; sha256: string; full?: string };
}

export function projectionReferences(): ProjectionReference[] {
  const manifest = JSON.parse(readFileSync(new URL("../../test/proj/app-reference.json", import.meta.url), "utf8")) as { version: number; fixtures: ProjectionReference[] };
  if (manifest.version !== 1) throw new Error("Unsupported projection reference manifest");
  return manifest.fixtures;
}

export function serializeProjection(document: ProjectionBag): string {
  const result = copy(document);
  for (const row of records(result.rows)) {
    if (Object.hasOwn(row, "imageRef") && row.imageRef === null) {
      delete row.imageRef;
      row.visualImage = null;
    }
  }
  return JSON.stringify(bag(result), null, 2);
}
