import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { REPO } from "./source-scan.mjs";

const workflow = parse(readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8"));
const { changes, checks, tests, gate } = workflow.jobs;
assert.deepEqual(tests.strategy.matrix.shard, [1, 2]);
assert.equal(tests.strategy["fail-fast"], false);
assert.equal(tests.needs, "changes");
assert.equal(tests.if, checks.if);
assert.equal(tests["runs-on"], checks["runs-on"]);
assert.equal(tests["runs-on"], changes["runs-on"]);
assert.equal(checks.steps.some((s) => s.run?.includes("npm run test:all")), false);
assert.equal(tests.steps.filter((s) => s.run?.includes("npm run test:all")).length, 1);
assert.equal(tests.steps.find((s) => s.run?.includes("npm run test:all")).run, 'npm run test:all -- --shard "${{ matrix.shard }}/2"');
assert.ok(tests.steps.some((s) => s.run === "node build.mjs"));
assert.ok(tests.steps.some((s) => s.run === "git diff --exit-code -- sw.js"));
assert.deepEqual(gate.needs, ["changes", "checks", "tests"]);
assert.equal(gate.if, "always()");
const step = gate.steps[0];
assert.equal(step.env.TESTS, "${{ needs.tests.result }}");
assert.equal(step.env.CHECKS, "${{ needs.checks.result }}");
assert.equal(step.env.CHANGES, "${{ needs.changes.result }}");
assert.equal(step.env.CODE, "${{ needs.changes.outputs.code }}");
assert.equal(step.env.TESTED, "${{ needs.changes.outputs.tested }}");
assert.equal(checks.if, "needs.changes.outputs.code == 'true' && needs.changes.outputs.tested != 'true'");
assert.equal(changes.outputs.tested, "${{ steps.tested.outputs.tested }}");
assert.equal(changes.outputs.tree, "${{ steps.tested.outputs.tree }}");
assert.equal(changes.permissions.actions, "read");
const lookup = changes.steps.find((s) => s.id === "tested");
assert.equal(lookup.run, "node tools/ci-tested-tree.mjs ${{ github.event_name == 'push' && github.ref == 'refs/heads/4.1-development' && '--lookup' || '' }}");
const ran = "needs.checks.result == 'success' && needs.tests.result == 'success' && needs.changes.outputs.tree != ''";
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
for (const change of bash ? ["success", "failure", "cancelled", "skipped"] : []) {
  for (const code of ["true", "false"]) {
    for (const tested of ["true", "false", ""]) {
      for (const check of ["success", "failure", "cancelled", "skipped"]) {
        for (const test of ["success", "failure", "cancelled", "skipped"]) {
          const result = spawnSync(bash, ["-e", "-c", step.run], {
            env: { ...process.env, CHANGES: change, CODE: code, TESTED: tested, CHECKS: check, TESTS: test },
            encoding: "utf8",
            timeout: 5000
          });
          const expected = change === "success" && (code === "true" && tested !== "true" ? check === "success" && test === "success" : check === "skipped" && test === "skipped");
          assert.equal(result.status === 0, expected, JSON.stringify({ change, code, tested, check, test, error: result.error?.message }));
          cases++;
        }
      }
    }
  }
}
console.log(`CI shard configuration and ${cases} real gate outcomes passed`);
if (!bash) console.log("SKIP real CI gate outcomes: bash is unavailable on this Windows machine outside CI; static workflow checks passed");
