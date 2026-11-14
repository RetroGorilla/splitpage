import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fixtures, growth, saveCheckpoint, updatesFor } from "./run.mjs";

assert.equal(process.versions.node, "24.22.1");
assert.equal(execFileSync("git", ["status", "--porcelain", "--", "src", "shared", "package.json", "package-lock.json",
  "tests/collab/fixtures/projection-reference.json"], { encoding: "utf8" }).trim(), "");
const filename = process.argv[2];
assert.ok(filename, "Supply a local checkpoint filename");
const trees = execFileSync("git", ["rev-parse", "HEAD:src", "HEAD:shared", "HEAD:package-lock.json",
  "HEAD:tests/collab/fixtures/projection-reference.json"], { encoding: "utf8" }).trim();
const checkpoint = existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) : {
  trees, result: { node: process.version, arch: process.arch }, states: [], streams: {}
};
assert.equal(checkpoint.trees, trees);
assert.equal(checkpoint.result.node, process.version);
assert.equal(checkpoint.result.arch, process.arch);
for (const source of fixtures()) {
  if (checkpoint.states.some(row => row.name === source.name)) continue;
  process.stderr.write(`Preparing ${source.name}\n`);
  const row = growth(source), stream = updatesFor(row.fresh, source.document.rows[0].id);
  const encoded = saveCheckpoint({ states: [row], streams: { [source.name]: stream } });
  checkpoint.states.push(encoded.states[0]);
  checkpoint.streams[source.name] = encoded.streams[source.name];
  writeFileSync(filename, JSON.stringify(checkpoint));
  process.stderr.write(`Saved ${source.name}: fresh ${row.fresh.length}, edited ${row.edited.length}\n`);
}
