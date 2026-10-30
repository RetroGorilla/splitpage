import { markerName, WORKFLOW } from "./ci-tested-tree.mjs";
import { checkRelease, describe, gateRun } from "./release-ci-check.mjs";

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log("  ok   " + name); return; }
  const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  failures.push(`${name} — ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

const REPOSITORY = "owner/repo";
const SHA = "c".repeat(40);
const TREE = "a".repeat(40);

const ciRun = { id: 11, conclusion: "success", path: WORKFLOW, head_sha: SHA, head_repository: { full_name: REPOSITORY }, html_url: "https://example.test/runs/11", event: "push" };
const gateCheck = (extra = {}) => ({ name: "gate", status: "completed", conclusion: "success", app: { slug: "github-actions" }, details_url: `https://github.com/${REPOSITORY}/actions/runs/11/job/5`, ...extra });
const marker = (id, extra = {}) => ({ name: markerName(TREE), expired: false, workflow_run: { id }, ...extra });

function api({ checks = [], runs = [ciRun], artifacts = [], failOn = null } = {}) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (failOn && path.includes(failOn)) throw new Error(`GET ${path}: HTTP 500`);
    if (path.startsWith(`/repos/${REPOSITORY}/commits/${SHA}/check-runs?`)) return { check_runs: checks };
    if (path.startsWith(`/repos/${REPOSITORY}/actions/artifacts?`)) return { artifacts };
    const run = runs.find((r) => r.id === Number(path.split("/").pop()));
    if (!run) throw new Error(`GET ${path}: HTTP 404`);
    return run;
  };
  return { get, calls };
}
const check = (options, input = {}) => checkRelease({ sha: SHA, tree: TREE, repository: REPOSITORY, runId: 99, get: api(options).get, ...input });

console.log("\ngate check run:\n");

{
  const { get, calls } = api({ checks: [gateCheck()] });
  const result = await checkRelease({ sha: SHA, tree: TREE, repository: REPOSITORY, runId: 99, get });
  eq("a successful gate of ci.yml on the commit passes", result.ok, true);
  eq("the pass names the run", result.via.includes(ciRun.html_url), true);
  eq("one check-run listing filtered by name, then the run", calls, [`/repos/${REPOSITORY}/commits/${SHA}/check-runs?check_name=gate&per_page=100`, `/repos/${REPOSITORY}/actions/runs/11`]);
}
eq("a failed gate does not pass", (await check({ checks: [gateCheck({ conclusion: "failure" })] })).ok, false);
eq("a cancelled gate does not pass", (await check({ checks: [gateCheck({ conclusion: "cancelled" })] })).ok, false);
eq("a skipped gate does not pass", (await check({ checks: [gateCheck({ conclusion: "skipped" })] })).ok, false);
eq("a gate still running does not pass", (await check({ checks: [gateCheck({ status: "in_progress", conclusion: null })] })).ok, false);
eq("a successful check with another name does not pass", (await check({ checks: [gateCheck({ name: "checks" })] })).ok, false);
eq("a gate from another app does not pass", (await check({ checks: [gateCheck({ app: { slug: "other-ci" } })] })).ok, false);
eq("a gate without a run link does not pass", (await check({ checks: [gateCheck({ details_url: "https://example.test/x" })] })).ok, false);
eq("a gate of another workflow does not pass", (await check({ checks: [gateCheck()], runs: [{ ...ciRun, path: ".github/workflows/nightly.yml" }] })).ok, false);
eq("a gate of a run for another commit does not pass", (await check({ checks: [gateCheck()], runs: [{ ...ciRun, head_sha: "d".repeat(40) }] })).ok, false);
eq("a gate of a fork's run does not pass", (await check({ checks: [gateCheck()], runs: [{ ...ciRun, head_repository: { full_name: "fork/repo" } }] })).ok, false);
eq("a workflow path with a ref suffix still counts", (await check({ checks: [gateCheck()], runs: [{ ...ciRun, path: WORKFLOW + "@refs/heads/4.1-development" }] })).ok, true);
eq("a later success after a failed gate passes", (await check({ checks: [gateCheck({ conclusion: "failure" }), gateCheck()] })).ok, true);
eq("the count of gate checks seen is reported", (await gateRun({ sha: SHA, repository: REPOSITORY, get: api({ checks: [gateCheck({ conclusion: "failure" })] }).get })).seen, 1);

