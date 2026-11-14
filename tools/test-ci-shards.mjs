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
const found = discover(listRepoFiles(REPO)).groups;
const discovered = found.flatMap((entry) => entry.files).sort();
for (const count of [3, 4]) assert.deepEqual(assignShards(found, count).flat().sort(), discovered);
const smoke = workflow.jobs["desktop-smoke"];
assert.equal(smoke.needs, "changes");
assert.equal(smoke["runs-on"], "ubuntu-latest");
assert.equal(smoke["timeout-minutes"], 90);
assert.equal(smoke.if, "needs.changes.outputs.desktop == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(changes.outputs.desktop, "${{ steps.classify.outputs.desktop }}");
assert.equal(changes.outputs.collab, "${{ steps.classify.outputs.collab }}");
assert.equal(changes.outputs.root_tests, "${{ steps.classify.outputs.root_tests }}");
const prototypeTests = checks.steps.find((s) => s.name === "Collaboration prototype tests");
assert.equal(prototypeTests.if, "needs.changes.outputs.collab == 'true'");
assert.equal(prototypeTests.run, "npm test");
assert.equal(prototypeTests["working-directory"], "prototypes/collab");
const install = checks.steps.find((s) => s.name === "Install tooling");
assert.ok(install.run.includes("npm ci --prefix prototypes/collab"));
assert.ok(checks.steps.indexOf(install) < checks.steps.indexOf(prototypeTests));
assert.equal(checks.steps.find((s) => s.run === "node tools/build-preload.mjs && node tools/check-preload.mjs").if, "needs.changes.outputs.root_tests == 'true'");
for (const s of checks.steps.filter((s) => /^node build\.mjs|playwright@/.test(s.run ?? "") || s.run?.includes("playwright@"))) {
  assert.equal(s.if, "needs.changes.outputs.app == 'true'");
}
for (const job of [checks, workflow.jobs["npm-cache"]]) {
  assert.ok(job.steps.find((s) => s.uses?.startsWith("actions/setup-node@")).with["cache-dependency-path"].split("\n").includes("prototypes/collab/package-lock.json"));
}
assert.ok(workflow.jobs["npm-cache"].steps.some((s) => s.run?.includes("npm ci --ignore-scripts --prefix prototypes/collab")));
assert.deepEqual(tests.strategy.matrix.shard, [1, 2, 3, 4]);
assert.equal(tests.strategy["fail-fast"], false);
assert.equal(tests.needs, "changes");
assert.equal(tests.if, "needs.changes.outputs.root_tests == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(tests["runs-on"], checks["runs-on"]);
assert.equal(tests["runs-on"], changes["runs-on"]);
assert.equal(checks.steps.some((s) => s.run?.includes("npm run test:all")), false);
assert.equal(tests.steps.filter((s) => s.run?.includes("npm run test:all")).length, 1);
assert.equal(tests.steps.find((s) => s.run?.includes("npm run test:all")).run, 'npm run test:all -- --shard "${{ matrix.shard }}/4"');
assert.ok(tests.steps.some((s) => s.run === "node build.mjs"));
assert.ok(tests.steps.some((s) => s.run === "git diff --exit-code -- sw.js"));
const mutants = workflow.jobs.mutants;
assert.equal(changes.outputs.mutants, "${{ steps.classify.outputs.mutants }}");
assert.equal(mutants.needs, "changes");
assert.equal(mutants.if, "needs.changes.outputs.mutants == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(mutants["runs-on"], tests["runs-on"]);
assert.deepEqual(mutants.strategy.matrix.shard, [1, 2, 3, 4]);
assert.equal(mutants.strategy["fail-fast"], false);
assert.equal(mutants["timeout-minutes"], 30);
const prMutants = mutants.steps.find((s) => s.run?.includes("tools/mutants.mjs")).run;
assert.equal(prMutants, 'shopt -s extglob\nnode tools/mutants.mjs tests/collab/!(undo-slow)-mutants.json --shard "${{ matrix.shard }}/4" --concurrency 4 --baseline-timeout 900 --fail-on-survivor\n');
const nightly = parse(readFileSync(join(REPO, ".github/workflows/nightly.yml"), "utf8"));
const nightlyMutants = nightly.jobs.mutants.steps.find((s) => s.run?.includes("tools/mutants.mjs")).run;
assert.equal(nightlyMutants, 'set -o pipefail\nnode tools/mutants.mjs tests/collab/undo-slow-mutants.json --concurrency 2 --timeout 600 --baseline-timeout 900 --fail-on-survivor 2>&1 | tee "$RUNNER_TEMP/nightly-mutants.log"\n');
assert.equal(nightly.jobs.mutants["runs-on"], nightly.jobs.suites["runs-on"]);
assert.deepEqual(gate.needs, ["changes", "checks", "tests", "desktop-smoke", "mutants"]);
assert.equal(gate.if, "always()");
const step = gate.steps[0];
assert.equal(step.env.SMOKE, "${{ needs.desktop-smoke.result }}");
assert.equal(step.env.DESKTOP, "${{ needs.changes.outputs.desktop }}");
assert.equal(step.env.TESTS, "${{ needs.tests.result }}");
assert.equal(step.env.CHECKS, "${{ needs.checks.result }}");
assert.equal(step.env.CHANGES, "${{ needs.changes.result }}");
assert.equal(step.env.CODE, "${{ needs.changes.outputs.code }}");
assert.equal(step.env.ROOT_TESTS, "${{ needs.changes.outputs.root_tests }}");
assert.equal(step.env.TESTED, "${{ needs.changes.outputs.tested }}");
assert.equal(step.env.MUTANTS_NEEDED, "${{ needs.changes.outputs.mutants }}");
assert.equal(step.env.MUTANTS, "${{ needs.mutants.result }}");
assert.equal(checks.if, "needs.changes.outputs.code == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(changes.outputs.tested, "${{ steps.tested.outputs.tested }}");
assert.equal(changes.outputs.tree, "${{ steps.tested.outputs.tree }}");
assert.equal(changes.permissions.actions, "read");
const lookup = changes.steps.find((s) => s.id === "tested");
assert.equal(lookup.run, "node tools/ci-tested-tree.mjs ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && '--lookup' || '' }}");
const ran = "needs.checks.result == 'success' && needs.tests.result == 'success' && (needs.desktop-smoke.result == 'success' || needs.desktop-smoke.result == 'skipped')"
  + " && (needs.mutants.result == 'success' || needs.mutants.result == 'skipped') && needs.changes.outputs.tree != ''";
const upload = gate.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
assert.equal(upload.with.name, "ci-passed-tree-${{ needs.changes.outputs.tree }}");
assert.equal(upload.if, ran);
assert.ok(gate.steps.indexOf(upload) > 0);
assert.ok(gate.steps.slice(1).every((s) => s.if === ran));

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
                env: { ...process.env, CHANGES: change, CODE: code, ROOT_TESTS: code, TESTED: tested, DESKTOP: desktop, CHECKS: check, TESTS: test, SMOKE: smokeResult,
                  MUTANTS_NEEDED: "false", MUTANTS: "skipped" },
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
for (const check of bash ? results : []) {
  for (const test of results) {
    for (const smokeResult of results) {
      const result = spawnSync(bash, ["-e", "-c", step.run], {
        env: { ...process.env, CHANGES: "success", CODE: "true", ROOT_TESTS: "false", TESTED: "false", DESKTOP: "false", CHECKS: check, TESTS: test, SMOKE: smokeResult,
          MUTANTS_NEEDED: "false", MUTANTS: "skipped" },
        encoding: "utf8",
        timeout: 5000
      });
      assert.equal(result.status === 0, check === "success" && test === "skipped" && smokeResult === "skipped", JSON.stringify({ prototypeOnly: true, check, test, smoke: smokeResult, error: result.error?.message }));
      cases++;
    }
  }
}
for (const needed of bash ? ["true", "false"] : []) {
  for (const tested of ["true", "false", ""]) {
    for (const mutantResult of results) {
      const fresh = tested !== "true", ran = fresh ? "success" : "skipped";
      const result = spawnSync(bash, ["-e", "-c", step.run], {
        env: { ...process.env, CHANGES: "success", CODE: "true", ROOT_TESTS: "true", TESTED: tested, DESKTOP: "false", CHECKS: ran, TESTS: ran, SMOKE: "skipped",
          MUTANTS_NEEDED: needed, MUTANTS: mutantResult },
        encoding: "utf8",
        timeout: 5000
      });
      assert.equal(result.status === 0, mutantResult === (needed === "true" && fresh ? "success" : "skipped"), JSON.stringify({ needed, tested, mutants: mutantResult, error: result.error?.message }));
      cases++;
    }
  }
}
if (bash) {
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
  const pr = manifestsRunBy(prMutants), night = manifestsRunBy(nightlyMutants);
  const manifests = readdirSync(join(REPO, "tests/collab")).filter((name) => name.endsWith("-mutants.json")).map((name) => `tests/collab/${name}`).sort();
  for (const file of manifests) assert.equal(pr.filter((f) => f === file).length + night.filter((f) => f === file).length, 1, `${file} must be run by exactly one of ci.yml and nightly.yml`);
  assert.deepEqual([...pr, ...night].sort(), manifests);
  assert.deepEqual(night, ["tests/collab/undo-slow-mutants.json"]);
  cases++;
}
console.log(`CI shard configuration and ${cases} real gate outcomes passed`);
if (!bash) console.log("SKIP real CI gate outcomes: bash is unavailable on this Windows machine outside CI; static workflow checks passed");
