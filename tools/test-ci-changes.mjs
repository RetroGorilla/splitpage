import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { needsChecks, needsTabstrip, changedFiles } from "./ci-changes.mjs";
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
eq("a source file needs the checks", needsChecks(["README.md", "src/js/05-render.js"]), true);
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

console.log("\nneedsTabstrip():\n");

eq("tab strip styles run the width check", needsTabstrip(["desktop/tabstrip/tabstrip.css"]), true);
eq("tab strip script runs the width check", needsTabstrip(["desktop/tabstrip/tabstrip.js"]), true);
eq("the width check itself runs it", needsTabstrip(["desktop/test/tabstrip-width.mjs"]), true);
eq("the suite driver runs it", needsTabstrip(["tools/run-suites.mjs"]), true);
eq("a workflow change runs it", needsTabstrip([".github/workflows/ci.yml"]), true);
eq("an app source change skips it", needsTabstrip(["src/js/05-render.js", "desktop/main.js"]), false);
eq("an unknown diff runs it", needsTabstrip(null), true);
eq("an empty diff runs it", needsTabstrip([]), true);

console.log("\nchangedFiles():\n");

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

rmSync(repo, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
