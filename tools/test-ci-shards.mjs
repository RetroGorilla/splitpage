import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { REPO, listRepoFiles } from "./source-scan.mjs";
import { assignShards, discover } from "./run-tests.mjs";

const workflow = parse(readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8"));
const { changes, checks, tests, gate } = workflow.jobs;
const rootShards = tests.strategy.matrix.shard;
const shardCount = rootShards.length;
const found = discover(listRepoFiles(REPO)).groups;
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
assert.equal(tests.steps.find((s) => s.run?.includes("npm run test:all")).run, `npm run test:all -- --shard "\${{ matrix.shard }}/${shardCount}" --suite=always`);
const setup = parse(readFileSync(join(REPO, ".github/actions/root-test-setup/action.yml"), "utf8")).runs.steps;
assert.ok(setup.some((s) => s.run === "node build.mjs"));
assert.ok(setup.some((s) => s.run === "git diff --exit-code -- sw.js"));
const nightly = parse(readFileSync(join(REPO, ".github/workflows/nightly.yml"), "utf8"));
const nightlyMutants = nightly.jobs.mutants.steps.find((s) => s.run?.includes("tools/mutants.mjs")).run;
assert.equal(nightlyMutants, 'set -o pipefail\nnode tools/mutants.mjs tests/collab/undo-slow-mutants.json --concurrency 2 --timeout 600 --baseline-timeout 900 --fail-on-survivor 2>&1 | tee "$RUNNER_TEMP/nightly-mutants.log"\n');
assert.equal(nightly.jobs.mutants["runs-on"], nightly.jobs.suites["runs-on"]);
const fastBaselineJob = nightly.jobs["mutants-fast-baseline"];
const fastJob = nightly.jobs["mutants-fast"];
const fastReport = nightly.jobs["mutants-fast-report"];
for (const job of [fastBaselineJob, fastJob]) {
  assert.equal(job.needs, undefined);
  assert.equal(job.if, undefined);
  assert.equal(job["runs-on"], nightly.jobs.mutants["runs-on"]);
  assert.equal(job["timeout-minutes"], 30);
}
assert.deepEqual(fastJob.strategy.matrix.shard, [1, 2, 3, 4, 5, 6]);
assert.equal(fastJob.strategy["fail-fast"], false);
assert.deepEqual(fastBaselineJob.steps.slice(0, 3), fastJob.steps.slice(0, 3));
assert.equal(fastBaselineJob.steps.length, 4);
const fastBaselineRun = fastBaselineJob.steps[3].run;
assert.equal(fastBaselineRun, 'shopt -s extglob\nnode tools/mutants.mjs tests/collab/!(undo-slow)-mutants.json --baseline-only --baseline-timeout 1500\n');
const fastMutants = fastJob.steps.find((s) => s.run?.includes("tools/mutants.mjs")).run;
assert.equal(fastMutants, 'shopt -s extglob\nnode tools/mutants.mjs tests/collab/!(undo-slow)-mutants.json --shard "${{ matrix.shard }}/6" --concurrency 4 --no-baseline --fail-on-survivor\n');
assert.deepEqual(fastReport.needs, ["mutants-fast-baseline", "mutants-fast"]);
assert.equal(fastReport.if, "failure()");
assert.deepEqual(gate.needs, ["changes", "checks", "tests", "old-adapter-tests", "desktop-smoke"]);
assert.equal(gate.if, "always()");
assert.deepEqual(gate.permissions, { actions: "read" });
const step = gate.steps[0];
const individual = gate.steps[1];
assert.equal(individual.if, "needs.changes.outputs.root_due == 'true' || needs.changes.outputs.old_adapter == 'true'");
const oldCount = workflow.jobs["old-adapter-tests"].strategy.matrix.shard.length;
assert.equal(oldCount, 3);
assert.equal(workflow.jobs["old-adapter-tests"].name, `Old adapter tests (\${{ matrix.shard }}/${oldCount})`);
assert.deepEqual(individual.env, {
  GH_TOKEN: "${{ github.token }}",
  ROOT_TESTS: "${{ needs.changes.outputs.root_due }}",
  OLD_ADAPTER: "${{ needs.changes.outputs.old_adapter }}",
  ROOT_SHARDS: String(shardCount),
  OLD_SHARDS: String(oldCount)
});
assert.equal(step.env.SMOKE, "${{ needs.desktop-smoke.result }}");
assert.equal(step.env.DESKTOP, "${{ needs.changes.outputs.desktop }}");
assert.equal(step.env.TESTS, "${{ needs.tests.result }}");
assert.equal(step.env.CHECKS, "${{ needs.checks.result }}");
assert.equal(step.env.CHANGES, "${{ needs.changes.result }}");
assert.equal(step.env.CODE, "${{ needs.changes.outputs.code }}");
assert.equal(step.env.ROOT_DUE, "${{ needs.changes.outputs.root_due }}");
assert.equal(step.env.OLD_ADAPTER, "${{ needs.changes.outputs.old_adapter }}");
assert.equal(step.env.OLD_ADAPTER_TESTS, "${{ needs.old-adapter-tests.result }}");
assert.equal(changes.outputs.old_adapter, "${{ steps.classify.outputs.old_adapter }}");
assert.equal(changes.outputs.root_due, "${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') || (steps.classify.outputs.code == 'true' && steps.tested.outputs.tested != 'true') }}");
assert.equal(step.env.TESTED, "${{ needs.changes.outputs.tested }}");
assert.equal(checks.if, "needs.changes.outputs.code == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(changes.outputs.tested, "${{ steps.tested.outputs.tested }}");
assert.equal(changes.outputs.tree, "${{ steps.tested.outputs.tree }}");
assert.equal(changes.permissions.actions, "read");
const lookup = changes.steps.find((s) => s.id === "tested");
assert.equal(lookup.run, "node tools/ci-tested-tree.mjs ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '--lookup' || '' }}");
const ran = "needs.checks.result == 'success' && needs.tests.result == 'success' && (needs.old-adapter-tests.result == 'success' || needs.old-adapter-tests.result == 'skipped') && (needs.desktop-smoke.result == 'success' || needs.desktop-smoke.result == 'skipped') && needs.changes.outputs.tree != ''";
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
                env: { ...process.env, CHANGES: change, CODE: code, ROOT_DUE: String(code === "true" && tested !== "true"), OLD_ADAPTER: "false", OLD_ADAPTER_TESTS: "skipped", TESTED: tested, DESKTOP: desktop, CHECKS: check, TESTS: test, SMOKE: smokeResult },
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
  const oldJobs = shardJobs("Old adapter tests", oldCount);
  for (const { jobs, root = "true", old = "false", apiStatus = "0", pass } of [
    { jobs: rootJobs, pass: true },
    { jobs: [rootJobs[0].replace("\t1\tsuccess", "\t2\tsuccess"), ...rootJobs], pass: true },
    { jobs: [...rootJobs, rootJobs[0].replace("\t1\tsuccess", "\t2\tcancelled")], pass: false },
    { jobs: [...rootJobs, ...oldJobs], old: "true", pass: true },
    { jobs: rootJobs, old: "true", pass: false },
    { jobs: [...rootJobs, ...oldJobs.slice(1), oldJobs[0].replace("success", "cancelled")], old: "true", pass: false },
    { jobs: oldJobs, root: "false", old: "true", pass: true },
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
        ROOT_TESTS: root, OLD_ADAPTER: old, ROOT_SHARDS: String(shardCount), OLD_SHARDS: String(oldCount)
      },
      encoding: "utf8",
      timeout: 5000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, pass, JSON.stringify({ jobs, root, old, apiStatus, output: result.stdout, error: result.stderr }));
    cases++;
  }
  for (const oldDue of [true, false]) {
    for (const status of results) {
      const result = spawnSync(bash, ["-e", "-c", step.run], {
        env: { ...process.env, CHANGES: "success", CODE: "false", ROOT_DUE: "true", OLD_ADAPTER: String(oldDue),
          TESTED: "true", DESKTOP: "false", CHECKS: "skipped", TESTS: "success",
          OLD_ADAPTER_TESTS: status, SMOKE: "skipped" },
        encoding: "utf8",
        timeout: 5000
      });
      assert.equal(result.status === 0, status === (oldDue ? "success" : "skipped"), result.stdout + result.stderr);
      cases++;
    }
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
  const fastFiles = manifestsRunBy(fastMutants), slowFiles = manifestsRunBy(nightlyMutants);
  assert.deepEqual(manifestsRunBy(fastBaselineRun), fastFiles);
  const manifests = readdirSync(join(REPO, "tests/collab")).filter((name) => name.endsWith("-mutants.json")).map((name) => `tests/collab/${name}`).sort();
  for (const file of manifests) assert.equal(fastFiles.filter((f) => f === file).length + slowFiles.filter((f) => f === file).length, 1, `${file} must be run by exactly one nightly mutant job`);
  assert.deepEqual([...fastFiles, ...slowFiles].sort(), manifests);
  assert.deepEqual(slowFiles, ["tests/collab/undo-slow-mutants.json"]);
  cases++;
}
console.log(`CI shard configuration and ${cases} real gate outcomes passed`);
if (!bash) console.log("SKIP real CI gate outcomes: bash is unavailable on this Windows machine outside CI; static workflow checks passed");
