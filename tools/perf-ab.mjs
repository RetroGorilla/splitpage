import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import { REPO } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";
import { buildArgs, parsePerf } from "./perf-record.mjs";
import { median } from "./perf-stats.mjs";
import { withRefTrees } from "./ref-trees.mjs";

const MEMORY_POLL_MS = 30000;
const MEMORY_WAIT_MS = 30 * 60 * 1000;

const wholeNumber = (raw, what) => {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${what} needs a positive whole number`);
  return Number(raw);
};

export function parseArgs(argv) {
  const refs = [];
  let rounds = null;
  let only = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rounds") rounds = wholeNumber(argv[++i] ?? "", "--rounds");
    else if (arg === "--only") only = argv[++i] ?? "";
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else refs.push(arg);
  }
  if (refs.length < 1 || refs.length > 2) {
    throw new Error("usage: node tools/perf-ab.mjs <base> [head=HEAD] [--only short,long,images,shared,shared-long] [--rounds 3]");
  }
  const allowed = ["short", "long", "images"];
  only ??= allowed.join(",");
  const fixtures = only.split(",");
  allowed.push("shared", "shared-long");
  if (fixtures.some((f) => !allowed.includes(f)) || new Set(fixtures).size !== fixtures.length) throw new Error(`--only needs distinct fixtures from ${allowed.join(",")}`);
  return { base: refs[0], head: refs[1] ?? "HEAD", rounds: rounds ?? 3, only };
}

export function writeRecord(path, record) {
  let kept = {};
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, "utf8"));
    if (!old || typeof old !== "object" || Array.isArray(old)) throw new Error("the results file does not hold a results object");
    kept = old;
  }
  writeFileSync(path, JSON.stringify({ ...kept, [record.kind]: record }, null, 2) + "\n");
}

export async function toolRevision(run, paths, dryRun) {
  const changed = (await run("git", ["status", "--porcelain", "--", ...paths])).trim();
  if (changed && !dryRun) throw new Error(`commit the measuring tools before a real run; changed: ${changed.split("\n").length} path(s) under ${paths.join(", ")}`);
  return { commit: (await run("git", ["rev-parse", "HEAD"])).trim(), changed: changed.length > 0 };
}

export function abbaOrder(round) {
  return round % 2 === 1 ? ["base", "head"] : ["head", "base"];
}

export async function waitForMemory(minMb, { free = () => freemem() / 2 ** 20, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = MEMORY_POLL_MS, waitMs = MEMORY_WAIT_MS } = {}) {
  let waited = 0;
  for (;;) {
    const now = Math.round(free());
    if (now >= minMb) return now;
    if (waited >= waitMs) throw new Error(`free memory stayed under ${minMb} MB (${now} MB) for ${Math.round(waitMs / 60000)} minutes`);
    console.error(`perf-ab: ${now} MB free, waiting for ${minMb} MB`);
    await sleep(pollMs);
    waited += pollMs;
  }
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
      const row = { label: cells[0], p50: number(cells[2]), p95: number(cells[3]) };
      if (/^\d+$/.test(cells[7] ?? "")) row.rects = number(cells[7]);
      rows.push(row);
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
  if (runs.base[0].some((r) => r.rects !== undefined)) {
    lines.push("", "Range.getClientRects calls per run (base / head):", "");
    labels.forEach((label, i) => {
      if (runs.base[0][i].rects === undefined) return;
      lines.push(`- ${label}: ${runs.base.map((r) => r[i].rects).join(", ")} / ${runs.head.map((r) => r[i].rects).join(", ")}`);
    });
  }
  return lines.join("\n");
}

export async function main(argv, repo = REPO) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`perf-ab: ${error.message}`);
    return 1;
  }
  return withRefTrees(repo, "perf-ab", [["base", args.base], ["head", args.head]], async ({ dirs, shas, run }) => {
    for (const side of ["base", "head"]) {
      const build = buildArgs(readFileSync(join(dirs[side], "build.mjs"), "utf8"));
      console.error(`perf-ab: ${side} building with node ${build.join(" ")}${build.length === 1 ? " (legacy build; --test unavailable)" : ""}`);
      await run(process.execPath, build, dirs[side]);
    }
    const fixtures = args.only.split(",");
    const helpers = ["tools", ".claude/skills/run-splitpage-app"];
    if (fixtures.includes("shared-long")) helpers.push("tests/adapters/collab/native/presence-perf-peer.mjs");
    for (const path of helpers) {
      cpSync(join(dirs.head, path), join(dirs.base, path), { recursive: true });
    }
    const runs = { base: [], head: [] };
    const standalone = fixtures.filter(fixture => !fixture.startsWith("shared")).join(",");
    for (let round = 1; round <= args.rounds; round++) {
      for (const side of ["base", "head"]) {
        console.error(`perf-ab: round ${round}/${args.rounds} ${side}`);
        const rows = standalone ? measurements(await run(process.execPath,
          ["tools/perf-record.mjs", "--built", "--only", standalone], dirs[side])) : [];
        for (const fixture of fixtures.filter(name => name.startsWith("shared"))) {
          const flag = fixture === "shared-long" ? "--perf-long" : "--perf";
          const shared = parsePerf(await run(process.execPath, ["tools/run-presence-browser.mjs", flag], dirs[side]));
          if (shared.length !== 2 || shared.some(row => row.keys < 40)) throw new Error("missing " + fixture + " typing samples");
          rows.push(...shared.map(row => ({ ...row, rects: row.rangeRects })));
        }
        runs[side].push(rows);
      }
    }
    console.log(report(shas.base, shas.head, runs));
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
