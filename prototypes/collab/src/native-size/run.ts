import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSizeFixture } from "./fixture.ts";
import type { SizeFixture } from "./fixture.ts";
import { measureSize, verifyStoredScript } from "./measure.ts";

type SizeManifest = Omit<SizeFixture, "state" | "behind"> & { target: number; stored: number };
const [mode, value, option] = process.argv.slice(2);
assert(value, "Pass target MB (build, gc-off, faithful) or a scratch directory (measure)");

if (mode === "measure") {
  const read = (file: string): Buffer => readFileSync(join(value, file));
  const manifest = JSON.parse(read("fixture.json").toString("utf8")) as SizeManifest;
  const fixture: SizeFixture = { ...manifest, state: read("state.yjs"), behind: {
    day: read("day.yjs"), month: read("month.yjs"), history: read("history.yjs")
  } };
  assert.equal(fixture.state.length, manifest.stored);
  const repeats = Number(option ?? 5);
  assert(Number.isInteger(repeats) && repeats >= 3 && repeats <= 9);
  console.log(JSON.stringify({ ...manifest, ...await measureSize(fixture, repeats) }));
} else {
  const target = Number(value);
  assert(target === 0.5 || target === 15, "Pass target MB (0.5 or 15)");
  assert(mode === "build" || mode === "gc-off" || mode === "faithful", "Unknown measurement mode");
  assert(option, "Pass a scratch directory for a build or the measured day count for a replay");
  const days = Number(option);
  if (mode !== "build") assert(Number.isInteger(days) && days >= 31, "Pass the measured build's day count");
  const gc = mode !== "gc-off";
  const fixture = buildSizeFixture(target, mode === "build" ? {} : { days, gc, faithful: mode === "faithful" });
  verifyStoredScript(fixture, gc);
  const manifest: SizeManifest = { target, stored: fixture.state.length, days: fixture.days,
    expected: fixture.expected, middle: fixture.middle, buildSeconds: fixture.buildSeconds };
  if (mode === "build") {
    mkdirSync(option, { recursive: true });
    writeFileSync(join(option, "state.yjs"), fixture.state);
    for (const [age, state] of Object.entries(fixture.behind)) writeFileSync(join(option, `${age}.yjs`), state);
    writeFileSync(join(option, "fixture.json"), JSON.stringify(manifest));
  }
  console.log(JSON.stringify(manifest));
}
