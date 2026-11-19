import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { oldAdapterFiles, partitionRootTests, TREE_INVENTORIES } from "./old-adapter-tests.mjs";
import { assignShards, discover, rootTestNeedsChromium } from "./run-tests.mjs";
import { loadGraph } from "./dep-report.mjs";
import { REPO, listRepoFiles } from "./source-scan.mjs";

const { jobs } = parse(readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8"));
const found = discover(listRepoFiles()).groups;
const all = found.flatMap((entry) => entry.files).sort();
const suites = partitionRootTests(found, oldAdapterFiles().isOldTest);
const covered = [];
for (const [suite, job] of [["always", jobs.tests], ["old-adapter", jobs["old-adapter-tests"]]]) {
  const count = job.strategy.matrix.shard.length;
  assert.deepEqual(job.strategy.matrix.shard, Array.from({ length: count }, (_, index) => index + 1));
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.needs, "changes");
  assert.equal(job.if, `needs.changes.outputs.${suite === "always" ? "root_due" : "old_adapter"} == 'true'`);
  assert.deepEqual(job.steps.find((step) => step.uses === "./.github/actions/root-test-setup")?.with, {
    shard: `\${{ matrix.shard }}/${count}`, suite
  });
  assert.deepEqual(job.steps.filter((s) => s.run?.includes("npm run test:all")).map((s) => s.run), [
    `npm run test:all -- --shard "\${{ matrix.shard }}/${count}" --suite=${suite}`
  ]);
  const shards = assignShards(suites[suite], count);
  assert.ok(shards.every((files) => files.length > 0));
  covered.push(...shards.flat());
}
assert.deepEqual(covered.sort(), all, "each discovered test must run in exactly one of the two workflow matrices");
const always = suites.always.flatMap((entry) => entry.files);
for (const path of [...TREE_INVENTORIES, ...all.filter((file) => file.startsWith("tests/adapters/collab/native/"))]) {
  assert.ok(always.includes(path), `${path} must be in the always-run matrix`);
}
const old = suites["old-adapter"].flatMap((entry) => entry.files);
for (const path of [
  "tests/adapters/collab/formatting-invariant.test.ts",
  "tests/adapters/collab/text-generator.test.ts",
  "tests/adapters/collab/trial-replica.test.ts",
  "tests/application/session/shared-session-replica.test.ts",
  "tests/features/writer/buffer-binding.test.ts",
  "src/test/shared-split-records-typed-comments-app.test.mjs"
]) assert.ok(old.includes(path), `${path} must be in the old-adapter matrix`);
assert.deepEqual(jobs.checks.steps.filter((s) => s.run === "node tools/test-ci-old-adapter-shards.mjs").map((s) => s.if), [undefined]);
const nightly = parse(readFileSync(join(REPO, ".github/workflows/nightly.yml"), "utf8")).jobs["root-tests"];
const nightlyCount = nightly.strategy.matrix.shard.length;
assert.equal(nightly.if, undefined);
assert.deepEqual(nightly.strategy.matrix.shard, Array.from({ length: nightlyCount }, (_, index) => index + 1));
assert.deepEqual(nightly.steps.filter((s) => s.run?.includes("npm run test:all")).map((s) => s.run), [
  `npm run test:all -- --shard "\${{ matrix.shard }}/${nightlyCount}"`
]);
assert.deepEqual(assignShards(found, nightlyCount).flat().sort(), all);
assert.deepEqual(nightly.steps.find((step) => step.uses === "./.github/actions/root-test-setup")?.with, {
  shard: `\${{ matrix.shard }}/${nightlyCount}`
});
const browserUsers = new Set(["tests/adapters/formats/fixtures/inspect-script-print.mjs"]);
const modules = loadGraph();
for (const dependency of browserUsers) {
  for (const [path, { edges }] of modules) {
    if (edges.some((edge) => edge.target === dependency)) browserUsers.add(path);
  }
}
assert.deepEqual(all.filter(rootTestNeedsChromium), all.filter((path) => browserUsers.has(path)));
console.log(`Root test partition covers ${all.length} files once (${always.length} always, ${old.length} old adapter)`);
