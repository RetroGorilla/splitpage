import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, commentsIn, listRepoFiles, lineOf } from "./source-scan.mjs";

export const BASELINE_PATH = join(REPO, "tools", "comment-baseline.json");

export const EXEMPT = [
  /(^|\/)node_modules\//,
  /^\.claude\/handoff\//,
  /^index\.html$/,
  /^eslint\.config\.mjs$/
];

export const COMMENT_FREE = [
  /^src\/core\//,
  /^src\/application\//,
  /^src\/contracts\//,
  /^src\/adapters\//,
  /^src\/features\//,
  /^src\/bootstrap\//,
  /^src\/legacy\//,
  /^tests\//
];

export const REQUIRED_MARKERS = {
  "src/page.html": ["/*{{APP_CSS}}*/", "//{{APP_JS}}"]
};

export function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function isScanned(path) {
  return !EXEMPT.some((re) => re.test(path));
}

export function commentFree(path) {
  return COMMENT_FREE.some((re) => re.test(path));
}

export function scanFile(path, text, markers = REQUIRED_MARKERS) {
  const found = commentsIn(path, text);
  if (found === null) return null;
  const allowed = [...(markers[path] ?? [])];
  const comments = [];
  for (const c of found) {
    const i = allowed.indexOf(c.text);
    if (i !== -1) { allowed.splice(i, 1); continue; }
    comments.push({ text: normalize(c.text), line: lineOf(text, c.start) });
  }
  return comments;
}

export function checkComments(files, baseline, markers = REQUIRED_MARKERS) {
  const added = [];
  const current = {};
  const known = baseline.files ?? {};
  for (const { path, text } of files) {
    const comments = scanFile(path, text, markers);
    if (!comments || comments.length === 0) continue;
    current[path] = comments.map((c) => c.text).sort();
    const remaining = commentFree(path) ? [] : [...(known[path] ?? [])];
    for (const c of comments) {
      const i = remaining.indexOf(c.text);
      if (i === -1) added.push({ path, ...c });
      else remaining.splice(i, 1);
    }
  }
  const stale = [];
  for (const [path, texts] of Object.entries(known)) {
    const remaining = commentFree(path) ? [] : [...(current[path] ?? [])];
    for (const text of texts) {
      const i = remaining.indexOf(text);
      if (i === -1) stale.push({ path, text });
      else remaining.splice(i, 1);
    }
  }
  return { added, stale, current };
}

export function loadFiles(repo = REPO) {
  return listRepoFiles(repo)
    .filter(isScanned)
    .filter((p) => existsSync(join(repo, p)))
    .map((path) => ({ path, text: readFileSync(join(repo, path), "utf8") }))
    .filter((f) => commentsIn(f.path, "") !== null);
}

function readBaseline(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { files: {} };
}

function writeBaseline(path, files) {
  const sorted = Object.fromEntries(Object.keys(files).sort().filter((p) => !commentFree(p)).map((p) => [p, files[p]]));
  writeFileSync(path, JSON.stringify({ files: sorted }, null, 2) + "\n");
}

function short(text) {
  return text.length > 90 ? text.slice(0, 87) + "..." : text;
}

export function run({ repo = REPO, baselinePath = BASELINE_PATH, mode = "check", print = console.log, printError = console.error } = {}) {
  const files = loadFiles(repo);
  const baseline = readBaseline(baselinePath);
  const { added, stale, current } = checkComments(files, baseline);
  const total = Object.values(current).reduce((n, list) => n + list.length, 0);

  if (mode === "init") {
    if (existsSync(baselinePath)) { printError(`comment-gate: ${baselinePath} already exists; use --prune`); return 2; }
    const blocked = added.filter((a) => commentFree(a.path));
    if (blocked.length) {
      for (const a of blocked) printError(`  ${a.path}:${a.line} ${short(a.text)}`);
      printError("comment-gate: comment-free folders cannot enter a baseline");
      return 1;
    }
    writeBaseline(baselinePath, current);
    print(`comment-gate: wrote a baseline of ${total} comments in ${Object.keys(current).length} files`);
    return 0;
  }

  print(`comment-gate: ${files.length} files scanned, ${total} baselined comments remain`);
  if (added.length) {
    for (const a of added) printError(`  new comment ${a.path}:${a.line} ${short(a.text)}`);
    printError("comment-gate: FAILED — authored code carries no comments; see docs/IMPLEMENTATION-PLAN.md section 2");
    return 1;
  }
  if (mode === "prune") {
    writeBaseline(baselinePath, current);
    print(`comment-gate: removed ${stale.length} entries from the baseline`);
    return 0;
  }
  if (stale.length) {
    for (const s of stale) printError(`  removed ${s.path} ${short(s.text)}`);
    printError("comment-gate: FAILED — the baseline lists comments that are gone; run `node tools/comment-gate.mjs --prune`");
    return 1;
  }
  print("comment-gate: OK");
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const flag = process.argv[2];
  const mode = { "--init": "init", "--prune": "prune" }[flag] ?? (flag ? null : "check");
  if (mode === null) {
    console.error(`comment-gate: unknown argument ${flag}; use --prune or --init`);
    process.exitCode = 2;
  } else {
    process.exitCode = run({ mode });
  }
}