console.log("\nno run found:\n");

{
  const result = await check({});
  eq("no gate and no marker fails", result.ok, false);
  eq("it says no gate was found", result.problems[0], "no gate check run found");
  eq("it says no marker was found", result.problems[1], `no unexpired ci-passed-tree-${TREE} marker from a successful ${WORKFLOW} run`);
}
{
  const result = await check({ checks: [gateCheck({ conclusion: "failure" })] });
  eq("it says a gate was found but not a success", result.problems[0], `1 gate check run(s) found, none a success of ${WORKFLOW}`);
}

console.log("\npassed-tree marker:\n");

eq("a marker from a successful ci.yml run passes with no gate", (await check({ artifacts: [marker(11)] })).ok, true);
eq("a marker passes after a failed gate", (await check({ checks: [gateCheck({ conclusion: "failure" })], artifacts: [marker(11)] })).ok, true);
eq("the pass names the tree", (await check({ artifacts: [marker(11)] })).via.includes(TREE), true);
eq("a marker from a failed run does not pass", (await check({ artifacts: [marker(11)], runs: [{ ...ciRun, conclusion: "failure" }] })).ok, false);
eq("an expired marker does not pass", (await check({ artifacts: [marker(11, { expired: true })] })).ok, false);
eq("a commit with no known tree has no marker lookup", (await check({ artifacts: [marker(11)] }, { tree: null })).problems.at(-1), "the tree of the commit is unknown, so no passed-tree marker can be looked up");
eq("a commit with no known tree and no gate fails", (await check({ artifacts: [marker(11)] }, { tree: null })).ok, false);

console.log("\nAPI errors fail closed:\n");

{
  const result = await check({ failOn: "/check-runs" });
  eq("a failing check-run listing and no marker fails", result.ok, false);
  eq("the failure says which lookup broke", result.problems[0].startsWith("gate lookup failed: GET"), true);
}
{
  const result = await check({ checks: [gateCheck()], failOn: "/actions/runs/11" });
  eq("a failing run lookup behind a gate fails", result.ok, false);
}
{
  const result = await check({ failOn: "/actions/artifacts" });
  eq("a failing artifact listing and no gate fails", result.ok, false);
  eq("the failure says the marker lookup broke", result.problems.at(-1).startsWith("passed-tree lookup failed: GET"), true);
}
eq("a failing check-run listing with a marker still passes", (await check({ failOn: "/check-runs", artifacts: [marker(11)] })).ok, true);
eq("every lookup failing fails", (await checkRelease({ sha: SHA, tree: TREE, repository: REPOSITORY, runId: 99, get: async (path) => { throw new Error(`GET ${path}: HTTP 403`); } })).ok, false);

console.log("\nmessages and exit codes:\n");

{
  const pass = describe({ result: { ok: true, via: "the gate", problems: [] }, sha: SHA, dispatch: false });
  eq("a pass exits 0", pass.exit, 0);
}
{
  const result = { ok: false, via: null, problems: ["no gate check run found", "no marker"] };
  const tag = describe({ result, sha: SHA, dispatch: false });
  eq("a tag push without CI exits 1", tag.exit, 1);
  eq("it is an error naming the commit and what was missing", tag.lines, [`::error::commit ${SHA} has no passed CI run: no gate check run found; no marker`]);
  const manual = describe({ result, sha: SHA, dispatch: true });
  eq("a manual run without CI exits 0", manual.exit, 0);
  eq("it is only a warning", manual.lines[0], `::warning::commit ${SHA} has no passed CI run: no gate check run found; no marker`);
  eq("a manual run's pass is not a warning", describe({ result: { ok: true, via: "x", problems: [] }, sha: SHA, dispatch: true }).lines.length, 1);
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
