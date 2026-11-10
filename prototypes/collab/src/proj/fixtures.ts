import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectionReferences, projectionRepo } from "./reference.ts";
import type { ProjectionBag } from "./value.ts";

export interface ProjectionFixture {
  name: string;
  source: string;
  bytes: string;
}

export function canonicalFixtures(): ProjectionFixture[] {
  return projectionReferences().map(reference => {
    const source = readFileSync(join(projectionRepo, reference.source), "utf8");
    let value: unknown = reference.selection.length ? JSON.parse(source) : null;
    for (const key of reference.selection) value = (value as ProjectionBag)[key];
    return { name: reference.name, source: reference.source, bytes: reference.selection.length ? JSON.stringify(value, null, 2) : source };
  });
}
