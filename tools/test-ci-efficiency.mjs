import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { REPO } from "./source-scan.mjs";

const readWorkflow = (name) => parse(readFileSync(join(REPO, `.github/workflows/${name}.yml`), "utf8"));
const ci = readWorkflow("ci");
const steps = ci.jobs.checks.steps;
const appSteps = ["Build index.html and stamp sw.js", "sw.js is committed with the current VERSION stamp", "Select persistent Chromium cache", "Install Chromium", "Pick this runner's port block", "Browser suites 01 (core) and 52 (content security policy)", "Browser suites for save, typing, undo and export"];
assert.equal(ci.jobs.changes.outputs.app, "${{ steps.classify.outputs.app }}");
assert.equal(ci.jobs.checks.if, "needs.changes.outputs.code == 'true'" + (ci.jobs.changes.outputs.tested ? " && needs.changes.outputs.tested != 'true'" : ""));
assert.equal(ci.jobs.changes.outputs.root_tests, "${{ steps.classify.outputs.root_tests }}");
assert.equal(ci.jobs.tests.if, "needs.changes.outputs.root_tests == 'true' && needs.changes.outputs.tested != 'true'");
for (const name of appSteps) assert.equal(steps.find((s) => s.name === name)?.if, "needs.changes.outputs.app == 'true'", name);
assert.equal(steps.find((s) => s.name === "Upload the built app")?.if, "needs.changes.outputs.app == 'true' && github.event_name == 'push'");
for (const name of ["Lint", "Types", "Layers and dependencies", "No new comments"]) {
  const step = steps.find((s) => s.name === name);
  assert.ok(step, name);
  assert.equal(step.if, undefined, name);
}
assert.equal(steps.some((s) => s.run?.includes("npm run test:all")), false);
const cache = steps.find((s) => s.name === "Select persistent Chromium cache");
assert.equal(ci.jobs.checks.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
if (existsSync(join(REPO, ".github/workflows/nightly.yml"))) {
  const job = readWorkflow("nightly").jobs.suites;
  assert.equal(cache.run, job.steps.find((s) => s.name === cache.name)?.run);
  assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
}
assert.ok(cache.run.includes("$RUNNER_TOOL_CACHE/splitpage-playwright/$PLAYWRIGHT_VERSION"));
assert.ok(!cache.run.includes("github.workspace"));
assert.ok(steps.findIndex((s) => s.name === cache.name) < steps.findIndex((s) => s.name === "Install Chromium"));
assert.ok(steps.find((s) => s.name === "Install Chromium").run.includes("--with-deps"));
const testSteps = ci.jobs.tests.steps;
assert.equal(testSteps.find((s) => s.name === cache.name)?.run, cache.run);
assert.ok(testSteps.find((s) => s.name === "Install Chromium")?.run.includes("--with-deps"));
assert.ok(testSteps.findIndex((s) => s.name === "Install Chromium") < testSteps.findIndex((s) => s.run?.includes("npm run test:all")));
const installWithRetry = /^(npx --yes playwright@\$\{PLAYWRIGHT_VERSION\} install \$\{\{ runner\.environment == 'github-hosted' && '--with-deps' \|\| '' \}\} chromium) \|\| \{\n(?: *#[^\n]*\n)* *echo "::warning::[^\n"]*"\n *echo "nameserver 1\.1\.1\.1" \| sudo -n tee \/etc\/resolv\.conf > \/dev\/null\n *\1\n\}\n/;
for (const list of [steps, testSteps]) {
  const install = list.find((s) => s.name === "Install Chromium").run;
  assert.match(install, installWithRetry);
  assert.doesNotMatch(install.replace(/\n {2}npx[^\n]*\n\}\n/, "\n  echo install chromium\n}\n"), installWithRetry);
  assert.doesNotMatch(install.replace("--with-deps' || '' }} chromium\n}", "' || '' }} chromium\n}"), installWithRetry);
  assert.doesNotMatch("true || " + install, installWithRetry);
}
assert.match(ci.jobs["desktop-smoke"].steps.find((s) => s.name === "Xvfb and Chromium's shared libraries").run, /^packages\(\) \{\n *sudo apt-get update && sudo apt-get install -y --no-install-recommends xvfb && npx --yes playwright@\$\{PLAYWRIGHT_VERSION\} install-deps chromium\n\}\npackages \|\| \{\n(?: *#[^\n]*\n)* *echo "::warning::[^\n"]*"\n *echo "nameserver 1\.1\.1\.1" \| sudo -n tee \/etc\/resolv\.conf > \/dev\/null\n *packages\n\}\n$/);
assert.equal(ci.jobs.tests.env.SPLITPAGE_CHROME_ARGS, ci.jobs.checks.env.SPLITPAGE_CHROME_ARGS);

const gitPath = process.platform === "win32" ? spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout?.trim() : null;
const bash = process.platform === "win32" ? resolve(gitPath, "../../../bin/bash.exe") : "bash";
const work = mkdtempSync(join(tmpdir(), "splitpage-cache-check-"));
try {
  const output = join(work, "github-env");
  const toolCache = join(work, "tool cache").replaceAll("\\", "/");
  const result = spawnSync(bash, ["-e", "-c", cache.run], {
    env: { ...process.env, RUNNER_TOOL_CACHE: toolCache, PLAYWRIGHT_VERSION: "1.63.0", GITHUB_ENV: output.replaceAll("\\", "/") },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(readFileSync(output, "utf8").trim(), `PLAYWRIGHT_BROWSERS_PATH=${toolCache}/splitpage-playwright/1.63.0`);
  assert.notEqual(spawnSync(bash, ["-e", "-c", cache.run], {
    env: { ...process.env, RUNNER_TOOL_CACHE: "", PLAYWRIGHT_VERSION: "1.63.0", GITHUB_ENV: output.replaceAll("\\", "/") }
  }).status, 0);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (existsSync(join(REPO, ".github/workflows/windows-local.yml"))) {
  const windows = readWorkflow("windows-local");
  const job = windows.jobs.windows;
  const windowsCache = job.steps.find((s) => s.name === cache.name);
  assert.ok(windowsCache?.run.includes("$env:RUNNER_TOOL_CACHE"));
  assert.ok(windowsCache.run.includes("$env:PLAYWRIGHT_VERSION"));
  assert.equal(windows.env.PLAYWRIGHT_VERSION, ci.env.PLAYWRIGHT_VERSION);
  assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
}
console.log("CI filtering preserves required checks; persistent versioned browser cache works with spaces");
