import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import { join, resolve } from "node:path";
import { REPO } from "./source-scan.mjs";
import { isMain } from "./main-module.mjs";
import { KEY_GAP_MS, TYPED, buildArgs } from "./perf-record.mjs";
import { GROUP_NAMES, REMOTE_RATES, SHARED_FIXTURES } from "./perf-shared.mjs";
import { TRACE_CATEGORIES } from "./perf-trace.mjs";
import { PERCENTILE_RULE, median } from "./perf-stats.mjs";
import { withRefTrees } from "./ref-trees.mjs";

const SHARED_MIN_ROUNDS = 5;
const DEFAULT_MIN_FREE_MB = 3000;
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
  let shared = false, dryRun = false, out = null, minFreeMb = DEFAULT_MIN_FREE_MB;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rounds") rounds = wholeNumber(argv[++i] ?? "", "--rounds");
    else if (arg === "--only") only = argv[++i] ?? "";
    else if (arg === "--shared") shared = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--out") { out = argv[++i] ?? ""; if (!out) throw new Error("--out needs a file"); }
    else if (arg === "--min-free-mb") minFreeMb = wholeNumber(argv[++i] ?? "", "--min-free-mb");
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else refs.push(arg);
  }
  if (refs.length < 1 || refs.length > 2) {
    throw new Error("usage: node tools/perf-ab.mjs <base> [head=HEAD] [--only short,long,images] [--rounds 3] | --shared [--only short,long,large,edited] [--rounds 5] [--out results.json] [--min-free-mb 3000] [--dry-run]");
  }
  const allowed = shared ? SHARED_FIXTURES : ["short", "long", "images"];
  only ??= allowed.join(",");
  const fixtures = only.split(",");
  if (fixtures.some((f) => !allowed.includes(f)) || new Set(fixtures).size !== fixtures.length) throw new Error(`--only needs distinct fixtures from ${allowed.join(",")}`);
  if (!shared) {
    if (dryRun || out !== null || minFreeMb !== DEFAULT_MIN_FREE_MB) throw new Error("--dry-run, --out and --min-free-mb belong to --shared");
    return { base: refs[0], head: refs[1] ?? "HEAD", rounds: rounds ?? 3, only };
  }
  rounds ??= SHARED_MIN_ROUNDS;
  if (rounds < SHARED_MIN_ROUNDS && !dryRun) throw new Error(`--shared needs at least ${SHARED_MIN_ROUNDS} rounds; fewer only with --dry-run, which is not evidence`);
  return { base: refs[0], head: refs[1] ?? "HEAD", rounds, only, shared, dryRun, out: out && resolve(out), minFreeMb };
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

const TRIAL_METHOD_FILE = "tests/collab/measure/trial-method.mjs";
const TRIAL_COPY_FILE = "tests/collab/measure/trial-method-copy.mjs";

