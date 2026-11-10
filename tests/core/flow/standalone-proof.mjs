import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: node tests/core/flow/standalone-proof.mjs <pre-change-ref>");
const prior = execFileSync("git", ["show", baseline + ":src/core/flow/flow.ts"], { encoding: "utf8" });
const baselineFile = path => execFileSync("git", ["show", baseline + ":" + path], { encoding: "utf8" });
const hasBaselineFile = path => spawnSync("git", ["cat-file", "-e", baseline + ":" + path], { stdio: "ignore" }).status === 0;
const surface = baselineFile("src/features/writer/flow-surface.ts");
const marker = '    apply("remove-empty-heading", doc => {';
const start = surface.indexOf(marker), end = surface.indexOf("    }, before, document.activeElement === root);", start);
const coreEmpty = hasBaselineFile("src/core/flow/remove-empty-heading.ts");
if (!coreEmpty && (start < 0 || end < start)) throw new Error("Missing pre-change empty-heading implementation");
const body = surface.slice(start + marker.length, end);
const original = readFileSync("tests/core/flow/operations.test.ts", "utf8");
const run = original.slice(original.indexOf("function run("), original.indexOf("function ports("));
const legacyRun = run.replace("function run(", "function runBefore(").replaceAll("flow.", "beforeFlow.").replace("return removeEmptyHeading(", "return beforeEmptyHeading(");
const legacyEmpty = coreEmpty ? 'import { removeEmptyHeading as beforeEmptyHeading } from "../../../src/core/flow/.empty-before.ts";\n'
  : "function beforeEmptyHeading(doc, id, range, landing, flowPorts) { const ports = {flow: flowPorts}; const cellOf = row => flowPorts.cells(row.audioText); const {flowOf, replaceRange, headingPos, beatPos, caretAt} = beforeFlow;" + body + "\n}\n";
const proof = 'import * as beforeFlow from "../../../src/core/flow/.flow-before.ts";\n' + legacyEmpty + legacyRun + original.replace(
  '  assert.deepEqual(base, before, "input mutation");',
  '  assert.deepEqual(base, before, "input mutation");\n  assert.deepEqual(plain, runBefore(input, ports(false)), "recording-off differs from baseline");');
const rangeSource = readFileSync("tests/core/flow/range-operations.test.ts", "utf8");
const rangeRun = rangeSource.slice(rangeSource.indexOf("function runRange("), rangeSource.indexOf("function checkRange("))
  .replace("function runRange(", "function runRangeBefore(").replaceAll("flow.", "beforeFlow.")
  .replace("return replaceFlowMatches(", "return beforeReplaceFlowMatches(").replace("return setVisualForRange(", "return beforeSetVisualForRange(");
const rangeProof = 'import * as beforeFlow from "../../../src/core/flow/.flow-before.ts";\n'
  + 'import { replaceFlowMatches as beforeReplaceFlowMatches } from "../../../src/core/flow/.find-before.ts";\n'
  + 'import { setVisualForRange as beforeSetVisualForRange } from "../../../src/core/flow/.visual-before.ts";\n'
  + rangeRun + rangeSource.replace('from "./operations.test.ts"', 'from "./.before-proof.test.ts"')
    .replace('  assert.deepEqual(input.doc, before, "input mutation");',
      '  assert.deepEqual(input.doc, before, "input mutation");\n  assert.deepEqual(plain, runRangeBefore(input, ports(false)), "range recording-off differs from baseline");');
const oldFind = hasBaselineFile("src/core/flow/find-replace.ts") ? baselineFile("src/core/flow/find-replace.ts")
  : baselineFile("src/features/writer/flow-find.ts").replaceAll('"../../core/', '"../').replaceAll('"../flow/flow.ts"', '"./flow.ts"')
    .replace('"../common/writer-find.ts"', '"../../features/common/writer-find.ts"');
const contents = new Map([
  [resolve("src/core/flow/.flow-before.ts"), prior],
  [resolve("tests/core/flow/.before-proof.test.ts"), proof],
  [resolve("src/core/flow/.find-before.ts"), oldFind.replaceAll('"./flow.ts"', '"./.flow-before.ts"')],
  [resolve("src/core/flow/.visual-before.ts"), baselineFile("src/core/flow/visual.ts").replaceAll('"./flow.ts"', '"./.flow-before.ts"')],
  [resolve("tests/core/flow/.range-before-proof.test.ts"), rangeProof]
]);
if (coreEmpty) contents.set(resolve("src/core/flow/.empty-before.ts"), baselineFile("src/core/flow/remove-empty-heading.ts").replaceAll('"./flow.ts"', '"./.flow-before.ts"'));
const files = [...contents.keys()];
if (files.some(file => existsSync(file))) throw new Error("A standalone proof is already running");
try {
  for (const [file, content] of contents) writeFileSync(file, content);
  const result = spawnSync(process.execPath, ["--test", resolve("tests/core/flow/.range-before-proof.test.ts")], { encoding: "utf8", maxBuffer: 10_000_000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status ?? 1;
} finally { for (const file of files) if (existsSync(file)) unlinkSync(file); }
