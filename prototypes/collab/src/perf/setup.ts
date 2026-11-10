import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isProjectionEntry } from "../proj/entry.ts";
import { perfCases } from "./measure.ts";
import { historyMix } from "./history.ts";

function perfSourceFiles(): string[] {
  const files = readdirSync(new URL("./", import.meta.url)).filter(file => file.endsWith(".ts")).sort();
  files.push(...["../schema.ts", "../model.ts", "../marks/commands.ts", "../structure.ts", "../../package-lock.json"]);
  files.push(...readdirSync(new URL("../proj/", import.meta.url)).filter(file => file.endsWith(".ts")).sort().map(file => `../proj/${file}`));
  return files;
}

export function perfSourceDigest(): string {
  return createHash("sha256").update(perfSourceFiles().map(file => `${file}\n${readFileSync(new URL(file, import.meta.url), "utf8")}`).join("\n")).digest("hex");
}

export interface PerfTimedSourceAudit {
  sourceHead: string;
  sourceDigest: string;
  reason: string;
  files: Record<string, string>;
  metadataRedactions?: Record<string, string>;
}

export function validateTimedSource(sourceHead: string, sourceDigest: string, audit?: PerfTimedSourceAudit): void {
  if (!audit && sourceDigest === perfSourceDigest()) return;
  const snapshot = audit ?? JSON.parse(readFileSync(new URL("timed-source.json", import.meta.url), "utf8")) as PerfTimedSourceAudit;
  assert.equal(sourceHead, snapshot.sourceHead);
  assert.equal(sourceDigest, snapshot.sourceDigest);
  const files = perfSourceFiles().filter(file => !["setup.ts", "report.ts", "timing-report.ts", "privacy.ts"].includes(file));
  assert.deepEqual(Object.keys(snapshot.files), files);
  assert.ok(Object.keys(snapshot.metadataRedactions ?? {}).every(file => file === "conditions.ts"));
  for (const file of files) {
    let source = readFileSync(new URL(file, import.meta.url), "utf8");
    if (file === "conditions.ts" && snapshot.metadataRedactions?.[file]) {
      assert.equal(createHash("sha256").update(source).digest("hex"), snapshot.metadataRedactions[file]);
      for (const [redacted, original] of [["cpus, freemem, release", "cpus, freemem, hostname, release"], ["return { cpu: ", "return { hostname: hostname(), cpu: "]]) {
        assert.ok(redacted && original);
        assert.equal(source.split(redacted).length, 2);
        source = source.replace(redacted, original);
      }
    }
    assert.equal(createHash("sha256").update(source).digest("hex"), snapshot.files[file], `Timed implementation changed: ${file}`);
  }
}

export function plannedPerfSetup() {
  return { version: 1, status: "not measured", reason: "Earlier game-session attempts are void. Coordinator permits one guarded set after the non-measurement PR is opened, with a lighter game running; state each accepted run's background load.",
    sourceDigest: perfSourceDigest(), node: "v24.22.1", yjs: "13.6.33", rounds: 5, warmup: 3, samplesPerCase: 11, historyCycles: 500, historyMix,
    cases: [...perfCases], locks: ["perf", "smoke"], minFreeMemoryBytes: 3 * 1024 ** 3, maxCpuBusyPercent: 35, maxConsecutiveRefusals: 3, retryDelayMs: 30000,
    rule: "max(base range, 15% of base median, 0.5 ms); candidate differences must exceed the rule in both directions; open floor 5 ms; heap 3% and 0.25 MiB; bytes exact",
    omitted: ["paint", "app derivations", "real network", "server receipts", "blobs", "full structural and mark integration"] };
}

export function validatePerfSetup(value: ReturnType<typeof plannedPerfSetup>): void {
  assert.deepEqual(value, plannedPerfSetup());
}

if (isProjectionEntry(import.meta.url)) {
  if (process.argv.includes("--write")) writeFileSync(new URL("setup.json", import.meta.url), JSON.stringify(plannedPerfSetup(), null, 2) + "\n");
  if (process.argv.includes("--check")) validatePerfSetup(JSON.parse(readFileSync(new URL("setup.json", import.meta.url), "utf8")) as ReturnType<typeof plannedPerfSetup>);
}
