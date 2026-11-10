import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: node tests/core/flow/standalone-proof.mjs <pre-change-ref>");
const prior = execFileSync("git", ["show", baseline + ":src/core/flow/flow.ts"], { encoding: "utf8" });
const surface = execFileSync("git", ["show", baseline + ":src/features/writer/flow-surface.ts"], { encoding: "utf8" });
const marker = '    apply("remove-empty-heading", doc => {';
const start = surface.indexOf(marker), end = surface.indexOf("    }, before, document.activeElement === root);", start);
if (start < 0 || end < start) throw new Error("Missing pre-change empty-heading implementation");
const body = surface.slice(start + marker.length, end);
const original = readFileSync("tests/core/flow/operations.test.ts", "utf8");
const run = original.slice(original.indexOf("function run("), original.indexOf("function ports("));
const legacyRun = run.replace("function run(", "function runBefore(").replaceAll("flow.", "beforeFlow.").replace("return removeEmptyHeading(", "return beforeEmptyHeading(");
const legacyEmpty = "function beforeEmptyHeading(doc, id, range, landing, flowPorts) { const ports = {flow: flowPorts}; const cellOf = row => flowPorts.cells(row.audioText); const {flowOf, replaceRange, headingPos, beatPos, caretAt} = beforeFlow;" + body + "\n}\n";
const proof = 'import * as beforeFlow from "../../../src/core/flow/.flow-before.ts";\n' + legacyEmpty + legacyRun + original.replace(
  '  assert.deepEqual(base, before, "input mutation");',
  '  assert.deepEqual(base, before, "input mutation");\n  assert.deepEqual(plain, runBefore(input, ports(false)), "recording-off differs from baseline");');
const files = [resolve("src/core/flow/.flow-before.ts"), resolve("tests/core/flow/.before-proof.test.ts")];
if (files.some(file => existsSync(file))) throw new Error("A standalone proof is already running");
try {
  writeFileSync(files[0], prior);
  writeFileSync(files[1], proof);
  const result = spawnSync(process.execPath, ["--test", files[1]], { encoding: "utf8", maxBuffer: 10_000_000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status ?? 1;
} finally { for (const file of files) if (existsSync(file)) unlinkSync(file); }
