import { writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { log } from "node:console";
import { buildScriptPrintPage } from "../../../../src/adapters/formats/script-print.ts";
import { scriptFixture } from "./script-print-fixture.mjs";

for (const kind of ["rich", "empty", "long"]) {
  const path = fileURLToPath(new URL(`_script-print-${kind}.html`, import.meta.url));
  writeFileSync(path, buildScriptPrintPage(scriptFixture(kind).input));
  log(path);
}
