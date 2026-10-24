import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestTargets, readLoadManifests } from "./load-manifests.ts";
import { loadEachAlone, NOTHING_STARTED } from "./load-order-support.ts";
import type { LoadReport } from "./load-order-support.ts";

const manifests = readLoadManifests();
let pending: Promise<LoadReport[]> | undefined;

function reports(): Promise<LoadReport[]> {
  pending ??= loadEachAlone(manifests.flatMap(manifestTargets));
  return pending;
}

for (const manifest of manifests) {
  test("load-only: " + manifest.area + " does not configure a bridge or start an owner", { timeout: 600_000 }, async () => {
    const targets = new Set(manifestTargets(manifest));
    const own = (await reports()).filter((report) => targets.has(report.target));
    assert.equal(own.length, manifest.expectedLoads, "every declared target was imported in a fresh process");
    const offenders = own
      .filter((report) => report.error !== null || report.calls.length || JSON.stringify(report.owners) !== JSON.stringify(NOTHING_STARTED))
      .map((report) => ({ target: report.target, error: report.error?.split("\n")[0] ?? null, calls: report.calls.map((call) => call.from + " -> " + call.file + "#" + call.name), owners: report.owners }));
    assert.deepEqual(offenders, []);
  });
}
