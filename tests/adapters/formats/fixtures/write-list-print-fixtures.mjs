import { writeFileSync } from "node:fs";
import { URL } from "node:url";
import { buildPackingListPrintPage, buildShotListPrintPage, buildScriptWithListsPrintPage } from "../../../../src/adapters/formats/list-print.ts";
import { listFixture } from "./list-print-fixture.mjs";

for (const kind of ["rich", "empty", "long"]) {
  const { input } = listFixture(kind);
  for (const cat of ["gear", "prop"]) writeFileSync(new URL(`_list-print-${cat}-${kind}.html`, import.meta.url), buildPackingListPrintPage(input, cat));
  writeFileSync(new URL(`_list-print-shots-${kind}.html`, import.meta.url), buildShotListPrintPage(input));
  writeFileSync(new URL(`_list-print-script-${kind}.html`, import.meta.url), buildScriptWithListsPrintPage(input));
}
for (const [filter, group] of [["flagged", "location"], ["shot", "person"], ["unshot", "scene"]]) {
  writeFileSync(new URL(`_list-print-${filter}-${group}.html`, import.meta.url), buildShotListPrintPage(listFixture().input, { filter, group }));
}
