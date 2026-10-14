import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";

export function parseArgs(argv) {
  const refs = [];
  let rounds = 3;
  let only = "short,long,images";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rounds") {
      const raw = argv[++i] ?? "";
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("--rounds needs a positive whole number");
      rounds = Number(raw);
    } else if (arg === "--only") {
      only = argv[++i] ?? "";
      const fixtures = only.split(",");
      if (fixtures.some((f) => !["short", "long", "images"].includes(f)) || new Set(fixtures).size !== fixtures.length) {
        throw new Error("--only needs distinct fixtures from short,long,images");
      }
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else refs.push(arg);
  }
  if (refs.length < 1 || refs.length > 2) throw new Error("usage: node tools/perf-ab.mjs <base> [head=HEAD] [--only short,long,images] [--rounds 3]");
  return { base: refs[0], head: refs[1] ?? "HEAD", rounds, only };
}

export function measurements(text) {
  const rows = [];
  let section = "";
  const number = (raw) => {
    if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`invalid measurement: ${raw}`);
    return Number(raw);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) section = line;
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "Case" || cells[0] === "Fixture" || cells[0] === "---") continue;
    if (section.startsWith("## Input latency")) {
      rows.push({ label: cells[0], p50: number(cells[2]), p95: number(cells[3]) });
    } else if (section.startsWith("## Export")) {
      [".splitpage", ".md project", "Standalone HTML"].forEach((format, i) => {
        rows.push({ label: `${cells[0]} export ${format}`, p50: number(cells[i + 1]), p95: null });
      });
    } else if (section.startsWith("## Image-heavy")) {
      rows.push({ label: cells[0], p50: number(cells[4]), p95: null });
    }
  }
  if (!rows.length || new Set(rows.map((r) => r.label)).size !== rows.length) throw new Error("missing or duplicate performance cases");
  return rows;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function report(base, head, runs) {
  const signature = (run) => JSON.stringify(run.map((r) => [r.label, r.p95 === null]));
  if (!runs.base.length || runs.base.length !== runs.head.length || [...runs.base, ...runs.head].some((r) => signature(r) !== signature(runs.base[0]))) {
    throw new Error("performance cases differ between runs");
  }
  const labels = runs.base[0].map((r) => r.label);
  const value = (n) => n === null ? "—" : String(+n.toFixed(3));
  const change = (b, h) => b === null || h === null || b === 0 ? "—" : `${h >= b ? "+" : ""}${(100 * (h - b) / b).toFixed(1)}%`;
  const lines = [
    `Input latency: median of ${runs.base.length} runs (ms). Export/image medians use the p50 columns; their p95 is unavailable.`,
    "",
    `| Case | Base p50 (${base.slice(0, 8)}) | Head p50 (${head.slice(0, 8)}) | Change | Base p95 | Head p95 | Change | Base runs (p50 / p95) | Head runs (p50 / p95) |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  labels.forEach((label, i) => {
    const stats = (side, key) => runs[side][0][i][key] === null ? null : median(runs[side].map((r) => r[i][key]));
    const b50 = stats("base", "p50"), h50 = stats("head", "p50"), b95 = stats("base", "p95"), h95 = stats("head", "p95");
    const every = (side) => ["p50", "p95"].map((key) => runs[side].map((r) => value(r[i][key])).join(", ")).join(" / ");
    lines.push(`| ${label} | ${value(b50)} | ${value(h50)} | ${change(b50, h50)} | ${value(b95)} | ${value(h95)} | ${change(b95, h95)} | ${every("base")} | ${every("head")} |`);
  });
  return lines.join("\n");
}

export async function main(argv, repo = REPO) {
  let scratch;
  let active;
  let interrupted;
  let cleaning = false;
  let status = 0;
  const trees = [];
  const stop = (signal) => {
    interrupted = signal;
    if (!active?.pid || cleaning) return;
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(active.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
      if (result.status !== 0) active.kill("SIGTERM");
    } else {
      try { process.kill(-active.pid, "SIGTERM"); } catch {}
    }
  };
  const run = (command, args, cwd = repo) => new Promise((resolve, reject) => {
    if (interrupted && !cleaning) return reject(new Error(`interrupted by ${interrupted}`));
    active = execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, detached: process.platform !== "win32" }, (error, stdout, stderr) => {
      active = undefined;
      if (interrupted && !cleaning) reject(new Error(`interrupted by ${interrupted}`));
      else if (error) reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stdout}${stderr}`));
      else resolve(stdout);
    });
  });
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const args = parseArgs(argv);
    const commit = async (ref) => (await run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    const base = await commit(args.base), head = await commit(args.head);
    if (!existsSync(join(repo, "node_modules"))) throw new Error("node_modules is missing; install the repo dependencies first");
    scratch = mkdtempSync(join(tmpdir(), "splitpage-perf-ab-"));
    for (const [side, sha] of [["base", base], ["head", head]]) {
      const dir = join(scratch, side);
      trees.push(dir);
      console.error(`perf-ab: preparing ${side} ${sha}`);
      await run("git", ["worktree", "add", "--detach", dir, sha]);
      symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await run(process.execPath, ["build.mjs"], dir);
    }
    const [baseTree, headTree] = trees;
    for (const path of ["tools", ".claude/skills/run-splitpage-app"]) {
      cpSync(join(headTree, path), join(baseTree, path), { recursive: true });
    }
    const runs = { base: [], head: [] };
    for (let round = 1; round <= args.rounds; round++) {
      for (const [side, dir] of [["base", baseTree], ["head", headTree]]) {
        console.error(`perf-ab: round ${round}/${args.rounds} ${side}`);
        runs[side].push(measurements(await run(process.execPath, ["tools/perf-record.mjs", "--only", args.only], dir)));
      }
    }
    console.log(report(base, head, runs));
  } catch (error) {
    console.error(`perf-ab: ${error.message}`);
    status = 1;
  } finally {
    cleaning = true;
    let cleaned = true;
    for (const dir of trees.reverse()) {
      try {
        if (existsSync(join(dir, "node_modules"))) unlinkSync(join(dir, "node_modules"));
        if (existsSync(dir)) await run("git", ["worktree", "remove", "--force", dir]);
      } catch (error) {
        cleaned = false;
        console.error(`perf-ab: cleanup failed: ${error.message}`);
      }
    }
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (scratch && cleaned) rmSync(scratch, { recursive: true, force: true });
    if (!cleaned) status = 1;
  }
  return status;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
