import { readFileSync } from "node:fs";
import { discover } from "./run-tests.mjs";
import { listRepoFiles, REPO } from "./source-scan.mjs";

const samples = new Map();
for (const line of readFileSync(0, "utf8").split(/\r?\n/)) {
  const marker = line.indexOf("FILE_TIMING ");
  if (marker < 0) continue;
  const [file, ms] = JSON.parse(line.slice(marker + "FILE_TIMING ".length));
  if (typeof file !== "string" || !Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid timing: ${line}`);
  samples.set(file, [...(samples.get(file) ?? []), ms]);
}
const files = discover(listRepoFiles(REPO)).groups.flatMap((entry) => entry.files).sort();
const missing = files.filter((file) => !samples.has(file));
if (missing.length) throw new Error(`Missing timings for ${missing.length} files: ${missing.join(", ")}`);
const weights = Object.fromEntries(files.map((file) => [file, Math.max(1, Math.round(samples.get(file).reduce((a, b) => a + b, 0) / samples.get(file).length))]));
console.log(JSON.stringify(weights, null, 2));
