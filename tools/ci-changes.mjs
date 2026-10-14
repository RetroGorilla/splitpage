import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./main-module.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const PROSE_ONLY = [
  /^\.claude\/handoff\//,
  /^\.github\/CODEOWNERS$/,
  /^LICENSE$/
];

const BUILD_PROSE = new Set(["docs/help.md"]);

export function needsChecks(files) {
  if (files === null || files.length === 0) return true;
  return files.some((f) => BUILD_PROSE.has(f) || !(f.endsWith(".md") || PROSE_ONLY.some((re) => re.test(f))));
}

const TABSTRIP = [
  /^desktop\/tabstrip\//,
  /^desktop\/test\/tabstrip-width\.mjs$/,
  /^tools\/run-suites\.mjs$/,
  /^\.github\/workflows\/ci\.yml$/,
  /^tools\/ci-changes\.mjs$/
];

export function needsTabstrip(files) {
  if (files === null || files.length === 0) return true;
  return files.some((f) => TABSTRIP.some((re) => re.test(f)));
}

export function changedFiles(base, head, repo = REPO) {
  if (!base || /^0+$/.test(base) || !head) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", "-z", `${base}...${head}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  const files = changedFiles(base, head);
  const code = needsChecks(files);
  const tabstrip = needsTabstrip(files);
  console.log(files === null ? "ci-changes: no usable diff, running every check" : `ci-changes: ${files.length} files changed`);
  for (const f of files ?? []) console.log(`  ${f}`);
  console.log(`ci-changes: code=${code} tabstrip=${tabstrip}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\ntabstrip=${tabstrip}\n`);
}
