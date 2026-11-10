import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProjectionEntry } from "../proj/entry.ts";
import type { collectStructuralCounts } from "./counts-entry.ts";
import { perfSourceDigest } from "./setup.ts";
import { perfFixtures } from "./fixtures.ts";

export interface PerfStructuralEvidence {
  version: number;
  sourceDigest: string;
  timingStatus: string;
  instrumentation: { source: string; sha256: string }[];
  data: ReturnType<typeof collectStructuralCounts>;
}

export async function structuralCounts(): Promise<PerfStructuralEvidence> {
  const directory = await mkdtemp(join(tmpdir(), "perf-counts-"));
  assert.ok(directory.startsWith(join(tmpdir(), "perf-counts-")), "Count directory escaped its temporary root");
  const instrumentation: PerfStructuralEvidence["instrumentation"] = [];
  try {
    const result = await build({ entryPoints: [fileURLToPath(new URL("counts-entry.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "esm", target: "es2023",
      alias: { yjs: fileURLToPath(new URL("../../node_modules/yjs/src/index.js", import.meta.url)) },
      plugins: [{ name: "count-pinned-public-position-traversals", setup(builder) {
        builder.onLoad({ filter: /[\\/]yjs[\\/]src[\\/]utils[\\/](RelativePosition|StructStore)\.js$/ }, async args => {
          let source = await readFile(args.path, "utf8");
          instrumentation.push({ source: args.path.split(/[\\/]/).slice(-4).join("/"), sha256: createHash("sha256").update(source).digest("hex") });
          const needles = args.path.endsWith("RelativePosition.js") ? [
            ["while (t !== null) {", "relativeItems"], ["while (n !== null) {", "absoluteItems"]
          ] : [["let mid = structs[right]", "storeProbes"], ["mid = structs[midindex]", "storeProbes"]];
          for (const [needle, counter] of needles) {
            assert.ok(needle && counter);
            assert.equal(source.split(needle).length, 2, `Pinned traversal changed: ${needle}`);
            const increment = `;if(globalThis.perfTraversal)globalThis.perfTraversal.${counter}++;`;
            source = source.replace(needle, needle + increment);
          }
          return { contents: source, loader: "js" };
        });
      } }] });
    const text = result.outputFiles?.[0]?.text;
    if (!text || instrumentation.length !== 2) throw new Error("Missing pinned Yjs traversal instrumentation");
    const path = join(directory, "counts.mjs");
    await writeFile(path, text);
    const fixtures = join(directory, "fixtures.json");
    await writeFile(fixtures, JSON.stringify(perfFixtures()));
    const data = JSON.parse(execFileSync(process.execPath, [path, fixtures], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 ** 2 })) as ReturnType<typeof collectStructuralCounts>;
    assert.deepEqual(data.controls.map(control => [control.candidate, control.capture.relativeItems, control.lookup.absoluteItems, control.lookup.relativeItems, control.lookup.projectedSpans, control.lookup.storeProbes]), [["A", 8, 3, 4, 2, 6], ["B", 2, 0, 1, 1, 8]]);
    return { version: 1, sourceDigest: perfSourceDigest(), timingStatus: "not measured; deterministic structural counts only", instrumentation: instrumentation.sort((a, b) => a.source.localeCompare(b.source)), data };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--write")) await writeFile(new URL("structural-results.json", import.meta.url), JSON.stringify(await structuralCounts(), null, 2) + "\n");
