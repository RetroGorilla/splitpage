import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./main-module.mjs";
import { COLLAB_ORACLE_COPIES } from "./collab-oracle-copies.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const PROSE_ONLY = [
  /^\.claude\/handoff\//,
  /^\.github\/CODEOWNERS$/,
  /^LICENSE$/
];

const BUILD_PROSE = new Set(["docs/help.md"]);

const COPIED_PROTOTYPE_FILES = new Set(COLLAB_ORACLE_COPIES.map((pair) => pair.original));

const NON_APP = [
  /^prototypes\//,
  /^(tests|src\/test|desktop\/test)\//,
  /^tools\/test-[^/]+\.mjs$/,
  /^tools\/ci-changes\.mjs$/,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/dependabot\.yml$/,
  /^\.github\/workflows\/(windows-local|release)\.yml$/
];

export function needsChecks(files) {
  if (files === null || files.length === 0) return true;
  return files.some((f) => f.startsWith("prototypes/collab/") || BUILD_PROSE.has(f) || !(f.endsWith(".md") || PROSE_ONLY.some((re) => re.test(f))));
}

export function needsCollabChecks(files) {
  if (files === null || files.length === 0) return true;
  return files.some((f) => f.startsWith("prototypes/collab/") || f === ".github/workflows/ci.yml");
}

const MUTANT_SOURCES = [/^src\/adapters\/collab\//, /^src\/core\/collab\//, /^src\/application\/editing\//, /^tests\/collab\//, /^tools\/mutants\.mjs$/, /^\.github\/workflows\/ci\.yml$/];

export function needsCollabMutants(files) {
  if (files === null || files.length === 0) return true;
  return files.some((f) => !f.endsWith(".md") && MUTANT_SOURCES.some((re) => re.test(f)));
}

export function needsRootTests(files) {
  if (files === null || files.length === 0) return true;
  return files.some((f) => COPIED_PROTOTYPE_FILES.has(f) || (!f.startsWith("prototypes/collab/") && needsChecks([f])));
}

export function needsAppChecks(files) {
  if (files === null || files.length === 0) return true;
  return files.some((f) => needsChecks([f]) && !NON_APP.some((re) => re.test(f)));
}

export function needsDesktopChecks(files) {
  if (files === null || files.length === 0) return true;
  return needsAppChecks(files) || files.some((f) => needsChecks([f]) && /^desktop\/test\//.test(f));
}

export function changedFiles(base, head, repo = REPO) {
  if (!base || /^0+$/.test(base) || !head) return null;
  try {
    const out = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  const files = changedFiles(base, head);
  const code = needsChecks(files);
  const app = needsAppChecks(files);
  const desktop = needsDesktopChecks(files);
  const collab = needsCollabChecks(files);
  const rootTests = needsRootTests(files);
  const mutants = needsCollabMutants(files);
  console.log(files === null ? "ci-changes: no usable diff, running every check" : `ci-changes: ${files.length} files changed`);
  for (const f of files ?? []) console.log(`  ${f}`);
  console.log(`ci-changes: code=${code}`);
  console.log(`ci-changes: app=${app}`);
  console.log(`ci-changes: desktop=${desktop}`);
  console.log(`ci-changes: collab=${collab}`);
  console.log(`ci-changes: root_tests=${rootTests}`);
  console.log(`ci-changes: mutants=${mutants}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\napp=${app}\ndesktop=${desktop}\ncollab=${collab}\nroot_tests=${rootTests}\nmutants=${mutants}\n`);
}
