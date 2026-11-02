import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { needsChecks, needsAppChecks, needsDesktopChecks, changedFiles } from "./ci-changes.mjs";
import { isScanned, canScan } from "./comment-gate.mjs";
import { listRepoFiles } from "./source-scan.mjs";

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log("  ok   " + name); return; }
  const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  failures.push(`${name} — ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

console.log("\nneedsChecks():\n");

eq("prose alone skips the checks", needsChecks(["README.md", "docs/architecture/testing.md", ".claude/handoff/x/y.html"]), false);
eq("docs/help.md is built into the app", needsChecks(["docs/help.md"]), true);
eq("a source file needs the checks", needsChecks(["README.md", "src/bootstrap/05-render.js"]), true);
eq("a new folder needs the checks", needsChecks(["src/core/text/runs.ts"]), true);
eq("a browser suite needs the checks", needsChecks([".claude/skills/run-splitpage-app/tests/01-core.txt"]), true);
eq("a workflow change needs the checks", needsChecks([".github/workflows/ci.yml"]), true);
eq("an unknown diff runs everything", needsChecks(null), true);
eq("an empty diff runs everything", needsChecks([]), true);
eq("an issue template's YAML needs the checks: the comment gate reads it", needsChecks([".github/ISSUE_TEMPLATE/bug.yml"]), true);
eq("a Markdown issue template is still prose", needsChecks([".github/ISSUE_TEMPLATE/question.md"]), false);
eq("CODEOWNERS and LICENSE are prose", needsChecks([".github/CODEOWNERS", "LICENSE"]), false);

{
  const gated = (p) => isScanned(p) && canScan(p);
  const samples = [".github/ISSUE_TEMPLATE/bug.yml", ".github/ISSUE_TEMPLATE/config.yml", ".github/dependabot.yml", "docs/x.yaml", "tsconfig.json", "Dockerfile", "tools/x.sh"];
  eq("no file the comment gate reads is prose-only", samples.filter((p) => gated(p) && !needsChecks([p])), []);
  const tree = listRepoFiles().filter((p) => gated(p) && !needsChecks([p]));
  eq("and none in the repository is either", tree, []);
}

console.log("\nchangedFiles():\n");

for (const files of [null, [], ["src/features/rows/view.ts"], ["server/server.js"], ["docs/help.md"], ["build.mjs"], ["package-lock.json"], ["tools/run-suites.mjs"], [".github/workflows/ci.yml"], [".github/workflows/nightly.yml"], [".claude/skills/run-splitpage-app/tests/01-core.txt"], ["unknown/new.file"]]) {
  eq(`app checks stay enabled for ${JSON.stringify(files)}`, needsAppChecks(files), true);
}
for (const files of [["README.md"], ["tests/application/session.test.ts"], ["src/test/a.test.mjs"], ["desktop/test/smoke.mjs"], ["tools/test-run-suites.mjs"], ["tools/ci-changes.mjs"], [".github/ISSUE_TEMPLATE/bug.yml"], [".github/dependabot.yml"], [".github/workflows/windows-local.yml"], [".github/workflows/release.yml"]]) {
  eq(`app checks can skip ${JSON.stringify(files)}`, needsAppChecks(files), false);
  if (files[0] !== "README.md") eq("static checks and tests remain required", needsChecks(files), true);
}
eq("mixed app and metadata changes run app checks", needsAppChecks([".github/dependabot.yml", "src/page.html"]), true);
eq("mixed prose and test-only changes skip app checks", needsAppChecks(["README.md", "tests/core/a.test.ts"]), false);

console.log("\nneedsDesktopChecks():\n");

for (const files of [null, [], ["desktop/main.ts"], ["src/bootstrap/main.ts"], ["desktop/test/smoke.mjs"], ["package.json"], [".github/workflows/ci.yml"], ["unknown/new.file"], ["README.md", "desktop/test/smoke.mjs"]]) {
  eq(`the desktop smoke runs for ${JSON.stringify(files)}`, needsDesktopChecks(files), true);
}
for (const files of [["README.md"], ["tests/application/session.test.ts"], ["src/test/a.test.mjs"], ["tools/test-run-suites.mjs"], ["tools/ci-changes.mjs"], [".github/dependabot.yml"], [".github/workflows/release.yml"], ["desktop/test/notes.md"]]) {
  eq(`the desktop smoke skips ${JSON.stringify(files)}`, needsDesktopChecks(files), false);
}
eq("a smoke change that is not prose runs the smoke although app checks skip it", [needsAppChecks(["desktop/test/smoke.mjs"]), needsDesktopChecks(["desktop/test/smoke.mjs"])], [false, true]);

const repo = mkdtempSync(join(tmpdir(), "splitpage-ci-changes-"));
const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).stdout.trim();
git("init", "-q");
writeFileSync(join(repo, "a.md"), "a\n");
git("add", ".");
git("commit", "-qm", "one");
const base = git("rev-parse", "HEAD");
writeFileSync(join(repo, "b.js"), "b\n");
git("add", ".");
git("commit", "-qm", "two");
const head = git("rev-parse", "HEAD");

eq("the diff between two commits is listed", changedFiles(base, head, repo), ["b.js"]);
eq("a new branch's zero base is unknown", changedFiles("0000000000000000000000000000000000000000", head, repo), null);
eq("an unknown commit is unknown", changedFiles("deadbeef", head, repo), null);

mkdirSync(join(repo, "tests"));
renameSync(join(repo, "b.js"), join(repo, "tests/b.test.mjs"));
git("add", "-A");
git("commit", "-qm", "move production code into tests");
const moved = changedFiles(head, git("rev-parse", "HEAD"), repo);
eq("a rename keeps both the removed and added paths", moved, ["b.js", "tests/b.test.mjs"]);
eq("moving production code into a test folder still runs app checks", needsAppChecks(moved), true);

rmSync(repo, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
