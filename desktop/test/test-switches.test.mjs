import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(here, "..", "main.ts"), "utf8");
const LINES = MAIN.split("\n");

let failed = 0;
for (const name of ["SPLITPAGE_TEST_DIALOGS", "SPLITPAGE_UPDATE_API"]) {
  const label = name + " is read only in test mode";
  try {
    const reads = LINES.filter((line) => line.includes("process.env." + name));
    assert.ok(reads.length > 0, "main.ts no longer reads " + name);
    for (const line of reads) assert.match(line, /\bTEST_MODE\b/, "read outside TEST_MODE: " + line.trim());
    assert.ok(MAIN.indexOf("const TEST_MODE =") < MAIN.indexOf("process.env." + name), "TEST_MODE is defined after " + name + " is read");
    console.log("ok   " + label);
  } catch (e) {
    failed++;
    console.log("FAIL " + label + "\n     " + (e && e.message || e));
  }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (2)");
