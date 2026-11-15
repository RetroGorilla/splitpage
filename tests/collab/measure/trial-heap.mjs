import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import { fixtures, open, workload } from "./run.mjs";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { encodeSharedState, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { enterSharedDocument } from "../../../src/core/migrate.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { startSharedTrialReplica } from "../../../src/adapters/collab/trial-replica.ts";

const MIB = 1024 ** 2;
const root = new URL("../../../", import.meta.url);
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
assert.equal(typeof globalThis.gc, "function", "Run with node --expose-gc");
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "Commit the measured code first");
const revision = git("rev-parse", "HEAD");
assert.match(revision, /^[a-f0-9]{40}$/);
const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
const median = values => [...values].sort((a, b) => a - b)[2];

function states(fixture) {
  const handle = open();
  try {
    hydrateSharedDocument(handle, enterSharedDocument(globalThis.structuredClone(fixture.document)));
    const fresh = encodeSharedState(handle);
    workload(handle, fixture.document);
    return { fresh, edited: encodeSharedState(handle) };
  } finally { destroySharedDocument(handle); }
}

function once(fixture, state) {
  const start = heap(), plain = globalThis.structuredClone(fixture.document), afterPlain = heap();
  const handle = open(state);
  let projector, trial;
  try {
    const afterLive = heap();
    projector = createSharedIncrementalProjector(handle);
    const afterMirror = heap();
    trial = startSharedTrialReplica(handle);
    const afterTrial = heap();
    assert.ok(plain.rows.length);
    return { plain: afterPlain - start, live: afterLive - afterPlain, mirror: afterMirror - afterLive, trial: afterTrial - afterMirror };
  } finally { trial?.dispose(); projector?.dispose(); destroySharedDocument(handle); }
}

const result = {
  revision, node: process.version, flags: process.execArgv, rounds: 5,
  metric: "Node adapter heapUsed deltas after two collections; excludes external backing storage; not browser figures",
  sampleUnits: "bytes", medianUnits: "MiB", rows: []
};
const output = new URL("./trial-heap.json", import.meta.url);
for (const fixture of fixtures()) {
  const both = states(fixture);
  for (const phase of ["fresh", "edited"]) {
    const samples = Array.from({ length: 5 }, () => once(fixture, both[phase]));
    const medians = Object.fromEntries(["plain", "live", "mirror", "trial"].map(key => [key, median(samples.map(sample => sample[key])) / MIB]));
    medians.withoutTrial = medians.live + medians.mirror;
    medians.session = medians.withoutTrial + medians.trial;
    result.rows.push({ script: fixture.name, state: phase, bytes: both[phase].byteLength, samples, median: medians });
    writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ script: fixture.name, state: phase, median: medians }) + "\n");
  }
}
assert.equal(git("rev-parse", "HEAD"), revision);