export function placeTools(repo, dir, paths) {
  for (const path of paths) cpSync(join(repo, path), join(dir, path), { recursive: true });
  // why: A revision without the standing trial replica is measured with its copy per update; the module is chosen here,
  // so the measurement imports nothing by a computed name.
  if (existsSync(join(dir, TRIAL_COPY_FILE)) && !existsSync(join(dir, "src/adapters/collab/trial-replica.ts"))) cpSync(join(dir, TRIAL_COPY_FILE), join(dir, TRIAL_METHOD_FILE));
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

export const PASSES = Object.freeze(["untraced", "traced"]);
export const NOISE_FLOORS = Object.freeze({ p50: 0.5, p95: 3 });

export function passOrder(round) {
  return round % 2 === 1 ? [...PASSES] : [...PASSES].reverse();
}

const caseRuns = (record, side, pass) => record.rounds.filter((r) => r.side === side && (r.pass ?? "traced") === pass).map((r) => r.rows.filter((x) => x.kind === "case"));
const caseLabels = (record) => [...new Set(record.rounds.flatMap((r) => r.rows.filter((x) => x.kind === "case").map((x) => x.label)))];
const valuesOf = (runs, label, pick) => runs.map((run) => run.find((x) => x.label === label)).filter(Boolean).map(pick).filter((v) => v !== null && v !== undefined);

export function tracingNoise(record) {
  const rows = [];
  for (const side of ["base", "head"]) for (const label of caseLabels(record)) for (const measure of Object.keys(NOISE_FLOORS)) {
    const untraced = valuesOf(caseRuns(record, side, "untraced"), label, (x) => x[measure]), traced = valuesOf(caseRuns(record, side, "traced"), label, (x) => x[measure]);
    if (!untraced.length || !traced.length) continue;
    const base = median(untraced), allowed = Math.max(Math.max(...untraced) - Math.min(...untraced), 0.15 * base, NOISE_FLOORS[measure]);
    rows.push({ side, label, measure, untraced: base, traced: median(traced), allowed, within: median(traced) <= base + allowed && median(traced) >= base - allowed });
  }
  return { rows, within: rows.length > 0 && rows.every((row) => row.within) };
}

export function sharedSummary(record) {
  const sides = ["base", "head"], noise = tracingNoise(record);
  const budgetPass = noise.within ? "traced" : "untraced";
  const stat = (side, pass, label, pick) => {
    const values = valuesOf(caseRuns(record, side, pass), label, pick);
    return values.length ? median(values) : null;
  };
  const value = (n) => n === null ? "—" : String(+n.toFixed(3));
  const delta = (b, h) => b === null || h === null ? "—" : `${h >= b ? "+" : ""}${+(h - b).toFixed(3)}`;
  const columns = [["p50", budgetPass, (x) => x.p50], ["p95", budgetPass, (x) => x.p95], ["long-task ms", budgetPass, (x) => x.longTaskMs],
    ...GROUP_NAMES.map((g) => [`${g} ms`, "traced", (x) => x.groups?.[g]])];
  const lines = [
    ...(record.dryRun ? ["Dry run: pipeline check only, not evidence.", ""] : []),
    `Shared composed-editor comparison: base ${record.revisions.base.commit.slice(0, 8)}, head ${record.revisions.head.commit.slice(0, 8)}; median of ${caseRuns(record, "base", "traced").length} rounds per side and pass in ABBA order, tools from ${record.revisions.tool.commit.slice(0, 8)} in both trees. Each cell is base / head / head minus base. Within a run, ${PERCENTILE_RULE}.`,
    "",
    noise.within
      ? "Tracing moved no latency figure past the noise rule of audit 7 section 6, so one traced pass serves both: the budget figures and the parts both come from the traced pass. Both passes are given below."
      : "Tracing moved a latency figure past the noise rule of audit 7 section 6, so the budget figures (p50, p95, long tasks) come from the untraced pass and the parts from the traced pass of the same schedule and revision. Both passes are given below.",
    "",
    `| Case | ${columns.map(([name]) => name).join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`
  ];
  for (const label of caseLabels(record)) {
    lines.push(`| ${label} | ${columns.map(([, pass, pick]) => {
      const [b, h] = sides.map((side) => stat(side, pass, label, pick));
      return `${value(b)} / ${value(h)} / ${delta(b, h)}`;
    }).join(" | ")} |`);
  }
  lines.push("", "Tracing against the noise rule (untraced median, traced median, allowed difference: the larger of the untraced range, 15 % and the floor):", "",
    "| Side | Case | Measure | Untraced | Traced | Allowed | Within |", "| --- | --- | --- | --- | --- | --- | --- |",
    ...noise.rows.map((row) => `| ${row.side} | ${row.label} | ${row.measure} | ${value(row.untraced)} | ${value(row.traced)} | ${value(row.allowed)} | ${row.within ? "yes" : "no"} |`));
  return lines.join("\n");
}

const SHARED_TOOL_PATHS = ["tools", ".claude/skills/run-splitpage-app", "tests/collab/measure"];

async function sharedMain(args, repo) {
  return withRefTrees(repo, "perf-ab", [["base", args.base], ["head", args.head]], async ({ dirs, shas, run, scratch }) => {
    for (const side of ["base", "head"]) {
      console.error(`perf-ab: ${side} building with node build.mjs --test`);
      await run(process.execPath, ["build.mjs", "--test"], dirs[side]);
    }
    const tool = await toolRevision(run, SHARED_TOOL_PATHS, args.dryRun);
    for (const side of ["base", "head"]) placeTools(repo, dirs[side], SHARED_TOOL_PATHS);
    const data = join(scratch, "shared-data.json");
    console.error("perf-ab: preparing the entry states and replay bytes once, from head");
    await run(process.execPath, ["tools/perf-shared.mjs", "--prepare", data, "--only", args.only], dirs.head);
    const tree = async (sha, path) => (await run("git", ["rev-parse", `${sha}:${path}`])).trim();
    const revisions = { tool };
    for (const side of ["base", "head"]) revisions[side] = { commit: shas[side], adapters: await tree(shas[side], "src/adapters"), collab: await tree(shas[side], "src/adapters/collab") };
    const prepared = JSON.parse(readFileSync(data, "utf8"));
    const record = {
      kind: "shared-composed-editor", dryRun: args.dryRun, startedAt: new Date().toISOString(),
      conditions: { node: process.version, arch: process.arch, platform: process.platform, typedCharacters: TYPED.length, keyGapMs: KEY_GAP_MS,
        remoteRates: REMOTE_RATES, fixtures: args.only.split(","), clients: prepared.clients, replayUpdates: prepared.replayUpdates, minFreeMb: args.minFreeMb, rounds: args.rounds,
        passes: PASSES, traceCategories: TRACE_CATEGORIES, percentiles: PERCENTILE_RULE },
      revisions, rounds: []
    };
    const persist = () => { if (args.out) writeRecord(args.out, record); };
    persist();
    for (let round = 1; round <= args.rounds; round++) {
      const order = abbaOrder(round);
      for (const side of order) {
        for (const pass of passOrder(round)) {
          const freeMb = await waitForMemory(args.minFreeMb);
          console.error(`perf-ab: round ${round}/${args.rounds} ${side} ${pass} (${freeMb} MB free before the pass)`);
          const json = join(scratch, `${side}-${pass}-${round}.json`), startedAt = new Date().toISOString();
          await run(process.execPath, ["tools/perf-shared.mjs", "--built", ...(pass === "traced" ? ["--trace"] : []), "--data", data, "--json", json, "--only", args.only], dirs[side]);
          const rows = JSON.parse(readFileSync(json, "utf8")).rows;
          record.rounds.push({ round, order, side, pass, freeMb, startedAt, browser: rows.find((r) => r.kind === "entry")?.browser ?? "unknown", rows });
          persist();
        }
      }
    }
    console.log(sharedSummary(record));
  });
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
  if (args.shared) return sharedMain(args, repo);
  return withRefTrees(repo, "perf-ab", [["base", args.base], ["head", args.head]], async ({ dirs, shas, run }) => {
    for (const side of ["base", "head"]) {
      const build = buildArgs(readFileSync(join(dirs[side], "build.mjs"), "utf8"));
      console.error(`perf-ab: ${side} building with node ${build.join(" ")}${build.length === 1 ? " (legacy build; --test unavailable)" : ""}`);
      await run(process.execPath, build, dirs[side]);
    }
    for (const path of ["tools", ".claude/skills/run-splitpage-app"]) {
      cpSync(join(dirs.head, path), join(dirs.base, path), { recursive: true });
    }
    const runs = { base: [], head: [] };
    for (let round = 1; round <= args.rounds; round++) {
      for (const side of ["base", "head"]) {
        console.error(`perf-ab: round ${round}/${args.rounds} ${side}`);
        runs[side].push(measurements(await run(process.execPath, ["tools/perf-record.mjs", "--built", "--only", args.only], dirs[side])));
      }
    }
    console.log(report(shas.base, shas.head, runs));
  });
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
