import { appendFileSync } from "node:fs";
import { isMain } from "./main-module.mjs";
import { WORKFLOW, githubGet, passedRun, treeOf } from "./ci-tested-tree.mjs";

export const GATE = "gate";

function runIdOf(url) {
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(String(url ?? ""));
  return match ? match[1] : null;
}

export const PAGE_SIZE = 100;
export const MAX_PAGES = 30;

export async function listAll(get, path, key) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await get(`${path}&page=${page}`);
    const batch = body[key] ?? [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  throw new Error(`GET ${path}: more than ${MAX_PAGES * PAGE_SIZE} results`);
}

function allArtifacts(get) {
  return async (path) => (path.includes("/actions/artifacts?") ? { artifacts: await listAll(get, path, "artifacts") } : get(path));
}

export async function gateRun({ sha, repository, get }) {
  const checks = await listAll(get, `/repos/${repository}/commits/${sha}/check-runs?check_name=${GATE}&per_page=${PAGE_SIZE}`, "check_runs");
  let seen = 0;
  for (const check of checks) {
    if (check.name !== GATE || check.app?.slug !== "github-actions" || check.head_sha !== sha) continue;
    seen++;
    if (check.status !== "completed" || check.conclusion !== "success") continue;
    const id = runIdOf(check.details_url);
    if (!id) continue;
    const run = await get(`/repos/${repository}/actions/runs/${id}`);
    if (String(run.path ?? "").split("@")[0] !== WORKFLOW) continue;
    if (run.head_sha !== sha || run.head_repository?.full_name !== repository) continue;
    return { run, seen };
  }
  return { run: null, seen };
}

export async function checkRelease({ sha, tree, repository, runId, get }) {
  const problems = [];
  try {
    const { run, seen } = await gateRun({ sha, repository, get });
    if (run) return { ok: true, via: `the ${GATE} job of ${run.html_url}`, problems };
    problems.push(seen ? `${seen} ${GATE} check run(s) found, none a success of ${WORKFLOW}` : `no ${GATE} check run found`);
  } catch (error) {
    return { ok: false, via: null, problems: [`${GATE} lookup failed: ${error.message}`] };
  }
  if (!tree) {
    problems.push("the tree of the commit is unknown, so no passed-tree marker can be looked up");
  } else {
    try {
      const run = await passedRun({ tree, repository, runId, get: allArtifacts(get) });
      if (run) return { ok: true, via: `a passed-tree marker from ${run.html_url} (tree ${tree})`, problems };
      problems.push(`no unexpired ci-passed-tree-${tree} marker from a successful ${WORKFLOW} run`);
    } catch (error) {
      problems.push(`passed-tree lookup failed: ${error.message}`);
    }
  }
  return { ok: false, via: null, problems };
}

export function describe({ result, sha, dispatch }) {
  if (result.ok) return { exit: 0, lines: [`release-ci-check: commit ${sha} passed CI via ${result.via}`] };
  const level = dispatch ? "warning" : "error";
  const lines = [`::${level}::commit ${sha} has no passed CI run: ${result.problems.join("; ")}`];
  if (dispatch) lines.push("release-ci-check: manual run, a dry run that drafts nothing, so this is only a warning");
  return { exit: dispatch ? 0 : 1, lines };
}

if (isMain(import.meta.url)) {
  const { GITHUB_API_URL = "https://api.github.com", GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_OUTPUT } = process.env;
  const dispatch = GITHUB_EVENT_NAME === "workflow_dispatch";
  let result;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_SHA) {
    result = { ok: false, via: null, problems: ["GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA must be set"] };
  } else {
    result = await checkRelease({ sha: GITHUB_SHA, tree: treeOf(GITHUB_SHA), repository: GITHUB_REPOSITORY, runId: GITHUB_RUN_ID, get: githubGet(GITHUB_API_URL, GITHUB_TOKEN) });
  }
  const { exit, lines } = describe({ result, sha: GITHUB_SHA, dispatch });
  for (const line of lines) console.log(line);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `passed=${result.ok}\n`);
  process.exit(exit);
}
