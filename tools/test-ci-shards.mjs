import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { loadGraph } from "./dep-report.mjs";
import { assignShards, discover, rootTestNeedsChromium, unweightedFiles } from "./run-tests.mjs";

const workflow = parse(readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8"));
const { changes, checks, tests, gate } = workflow.jobs;
const rootShards = tests.strategy.matrix.shard;
const shardCount = rootShards.length;
const files = listRepoFiles(REPO);
const found = discover(files).groups;
const discovered = found.flatMap((entry) => entry.files).sort();
for (const count of [3, 4, shardCount]) assert.deepEqual(assignShards(found, count).flat().sort(), discovered);
assert.ok(assignShards(found, shardCount).every((files) => files.length > 0));
const smoke = workflow.jobs["desktop-smoke"];
assert.equal(smoke.needs, "changes");
assert.equal(smoke["runs-on"], "ubuntu-latest");
assert.equal(smoke["timeout-minutes"], 90);
assert.equal(smoke.if, "needs.changes.outputs.desktop == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(changes.outputs.desktop, "${{ steps.classify.outputs.desktop }}");
assert.equal(checks.steps.find((s) => s.run === "node tools/build-preload.mjs && node tools/check-preload.mjs").if, undefined);
for (const s of checks.steps.filter((s) => /^node build\.mjs|playwright@/.test(s.run ?? "") || s.run?.includes("playwright@"))) {
  assert.equal(s.if, "needs.changes.outputs.app == 'true'");
}
assert.deepEqual(rootShards, Array.from({ length: shardCount }, (_, index) => index + 1));
assert.equal(shardCount, 8);
assert.equal(tests.name, `Tests (\${{ matrix.shard }}/${shardCount})`);
assert.equal(tests.strategy["fail-fast"], false);
assert.equal(tests.needs, "changes");
assert.equal(tests.if, "needs.changes.outputs.root_due == 'true'");
assert.equal(tests["runs-on"], checks["runs-on"]);
assert.equal(tests["runs-on"], changes["runs-on"]);
assert.equal(checks.steps.some((s) => s.run?.includes("npm run test:all")), false);
assert.equal(tests.steps.filter((s) => s.run?.includes("npm run test:all")).length, 1);
assert.equal(tests.steps.find((s) => s.run?.includes("npm run test:all")).run, `npm run test:all -- --shard "\${{ matrix.shard }}/${shardCount}"`);
const setup = parse(readFileSync(join(REPO, ".github/actions/root-test-setup/action.yml"), "utf8")).runs.steps;
assert.ok(setup.some((s) => s.run === "node build.mjs"));
assert.ok(setup.some((s) => s.run === "git diff --exit-code -- sw.js"));
const nightly = parse(readFileSync(join(REPO, ".github/workflows/nightly.yml"), "utf8"));
const nightlyRoot = nightly.jobs["root-tests"];
const nightlyCount = nightlyRoot.strategy.matrix.shard.length;
assert.equal(nightlyRoot.if, undefined);
assert.ok(assignShards(found, nightlyCount).every((files) => files.length > 0));
assert.deepEqual(tests.steps.find((step) => step.uses === "./.github/actions/root-test-setup")?.with, {
  shard: `\${{ matrix.shard }}/${shardCount}`
});
assert.deepEqual(nightlyRoot.strategy.matrix.shard, Array.from({ length: nightlyCount }, (_, index) => index + 1));
assert.deepEqual(nightlyRoot.steps.filter((s) => s.run?.includes("npm run test:all")).map((s) => s.run), [
  `npm run test:all -- --shard "\${{ matrix.shard }}/${nightlyCount}"`
]);
assert.deepEqual(assignShards(found, nightlyCount).flat().sort(), discovered);
assert.deepEqual(nightlyRoot.steps.find((step) => step.uses === "./.github/actions/root-test-setup")?.with, {
  shard: `\${{ matrix.shard }}/${nightlyCount}`
});
const browserUsers = new Set(["tests/adapters/formats/fixtures/inspect-script-print.mjs"]);
const modules = loadGraph();
for (const dependency of browserUsers) {
  for (const [path, { edges }] of modules) {
    if (edges.some((edge) => edge.target === dependency)) browserUsers.add(path);
  }
}
assert.deepEqual(discovered.filter(rootTestNeedsChromium), discovered.filter((path) => browserUsers.has(path)));
const unweighted = "tests/ci/unweighted-probe.test.ts";
const withUnweighted = discover([...files, unweighted]).groups;
assert.deepEqual(unweightedFiles([unweighted]), [unweighted]);
assert.ok(discovered.includes("tests/application/commit-time-writers.test.ts"));
for (const count of [shardCount, nightlyCount]) {
  assert.deepEqual(assignShards(withUnweighted, count).flat().sort(), [...discovered, unweighted].sort());
}
const fastBaselineJob = nightly.jobs["mutants-fast-baseline"];
const fastJob = nightly.jobs["mutants-fast"];
const fastReport = nightly.jobs["mutants-fast-report"];
for (const job of [fastBaselineJob, fastJob]) {
  assert.equal(job.needs, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job["runs-on"], nightly.jobs.suites["runs-on"]);
  assert.equal(job["timeout-minutes"], 30);
}
assert.deepEqual(fastJob.strategy.matrix.shard, [1, 2, 3, 4, 5, 6]);
assert.equal(fastJob.strategy["fail-fast"], false);
assert.deepEqual(fastBaselineJob.steps.slice(0, 3), fastJob.steps.slice(0, 3));
assert.equal(fastBaselineJob.steps.length, 4);
const fastBaselineRun = fastBaselineJob.steps[3].run;
assert.equal(fastBaselineRun, 'node tools/mutants.mjs tests/collab/*-mutants.json --baseline-only --baseline-timeout 1500\n');
const fastMutants = fastJob.steps.find((s) => s.run?.includes("tools/mutants.mjs")).run;
assert.equal(fastMutants, 'node tools/mutants.mjs tests/collab/*-mutants.json --shard "${{ matrix.shard }}/6" --concurrency 4 --no-baseline --fail-on-survivor\n');
assert.deepEqual(fastReport.needs, ["mutants-fast-baseline", "mutants-fast"]);
assert.equal(fastReport.if, "failure()");
assert.deepEqual(gate.needs, ["changes", "checks", "tests", "desktop-smoke"]);
assert.equal(gate.if, "always()");
assert.deepEqual(gate.permissions, { actions: "read" });
const step = gate.steps[0];
const individual = gate.steps[1];
assert.equal(individual.if, "needs.changes.outputs.root_due == 'true'");
assert.deepEqual(individual.env, {
  GH_TOKEN: "${{ github.token }}",
  ROOT_TESTS: "${{ needs.changes.outputs.root_due }}",
  ROOT_SHARDS: String(shardCount)
});
assert.equal(step.env.SMOKE, "${{ needs.desktop-smoke.result }}");
assert.equal(step.env.DESKTOP, "${{ needs.changes.outputs.desktop }}");
assert.equal(step.env.TESTS, "${{ needs.tests.result }}");
assert.equal(step.env.CHECKS, "${{ needs.checks.result }}");
assert.equal(step.env.CHANGES, "${{ needs.changes.result }}");
assert.equal(step.env.CODE, "${{ needs.changes.outputs.code }}");
assert.equal(step.env.ROOT_DUE, "${{ needs.changes.outputs.root_due }}");
assert.equal(changes.outputs.root_due, "${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') || (steps.classify.outputs.code == 'true' && steps.tested.outputs.tested != 'true') }}");
assert.equal(step.env.TESTED, "${{ needs.changes.outputs.tested }}");
assert.equal(checks.if, "needs.changes.outputs.code == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(changes.outputs.tested, "${{ steps.tested.outputs.tested }}");
assert.equal(changes.outputs.tree, "${{ steps.tested.outputs.tree }}");
assert.equal(changes.permissions.actions, "read");
const lookup = changes.steps.find((s) => s.id === "tested");
assert.equal(lookup.run, "node tools/ci-tested-tree.mjs ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '--lookup' || '' }}");
const ran = "needs.checks.result == 'success' && needs.tests.result == 'success' && (needs.desktop-smoke.result == 'success' || needs.desktop-smoke.result == 'skipped') && needs.changes.outputs.tree != ''";
const upload = gate.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
assert.equal(upload.with.name, "ci-passed-tree-${{ needs.changes.outputs.tree }}");
assert.equal(upload.if, ran);
assert.ok(gate.steps.indexOf(upload) > 0);
assert.ok(gate.steps.slice(2).every((s) => s.if === ran));

const gitPath = process.platform === "win32" ? spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout?.trim() : null;
const candidates = process.platform === "win32" ? [...(gitPath ? [resolve(gitPath, "../../../bin/bash.exe")] : []), "bash"] : ["bash"];
const bash = candidates.find((exe) => spawnSync(exe, ["-c", "exit 0"], { timeout: 5000, stdio: "ignore" }).status === 0);
if (!bash && (process.platform !== "win32" || process.env.CI)) throw new Error("bash is required to verify the CI gate's actual success/failure behavior");
let cases = 0;
const results = ["success", "failure", "cancelled", "skipped"];
for (const change of bash ? results : []) {
  const others = change === "success" ? results : ["success", "skipped"];
  for (const code of ["true", "false"]) {
    for (const tested of ["true", "false", ""]) {
      for (const desktop of ["true", "false"]) {
        for (const check of others) {
          for (const test of others) {
            for (const smokeResult of others) {
              const result = spawnSync(bash, ["-e", "-c", step.run], {
                env: { ...process.env, CHANGES: change, CODE: code, ROOT_DUE: String(code === "true" && tested !== "true"), TESTED: tested, DESKTOP: desktop, CHECKS: check, TESTS: test, SMOKE: smokeResult },
                encoding: "utf8",
                timeout: 5000
              });
              const ranFresh = code === "true" && tested !== "true";
              const wantSmoke = ranFresh && desktop === "true" ? "success" : "skipped";
              const expected = change === "success" && (ranFresh ? check === "success" && test === "success" : check === "skipped" && test === "skipped") && smokeResult === wantSmoke;
              assert.equal(result.status === 0, expected, JSON.stringify({ change, code, tested, desktop, check, test, smoke: smokeResult, error: result.error?.message }));
              cases++;
            }
          }
        }
      }
  }
  }
}
if (bash) {
  const shardJobs = (label, count) => Array.from({ length: count }, (_, index) => `${label} (${index + 1}/${count})\t1\tsuccess`);
  const rootJobs = shardJobs("Tests", shardCount);
  for (const { jobs, apiStatus = "0", pass } of [
    { jobs: rootJobs, pass: true },
    { jobs: [rootJobs[0].replace("\t1\tsuccess", "\t2\tsuccess"), ...rootJobs], pass: true },
    { jobs: [...rootJobs, rootJobs[0].replace("\t1\tsuccess", "\t2\tcancelled")], pass: false },
    { jobs: rootJobs.slice(1), pass: false },
    { jobs: [...rootJobs, rootJobs[0]], pass: false },
    ...["failure", "cancelled", "skipped"].map((status) => ({
      jobs: [...rootJobs.slice(1), rootJobs[0].replace("success", status)], pass: false
    })),
    { jobs: rootJobs, apiStatus: "1", pass: false }
  ]) {
    const mock = 'gh() { printf "%s\\n" "$MOCK_JOBS"; return "$MOCK_STATUS"; }\n';
    const result = spawnSync(bash, ["-e", "-c", mock + individual.run], {
      env: {
        ...process.env, MOCK_JOBS: jobs.join("\n"), MOCK_STATUS: apiStatus,
        ROOT_TESTS: "true", ROOT_SHARDS: String(shardCount)
      },
      encoding: "utf8",
      timeout: 5000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, pass, JSON.stringify({ jobs, apiStatus, output: result.stdout, error: result.stderr }));
    cases++;
  }
  const manifestsRunBy = (script) => {
    const echo = 'node() { for arg in "$@"; do case "$arg" in *-mutants.json) printf "%s\\n" "$arg";; esac; done; }\n';
    const work = mkdtempSync(join(tmpdir(), "splitpage-manifests-"));
    try {
      const result = spawnSync(bash, ["-e", "-c", echo + script.replaceAll("${{ matrix.shard }}", "1")], { cwd: REPO, env: { ...process.env, RUNNER_TEMP: work.replaceAll("\\", "/") }, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.split("\n").filter(Boolean);
    } finally {
      rmSync(work, { recursive: true, force: true });
  }
  };
  const fastFiles = manifestsRunBy(fastMutants);
  assert.deepEqual(manifestsRunBy(fastBaselineRun), fastFiles);
  const manifests = readdirSync(join(REPO, "tests/collab")).filter((name) => name.endsWith("-mutants.json")).map((name) => `tests/collab/${name}`).sort();
  assert.deepEqual([...fastFiles].sort(), manifests);
  cases++;
}
console.log(`CI shard configuration covers ${discovered.length} root test files and ${cases} real gate outcomes passed`);
if (!bash) console.log("SKIP real CI gate outcomes: bash is unavailable on this Windows machine outside CI; static workflow checks passed");
