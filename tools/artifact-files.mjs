import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const WORKFLOW = ".github/workflows/ci.yml";
export const ARTIFACT = "splitpage-app";

export function artifactPaths(workflowText, name = ARTIFACT) {
  const workflow = parse(workflowText) ?? {};
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []));
  const uploads = steps.filter((s) => typeof s?.uses === "string" && s.uses.startsWith("actions/upload-artifact@") && s.with?.name === name);
  if (uploads.length !== 1) throw new Error(`${WORKFLOW} has ${uploads.length} actions/upload-artifact steps named ${name}; expected exactly one`);
  const paths = String(uploads[0].with.path ?? "").split("\n").map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) throw new Error(`${WORKFLOW}'s ${name} upload lists no paths`);
  const unsupported = paths.filter((p) => /[*?[\]!]/.test(p) || p.startsWith("/") || p.split("/").includes(".."));
  if (unsupported.length) throw new Error(`cannot stage patterns or paths outside the checkout: ${unsupported.join(", ")}`);
  return paths.map((p) => p.replace(/\/+$/, ""));
}

export function stage(paths, into, repo = REPO) {
  const missing = paths.filter((p) => !existsSync(join(repo, p)));
  if (missing.length) throw new Error(`not in the checkout: ${missing.join(", ")} (run node build.mjs first)`);
  mkdirSync(into, { recursive: true });
  for (const p of paths) cpSync(join(repo, p), join(into, p), { recursive: true });
}

export function main(args, { repo = REPO, print = console.log, printError = console.error } = {}) {
  const valid = args.length === 0 || (args.length === 2 && args[0] === "--stage" && args[1] !== "");
  if (!valid) {
    printError("usage: node tools/artifact-files.mjs [--stage <dir>]");
    return 2;
  }
  try {
    const paths = artifactPaths(readFileSync(join(repo, WORKFLOW), "utf8"));
    if (args.length) {
      const into = resolve(args[1]);
      stage(paths, into, repo);
      print(`artifact-files: staged ${paths.length} paths of ${ARTIFACT} into ${into}`);
    }
    for (const p of paths) print(p);
    return 0;
  } catch (error) {
    printError(`artifact-files: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
