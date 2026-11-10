import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lifetimeSources } from "./source.ts";
import { currentStatusHash, statusTimingChanges, validateStatusTimingChanges } from "../../marks/status-source-audit.ts";

interface LifetimeTimedArchive {
  timedHead: string;
  source: ReturnType<typeof lifetimeSources>;
  defaultDataSha256: string;
  timingsSha256: string;
  files: Record<string, string>;
}

export function readLifetimeTimedArchive(): LifetimeTimedArchive {
  return JSON.parse(readFileSync(new URL("timed-implementation.json", import.meta.url), "utf8")) as LifetimeTimedArchive;
}

export function lifetimeDataHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function section(text: string, start: string, end: string): string {
  assert.equal(text.split(start).length, 2); assert.equal(text.split(end).length, 2);
  const begin = text.indexOf(start), finish = text.indexOf(end, begin); assert.ok(finish > begin);
  return text.slice(begin, finish);
}

export function validateLifetimeCharacterSource(original: Record<string, string>, current: Record<string, string>): void {
  for (const [file, text] of Object.entries(original)) {
    const now = current[file]; assert.ok(now !== undefined, `Missing timed source ${file}`);
    if (file === "report.ts" || file === "workload.ts") continue;
    if (file === "projector.ts") {
      const declared = statusTimingChanges().files.find(change => change.path === "src/perf/lifetime/projector.ts"); assert.ok(declared);
      assert.equal(createHash("sha256").update(text).digest("hex"), declared.before);
      assert.equal(createHash("sha256").update(now).digest("hex"), currentStatusHash(declared.path), "Changed sampled projector work");
    } else if (file === "record.ts") {
      assert.equal(now.replace('import { validateLifetimeTimingSource } from "./audit.ts";\n', "")
        .replace("validateLifetimeTimingSource(value.source, counts.source);", "assert.deepEqual(value.source, counts.source);"), text, "Changed timing driver or guards");
    } else assert.equal(now, text, `Changed timed dependency ${file}`);
  }
  const oldWorkload = original["workload.ts"], newWorkload = current["workload.ts"]; assert.ok(oldWorkload && newWorkload);
  assert.equal(section(newWorkload, "export function canonicalLifetimeSource()", "\nfunction blockSource"), section(oldWorkload, "export function canonicalLifetimeSource()", "\nfunction blockSource"));
}

export function validateLifetimeTimingSource(recorded: ReturnType<typeof lifetimeSources>, current: ReturnType<typeof lifetimeSources>): void {
  if (recorded.sha256 === current.sha256) { assert.deepEqual(recorded, current); return; }
  const archive = readLifetimeTimedArchive(); assert.deepEqual(recorded, archive.source);
  assert.equal(recorded.sha256, lifetimeDataHash({ files: recorded.files, dependencies: recorded.dependencies, fixture: recorded.fixture }));
  assert.deepEqual(Object.keys(archive.files), Object.keys(recorded.files));
  for (const [file, text] of Object.entries(archive.files)) assert.equal(createHash("sha256").update(text).digest("hex"), recorded.files[file]);
  validateStatusTimingChanges();
  assert.equal(recorded.dependencies, statusTimingChanges().dependencies.before);
  const changes = statusTimingChanges();
  assert.equal(current.dependencies, changes.reviewDependencies?.after ?? changes.dependencies.after); assert.equal(current.fixture, recorded.fixture);
  assert.deepEqual(current, lifetimeSources());
  const files = Object.fromEntries(Object.keys(current.files).map(file => [file, readFileSync(new URL(file, import.meta.url), "utf8")]));
  validateLifetimeCharacterSource(archive.files, files);
  assert.equal(createHash("sha256").update(readFileSync(new URL("timings.json", import.meta.url))).digest("hex"), archive.timingsSha256);
}
