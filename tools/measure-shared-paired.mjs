import { join, resolve } from "node:path";
import { REPO } from "./source-scan.mjs";
import { abbaOrder, median, placeTools, toolRevision, waitForMemory, writeRecord } from "./perf-ab.mjs";
import { withRefTrees } from "./ref-trees.mjs";

const PAIRED_FIXTURES = ["short", "long", "large"];
const MIN_ROUNDS = 5;
const MEASURE = "tests/collab/measure/paired.mjs";
const TOOL_PATHS = ["tools", "tests/collab/measure"];

export function parsePairedArgs(argv) {
  const refs = [];
  let rounds = MIN_ROUNDS, only = PAIRED_FIXTURES.join(","), out = null, minFreeMb = 3000, dryRun = false;
  const whole = (raw, what) => {
    if (!/^[1-9]\d*$/.test(raw ?? "")) throw new Error(`${what} needs a positive whole number`);
    return Number(raw);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rounds") rounds = whole(argv[++i], "--rounds");
    else if (arg === "--only") only = argv[++i] ?? "";
    else if (arg === "--out") { out = argv[++i] ?? ""; if (!out) throw new Error("--out needs a file"); }
    else if (arg === "--min-free-mb") minFreeMb = whole(argv[++i], "--min-free-mb");
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else refs.push(arg);
  }
  if (refs.length < 1 || refs.length > 2) throw new Error("usage: node tools/measure-shared-admission.mjs --paired <base> [head=HEAD] [--only short,long,large] [--rounds 5] [--out results.json] [--min-free-mb 3000] [--dry-run]");
  const fixtures = only.split(",");
  if (fixtures.some((f) => !PAIRED_FIXTURES.includes(f)) || new Set(fixtures).size !== fixtures.length) throw new Error(`--only needs distinct fixtures from ${PAIRED_FIXTURES.join(",")}`);
  if (rounds < MIN_ROUNDS && !dryRun) throw new Error(`the paired form needs at least ${MIN_ROUNDS} rounds; fewer only with --dry-run, which is not evidence`);
  return { base: refs[0], head: refs[1] ?? "HEAD", rounds, only, out: out && resolve(out), minFreeMb, dryRun };
}

export function parseRound(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("ROUND "));
  if (!line) throw new Error("the round printed no result");
  return JSON.parse(line.slice(6));
}

export function pairedSummary(record) {
  const rowsOf = (side) => record.rounds.filter((r) => r.side === side).map((r) => r.rows);
  const keys = [...new Set(record.rounds.flatMap((r) => r.rows.map((x) => `${x.name} / ${x.phase}`)))];
  const columns = [["admission p50", (x) => x.run.current.single.p50], ["admission p95", (x) => x.run.current.single.p95],
    ["direct p50", (x) => x.run.direct.single.p50], ["current 1000 total", (x) => x.run.current[1000].total], ["direct 1000 total", (x) => x.run.direct[1000].total],
    ["validation p50", (x) => x.parts.validation.p50], ["validation 500 total", (x) => x.parts.validation.total], ["rebuild 500 total", (x) => x.parts.rebuild.total]];
  const method = (side) => [...new Set(record.rounds.filter((r) => r.side === side).flatMap((r) => r.rows.map((x) => x.trial)))].join(", ");
  const stat = (side, key, pick) => {
    const values = rowsOf(side).map((rows) => rows.find((x) => `${x.name} / ${x.phase}` === key)).filter(Boolean).map(pick);
    return values.length ? median(values) : null;
  };
  const value = (n) => n === null ? "—" : String(+n.toFixed(3));
  const delta = (b, h) => b === null || h === null ? "—" : `${h >= b ? "+" : ""}${+(h - b).toFixed(3)}`;
  return [
    ...(record.dryRun ? ["Dry run: pipeline check only, not evidence.", ""] : []),
    `Adapter-level admission comparison (ms): base ${record.revisions.base.commit.slice(0, 8)}, head ${record.revisions.head.commit.slice(0, 8)}; median of ${rowsOf("base").length} rounds per side in ABBA order. Each cell is base / head / head minus base.`,
    `Trial before admission: base ${method("base")}, head ${method("head")}. Tools from ${record.revisions.tool.commit.slice(0, 8)} in both trees.`,
    "",
    `| Script / state | ${columns.map(([name]) => name).join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`,
    ...keys.map((key) => `| ${key} | ${columns.map(([, pick]) => {
      const b = stat("base", key, pick), h = stat("head", key, pick);
      return `${value(b)} / ${value(h)} / ${delta(b, h)}`;
    }).join(" | ")} |`)
  ].join("\n");
}

export async function main(argv, repo = REPO) {
  let args;
  try { args = parsePairedArgs(argv); } catch (error) { console.error(`measure-shared-admission: ${error.message}`); return 1; }
  return withRefTrees(repo, "measure-shared-admission", [["base", args.base], ["head", args.head]], async ({ dirs, shas, run, scratch }) => {
    const tool = await toolRevision(run, TOOL_PATHS, args.dryRun);
    for (const side of ["base", "head"]) placeTools(repo, dirs[side], TOOL_PATHS);
    const data = join(scratch, "paired-data.json");
    console.error("measure-shared-admission: preparing the states and update streams once, from head");
    await run(process.execPath, ["--expose-gc", MEASURE, "--prepare", data, "--only", args.only], dirs.head);
    const tree = async (sha, path) => (await run("git", ["rev-parse", `${sha}:${path}`])).trim();
    const revisions = { tool };
    for (const side of ["base", "head"]) revisions[side] = { commit: shas[side], adapters: await tree(shas[side], "src/adapters"), collab: await tree(shas[side], "src/adapters/collab") };
    const record = { kind: "shared-admission-paired", dryRun: args.dryRun, startedAt: new Date().toISOString(),
      conditions: { node: process.version, arch: process.arch, platform: process.platform, fixtures: args.only.split(","), minFreeMb: args.minFreeMb, rounds: args.rounds },
      revisions, rounds: [] };
    const persist = () => { if (args.out) writeRecord(args.out, record); };
    persist();
    for (let round = 1; round <= args.rounds; round++) {
      const freeMb = await waitForMemory(args.minFreeMb);
      const order = abbaOrder(round);
      for (const side of order) {
        console.error(`measure-shared-admission: round ${round}/${args.rounds} ${side} (${freeMb} MB free before the round)`);
        const startedAt = new Date().toISOString();
        const rows = parseRound(await run(process.execPath, ["--expose-gc", MEASURE, "--round", data, String(round)], dirs[side]));
        record.rounds.push({ round, order, side, freeMb, startedAt, rows });
        persist();
      }
    }
    console.log(pairedSummary(record));
  });
}
