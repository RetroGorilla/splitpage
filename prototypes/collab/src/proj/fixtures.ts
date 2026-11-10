import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { projectionRepo } from "./reference.ts";
import { bag } from "./value.ts";
import type { ProjectionBag } from "./value.ts";

export interface ProjectionFixture {
  name: string;
  source: string;
  bytes: string;
}

function documents(value: unknown, path: string): { path: string; document: ProjectionBag }[] {
  if (!value || typeof value !== "object") return [];
  if (!Array.isArray(value) && Array.isArray((value as ProjectionBag).rows)) return [{ path, document: bag(value) }];
  return Object.entries(value).flatMap(([key, item]) => documents(item, `${path}/${key}`));
}

export function canonicalFixtures(): ProjectionFixture[] {
  const result: ProjectionFixture[] = [];
  const fixtureDir = join(projectionRepo, "src/test/fixtures");
  for (const name of readdirSync(fixtureDir).filter(name => name.endsWith(".splitpage")).sort()) {
    result.push({ name, source: `src/test/fixtures/${name}`, bytes: readFileSync(join(fixtureDir, name), "utf8") });
  }
  for (const source of ["src/seed-state.json", ...readdirSync(join(projectionRepo, "src/starters")).filter(name => name.endsWith(".json")).sort().map(name => `src/starters/${name}`)]) {
    result.push({ name: source, source, bytes: readFileSync(join(projectionRepo, source), "utf8") });
  }
  const goldenDir = join(fixtureDir, "golden");
  for (const file of readdirSync(goldenDir).filter(name => name.startsWith("merge-") || name === "migrate-golden.json").sort()) {
    const source = `src/test/fixtures/golden/${file}`;
    for (const entry of documents(JSON.parse(readFileSync(join(goldenDir, file), "utf8")), "")) {
      result.push({ name: `${file}${entry.path}`, source, bytes: JSON.stringify(entry.document, null, 2) });
    }
  }
  const supplement = "prototypes/collab/test/proj/supplement.splitpage";
  result.push({ name: "supplement.splitpage", source: supplement, bytes: readFileSync(join(projectionRepo, supplement), "utf8") });
  return result;
}
