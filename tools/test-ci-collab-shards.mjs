import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO } from "./source-scan.mjs";
import { needsChecks, needsCollabChecks, needsRootTests } from "./ci-changes.mjs";

const WORKFLOW_TEXT = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
const PACKAGE_TEXT = readFileSync(join(REPO, "prototypes/collab/package.json"), "utf8");

function collabShardProblems(workflow, pkg) {
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const { checks } = workflow.jobs;
  const collabTests = workflow.jobs["collab-tests"];
  if (!collabTests) return ["no collab-tests job"];
  check(!checks.steps.some((s) => s["working-directory"] === "prototypes/collab" || /node --test|npm test/.test(s.run ?? "")), "checks runs prototype tests itself");
  check(checks.steps.find((s) => s.name === "Install tooling")?.run.includes("npm ci --prefix prototypes/collab"), "checks no longer installs prototypes/collab for typecheck");
  const parity = checks.steps.filter((s) => s.run === "node tools/test-ci-collab-shards.mjs");
  check(parity.length === 1 && parity[0].if === "needs.changes.outputs.collab == 'true'", "checks does not run this parity check whenever the prototype tests are due");
  check(collabTests.needs === "changes", "collab-tests needs only changes");
  check(collabTests.if === "needs.changes.outputs.collab == 'true' && needs.changes.outputs.tested != 'true'", "collab-tests condition changed");
  check(collabTests["runs-on"] === checks["runs-on"], "collab-tests runs elsewhere than checks");
  check(collabTests.strategy?.["fail-fast"] === false, "collab-tests fails fast");
  const shards = collabTests.strategy?.matrix?.shard ?? [];
  check(shards.length > 1 && shards.every((n, i) => n === i + 1), "collab-tests shards are not 1..n");
  check(collabTests.name === `Collaboration prototype tests (\${{ matrix.shard }}/${shards.length})`, "collab-tests name does not show the shard count");
  const installs = collabTests.steps.filter((s) => /\bnpm ci\b/.test(s.run ?? ""));
  check(JSON.stringify(installs.map((s) => [s.run, s["working-directory"]])) === JSON.stringify([["npm ci", "prototypes/collab"]]), "collab-tests installs more than the prototype");
  const script = pkg.scripts?.test ?? "";
  check(/^node --test "/.test(script), "the prototype's test script no longer starts with node --test and a pattern");
  const runs = collabTests.steps.filter((s) => s.run?.includes("node --test"));
  const want = script.replace(/^node --test /, `node --test --test-shard="\${{ matrix.shard }}/${shards.length}" `);
  check(runs.length === 1 && runs[0].run === want && runs[0]["working-directory"] === "prototypes/collab", `shard command differs from the prototype's test script: want ${want}`);
  check(runs.length === 1 && installs.length === 1 && collabTests.steps.indexOf(installs[0]) < collabTests.steps.indexOf(runs[0]), "collab-tests tests before installing");
  return problems;
}

const workflow = () => parse(WORKFLOW_TEXT);
const pkg = () => JSON.parse(PACKAGE_TEXT);

assert.deepEqual(collabShardProblems(workflow(), pkg()), []);

const scriptChanged = pkg();
scriptChanged.scripts.test = scriptChanged.scripts.test.replace('"test/**/*.test.mjs"', '"test/**/*.test.mjs" "probe/**/*.test.ts"');
assert.notEqual(scriptChanged.scripts.test, pkg().scripts.test);
assert.match(collabShardProblems(workflow(), scriptChanged).join("\n"), /shard command differs/);

const commandChanged = workflow();
const shardStep = commandChanged.jobs["collab-tests"].steps.find((s) => s.run?.includes("node --test"));
shardStep.run = shardStep.run.replace(' "test/**/*.test.mjs"', "");
assert.match(collabShardProblems(commandChanged, pkg()).join("\n"), /shard command differs/);

const parityDropped = workflow();
parityDropped.jobs.checks.steps = parityDropped.jobs.checks.steps.filter((s) => s.run !== "node tools/test-ci-collab-shards.mjs");
assert.match(collabShardProblems(parityDropped, pkg()).join("\n"), /parity check/);

const prototypeOnly = ["prototypes/collab/package.json"];
assert.deepEqual([needsChecks(prototypeOnly), needsCollabChecks(prototypeOnly), needsRootTests(prototypeOnly)], [true, true, false]);
const parsed = workflow();
assert.equal(parsed.jobs.checks.if, "needs.changes.outputs.code == 'true' && needs.changes.outputs.tested != 'true'");

console.log("collab shard command matches the prototype's test script; changing either side alone fails");
