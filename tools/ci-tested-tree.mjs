import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./main-module.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

export const WORKFLOW = ".github/workflows/ci.yml";
export const MARKER = "ci-passed-tree-";

export function markerName(tree) {
  return MARKER + tree;
}

export function treeOf(ref = "HEAD", repo = REPO) {
  try {
    const tree = execFileSync("git", ["rev-parse", "--verify", "-q", `${ref}^{tree}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

export async function passedRun({ tree, repository, runId, get }) {
  const name = markerName(tree);
  const { artifacts = [] } = await get(`/repos/${repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
  for (const artifact of artifacts) {
    const id = artifact.workflow_run?.id;
    if (artifact.name !== name || artifact.expired || !id || String(id) === String(runId)) continue;
    const run = await get(`/repos/${repository}/actions/runs/${id}`);
    if (run.conclusion !== "success") continue;
    if (String(run.path ?? "").split("@")[0] !== WORKFLOW) continue;
    if (run.head_repository?.full_name !== repository) continue;
    return run;
  }
  return null;
}

export function githubGet(api, token) {
  return async (path) => {
    const response = await fetch(api + path, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" }
    });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return response.json();
  };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--lookup")) {
    console.error("usage: node tools/ci-tested-tree.mjs [--lookup]");
    process.exit(2);
  }
  const tree = treeOf();
  let tested = false;
  if (args[0] === "--lookup" && tree) {
    const { GITHUB_API_URL = "https://api.github.com", GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    try {
      const run = await passedRun({ tree, repository: GITHUB_REPOSITORY, runId: GITHUB_RUN_ID, get: githubGet(GITHUB_API_URL, GITHUB_TOKEN) });
      if (run) {
        tested = true;
        console.log(`ci-tested-tree: ${run.html_url} already passed this tree (${run.event}, head ${run.head_sha})`);
      } else {
        console.log("ci-tested-tree: no passed run of this tree, running every check");
      }
    } catch (error) {
      console.log(`::warning::ci-tested-tree: lookup failed, running every check: ${error.message}`);
    }
  }
  console.log(`ci-tested-tree: tree=${tree ?? "unknown"}`);
  console.log(`ci-tested-tree: tested=${tested}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tree=${tree ?? ""}\ntested=${tested}\n`);
}
