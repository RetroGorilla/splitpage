import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, measurements, median, parseArgs, report } from "./perf-ab.mjs";
import { REPO } from "./source-scan.mjs";

test("arguments reject ambiguous or invalid comparisons", () => {
  assert.deepEqual(parseArgs(["base"]), { base: "base", head: "HEAD", rounds: 3, only: "short,long,images" });
  assert.deepEqual(parseArgs(["base", "head", "--only", "short", "--rounds", "2"]), { base: "base", head: "head", rounds: 2, only: "short" });
  for (const args of [[], ["a", "b", "c"], ["a", "--rounds", "0"], ["a", "--rounds", "1.5"], ["a", "--only"], ["a", "--only", "short,short"], ["a", "--only", "huge"], ["a", "--bogus"]]) {
    assert.throws(() => parseArgs(args));
  }
});

test("report preserves run order and computes medians and changes", () => {
  assert.equal(median([10, 1, 3, 2]), 2.5);
  const row = (p50, p95 = p50) => [{ label: "short typing", p50, p95 }];
  const out = report("base", "head", { base: [row(10), row(2)], head: [row(9), row(3)] });
  assert.match(out, /\| short typing \| 6 \| 6 \| \+0.0% \| 6 \| 6 \| \+0.0% \| 10, 2 \/ 10, 2 \| 9, 3 \/ 9, 3 \|/);
  assert.match(report("b", "h", { base: [row(0, null)], head: [row(1, null)] }), /\| 0 \| 1 \| — \| — \| — \| — \|/);
  assert.throws(() => report("b", "h", { base: [row(1)], head: [[{ label: "other", p50: 1, p95: 1 }]] }));
  assert.throws(() => measurements("no results"));
  assert.throws(() => measurements("## Input latency\n| short typing | 1 | — | 2 |"));
  const parsed = measurements("## Export (ms)\n| Fixture | .splitpage | .md project | Standalone HTML |\n| --- | --- | --- | --- |\n| short | 1 | 2 | 3 |\n## Image-heavy load and merge\n| images open | 10 | 1, 2, 3 | 1 | 2 |");
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[3], { label: "images open", p50: 2, p95: null });
});

test("scratch comparisons use head helpers, alternate and clean up after success and failures", async () => {
  const work = mkdtempSync(join(tmpdir(), "perf-ab-test-"));
  const repo = join(work, "repo");
  mkdirSync(join(repo, "tools"), { recursive: true });
  mkdirSync(join(repo, ".claude/skills/run-splitpage-app"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const log = join(work, "runs.txt");
  const oldFail = process.env.PERF_AB_TEST_FAIL;
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    symlinkSync(join(REPO, "node_modules"), join(repo, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(repo, ".gitignore"), "node_modules\nbuilt\n");
    writeFileSync(join(repo, "build.mjs"), `import { appendFileSync, copyFileSync } from "node:fs"; if (process.env.PERF_AB_TEST_FAIL === "build") throw new Error("build failure"); if (process.env.PERF_AB_TEST_FAIL === "cancel") { appendFileSync(${JSON.stringify(log)}, "cancel\\n"); await new Promise((resolve) => setTimeout(resolve, 30000)); } copyFileSync("version", "built");`);
    writeFileSync(join(repo, "version"), "base");
    writeFileSync(join(repo, "tools/helper.mjs"), 'export const value = "base";');
    writeFileSync(join(repo, "tools/perf-record.mjs"), 'throw new Error("base recorder must never run");');
    writeFileSync(join(repo, ".claude/skills/run-splitpage-app/helper.mjs"), 'export const driver = "base";');
    git("add", ".");
    git("commit", "-qm", "Base fixture");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "version"), "head");
    writeFileSync(join(repo, "tools/helper.mjs"), 'export const value = "head";');
    writeFileSync(join(repo, ".claude/skills/run-splitpage-app/helper.mjs"), 'export const driver = "head";');
    writeFileSync(join(repo, "tools/perf-record.mjs"), `import { appendFileSync, readFileSync } from "node:fs"; import { value } from "./helper.mjs"; import { driver } from "../.claude/skills/run-splitpage-app/helper.mjs"; if (value !== "head" || driver !== "head" || process.argv.slice(2).join(" ") !== "--only short" || process.env.PERF_AB_TEST_FAIL === "perf") throw new Error("perf failure"); appendFileSync(${JSON.stringify(log)}, readFileSync("built", "utf8") + "\\n"); console.log("## Input latency (ms)\\n| short typing | 1 | 2 | 3 |");`);
    git("add", ".");
    git("commit", "-qm", "Head fixture");
    assert.equal(await main([base, "--only", "short", "--rounds", "2"], repo), 0);
    assert.equal(readFileSync(log, "utf8"), "base\nhead\nbase\nhead\n");
    const count = () => git("worktree", "list", "--porcelain").split("worktree ").length - 1;
    assert.equal(count(), 1);
    for (const failure of ["build", "perf"]) {
      process.env.PERF_AB_TEST_FAIL = failure;
      assert.equal(await main([base, "--only", "short", "--rounds", "1"], repo), 1);
      assert.equal(count(), 1);
    }
    process.env.PERF_AB_TEST_FAIL = "cancel";
    const timer = setInterval(() => {
      if (readFileSync(log, "utf8").endsWith("cancel\n")) process.emit("SIGINT");
    }, 25);
    try {
      assert.equal(await main([base, "--only", "short"], repo), 1);
      assert.equal(count(), 1);
    } finally {
      clearInterval(timer);
    }
    assert.equal(spawnSync(process.execPath, [join(REPO, "tools/perf-ab.mjs")], { encoding: "utf8" }).status, 1);
  } finally {
    if (oldFail === undefined) delete process.env.PERF_AB_TEST_FAIL;
    else process.env.PERF_AB_TEST_FAIL = oldFail;
    unlinkSync(join(repo, "node_modules"));
    rmSync(work, { recursive: true, force: true });
  }
});
