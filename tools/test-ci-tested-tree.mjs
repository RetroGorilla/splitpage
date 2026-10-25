import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markerName, treeOf, passedRun, WORKFLOW } from "./ci-tested-tree.mjs";

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log("  ok   " + name); return; }
  const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  failures.push(`${name} — ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

console.log("\ntreeOf():\n");

const repo = mkdtempSync(join(tmpdir(), "splitpage-ci-tested-tree-"));
const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).stdout.trim();
git("init", "-q");
eq("a repository with no commit has no tree", treeOf("HEAD", repo), null);
writeFileSync(join(repo, "a.js"), "a\n");
git("add", ".");
git("commit", "-qm", "one");
const tree = git("rev-parse", "HEAD^{tree}");
eq("the tree of the commit is read", treeOf("HEAD", repo), tree);
git("commit", "-q", "--allow-empty", "-m", "two");
eq("a commit with the same files has the same tree", treeOf("HEAD", repo), tree);
eq("an unknown commit has no tree", treeOf("deadbeef", repo), null);
rmSync(repo, { recursive: true, force: true });

console.log("\npassedRun():\n");

const REPOSITORY = "owner/repo";
const T = "a".repeat(40);
const good = { id: 1, conclusion: "success", path: WORKFLOW, head_repository: { full_name: REPOSITORY } };
function api(runs, artifacts) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path.startsWith(`/repos/${REPOSITORY}/actions/artifacts?`)) return { artifacts };
    const id = Number(path.split("/").pop());
    const run = runs.find((r) => r.id === id);
    if (!run) throw new Error("GET " + path + ": HTTP 404");
    return run;
  };
  return { get, calls };
}
const marker = (id, extra = {}) => ({ name: markerName(T), expired: false, workflow_run: { id }, ...extra });
const found = async (runs, artifacts, runId = 99) => (await passedRun({ tree: T, repository: REPOSITORY, runId, get: api(runs, artifacts).get }))?.id ?? null;

eq("the marker is named by the tree", markerName(T), "ci-passed-tree-" + T);
{
  const { get, calls } = api([good], [marker(1)]);
  await passedRun({ tree: T, repository: REPOSITORY, runId: 99, get });
  eq("one listing by name, then the run", calls, [`/repos/${REPOSITORY}/actions/artifacts?name=ci-passed-tree-${T}&per_page=100`, `/repos/${REPOSITORY}/actions/runs/1`]);
}
eq("a successful CI run with the marker counts", await found([good], [marker(1)]), 1);
eq("no marker, no run", await found([good], []), null);
eq("a failed run does not count", await found([{ ...good, conclusion: "failure" }], [marker(1)]), null);
eq("a run still going does not count", await found([{ ...good, conclusion: null }], [marker(1)]), null);
eq("another workflow's run does not count", await found([{ ...good, path: ".github/workflows/nightly.yml" }], [marker(1)]), null);
eq("a workflow path with a ref suffix still counts", await found([{ ...good, path: WORKFLOW + "@refs/heads/x" }], [marker(1)]), 1);
eq("a run from a fork does not count", await found([{ ...good, head_repository: { full_name: "fork/repo" } }], [marker(1)]), null);
eq("an expired marker does not count", await found([good], [marker(1, { expired: true })]), null);
eq("a marker with another name does not count", await found([good], [marker(1, { name: markerName("b".repeat(40)) })]), null);
eq("the current run's own marker does not count", await found([good], [marker(1)], 1), null);
eq("a later good run is found after a bad one", await found([{ ...good, conclusion: "failure" }, { ...good, id: 2 }], [marker(1), marker(2)]), 2);

let threw = "";
try { await found([], [marker(7)]); } catch (error) { threw = error.message; }
eq("an API failure reaches the caller, which then runs every check", threw.includes("HTTP 404"), true);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
