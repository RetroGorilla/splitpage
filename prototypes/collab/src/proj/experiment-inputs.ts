import { writeFileSync } from "node:fs";
import { projectionConcurrentCaseName, runConcurrentProjections } from "./concurrency.ts";
import { largeProjectionFixture } from "./costs.ts";
import { projectionLimitCaseName, projectionLimitStates } from "./limits.ts";
import { projectionReferences } from "./reference.ts";
import type { ProjectionBag } from "./value.ts";
import { isProjectionEntry } from "./entry.ts";

export function projectionExperimentInputs(): { name: string; document: ProjectionBag }[] {
  const concurrent = runConcurrentProjections().map(result => ({ name: projectionConcurrentCaseName(result), document: result.documents[0] as ProjectionBag }));
  const limits = projectionLimitStates().map(result => ({ name: projectionLimitCaseName(result), document: result.document }));
  const long = projectionReferences().find(reference => reference.name === "src/starters/long-demo.json");
  if (!long) throw new Error("Missing long source");
  return [...concurrent, ...limits, { name: "cost/large", document: largeProjectionFixture(long.document) }];
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--write")) {
  const cases = projectionExperimentInputs();
  writeFileSync(new URL("../../test/proj/experiment-inputs.json", import.meta.url), '{"cases":[\n' + cases.map(value => JSON.stringify(value)).join(",\n") + "\n]}\n");
  console.log(`projection experiment inputs: ${cases.length}`);
}
