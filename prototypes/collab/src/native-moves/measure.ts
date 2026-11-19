import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { NativeHeadingReplica } from "../native/headings.ts";
import { copyMove } from "./candidates.ts";
import { moveBlocks, moveRow, moveScene } from "./moves.ts";
import { blockRef } from "./order.ts";

export type Layout = "own" | "scene";
const SCENE = 10, AUDIO = "The narrator walks to the window and looks at the rain outside.", VISUAL = "Wide shot, the window";

export function build(beats: number, layout: Layout): Uint8Array {
  const seed = new NativeHeadingReplica(900, "flag"), ids = Array.from({ length: beats }, (_, index) => `B${index}`);
  if (layout === "own") {
    seed.hydrate({ rows: ids.map(id => ({ id, audioText: AUDIO, visualText: VISUAL })),
      sections: ids.filter((_, index) => index % SCENE === 0).map((id, index) => ({ id: `H${index}`, name: `Scene ${index}`, firstSceneId: id })) });
  } else {
    seed.doc.transact(() => {
      for (let scene = 0; scene * SCENE < beats; scene++) {
        const segment = new Y.Map<unknown>(), text = new Y.Text(), key = `seg-h-H${scene}`;
        seed.segments.set(key, segment);
        segment.set("head", { h: `H${scene}` });
        segment.set("text", text);
        seed.headings.set(`H${scene}`, new Y.Map());
        text.insert(0, `Scene ${scene}`, {});
        for (const id of ids.slice(scene * SCENE, (scene + 1) * SCENE)) {
          text.insertEmbed(text.length, { b: id });
          text.insert(text.length, AUDIO, {});
          seed.beats.set(id, new Y.Map());
          const visual = new Y.Text();
          seed.visuals.set(id, visual);
          visual.insert(0, VISUAL, {});
        }
        seed.order.push([key]);
      }
    }, "hydration");
  }
  const bytes = seed.encode();
  seed.destroy();
  return bytes;
}

export function load(bytes: Uint8Array, client = 1): NativeHeadingReplica {
  const replica = new NativeHeadingReplica(client, "flag");
  Y.applyUpdate(replica.doc, bytes, "remote");
  replica.changes();
  return replica;
}

function random(seed: number): () => number {
  return () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

export function randomRowMoves(replica: NativeHeadingReplica, count: number, seed: number): void {
  const next = random(seed);
  for (let done = 0; done < count;) {
    const rows = replica.rows(), from = rows[Math.floor(next() * rows.length)], to = rows[Math.floor(next() * rows.length)];
    if (from && to && from !== to && moveRow(replica, from.id, to.id, next() < 0.5)) done++;
  }
}

function captured(replica: NativeHeadingReplica, run: () => void): number {
  let bytes = 0;
  const listen = (update: Uint8Array): void => { bytes += update.length; };
  replica.doc.on("update", listen);
  try { run(); } finally { replica.doc.off("update", listen); }
  return bytes;
}

function stored(replica: NativeHeadingReplica): number {
  const reloaded = load(replica.encode(), 2), size = reloaded.encode().length;
  reloaded.destroy();
  return size;
}

export interface MoveBytes { layout: Layout; unit: string; update: number; growth: number; copyUpdate: number | null; copyGrowth: number | null }

export function moveBytes(beats: number): MoveBytes[] {
  const result: MoveBytes[] = [];
  const middle = Math.floor(beats / 2) + 3, target = 23;
  const cases: { unit: string; run: (replica: NativeHeadingReplica) => void; copy?: (replica: NativeHeadingReplica) => void }[] = [
    { unit: "one row", run: replica => { moveRow(replica, `B${middle}`, `B${target}`, true); },
      copy: replica => { copyMove(replica, `B${middle}`, `B${target + 1}`, "x"); } },
    { unit: "run of 5 rows", run: replica => { moveBlocks(replica, blockRef("b", `B${middle}`), blockRef("b", `B${middle + 4}`), blockRef("b", `B${target}`)); } },
    { unit: "scene of 10 rows", run: replica => { moveScene(replica, `H${Math.floor(middle / SCENE)}`, "H2", false); } }
  ];
  for (const layout of ["own", "scene"] as const) {
    const bytes = build(beats, layout);
    for (const item of cases) {
      const replica = load(bytes), before = stored(replica), update = captured(replica, () => { item.run(replica); }), growth = stored(replica) - before;
      replica.destroy();
      let copyUpdate: number | null = null, copyGrowth: number | null = null;
      if (item.copy) {
        const copy = load(bytes), start = stored(copy);
        copyUpdate = captured(copy, () => { item.copy?.(copy); });
        copyGrowth = stored(copy) - start;
        copy.destroy();
      }
      result.push({ layout, unit: item.unit, update, growth, copyUpdate, copyGrowth });
    }
  }
  return result;
}

export interface Lifetime { layout: Layout; moves: number; before: number; after: number; perMove: number; placed: number }

export function lifetime(beats: number, moves: number): Lifetime[] {
  return (["own", "scene"] as const).map(layout => {
    const replica = load(build(beats, layout)), before = stored(replica);
    randomRowMoves(replica, moves, 7);
    const after = stored(replica), placed = replica.arrangement().placed.size;
    replica.destroy();
    return { layout, moves, before, after, perMove: (after - before) / moves, placed };
  });
}

export interface Timing { median: number; p95: number; n: number }

function time(samples: number, warmup: number, run: (index: number) => void): Timing {
  const values: number[] = [];
  for (let index = 0; index < warmup + samples; index++) {
    const started = performance.now();
    run(index);
    if (index >= warmup) values.push(performance.now() - started);
  }
  values.sort((a, b) => a - b);
  return { median: values[Math.floor(values.length / 2)] ?? NaN, p95: values[Math.floor(values.length * 0.95)] ?? NaN, n: values.length };
}

export interface ScaleRow { beats: number; layout: Layout; moved: number; read: Timing; reproject: Timing; move: Timing; keystroke: Timing; keystrokeUnmoved: Timing }

export function scale(beats: number, layout: Layout, moved: number, samples: number): ScaleRow {
  const replica = load(build(beats, layout));
  try {
    randomRowMoves(replica, moved, 11);
    const read = time(samples, 5, () => { replica.blocks(); });
    const rule = replica.reading;
    const reproject = time(samples, 5, () => { replica.reading = rule; replica.changes(); });
    const next = random(13);
    const move = time(Math.min(samples, 60), 5, () => {
      const rows = replica.rows();
      for (;;) {
        const from = rows[Math.floor(next() * rows.length)], to = rows[Math.floor(next() * rows.length)];
        if (from && to && from !== to && moveRow(replica, from.id, to.id, true)) return;
      }
    });
    const placed = [...replica.arrangement().placed.keys()].find(ref => ref.startsWith("b:"))?.slice(2) ?? "B0";
    const still = replica.rows().find(row => !replica.arrangement().placed.has(blockRef("b", row.id)))?.id ?? "B0";
    const keystroke = time(samples * 2, 20, () => {
      replica.splice(placed, "audioText", 1, 1, [{ text: "x", marks: {} }]);
      replica.changes();
    });
    const keystrokeUnmoved = time(samples * 2, 20, () => {
      replica.splice(still, "audioText", 1, 1, [{ text: "x", marks: {} }]);
      replica.changes();
    });
    return { beats, layout, moved, read, reproject, move, keystroke, keystrokeUnmoved };
  } finally { replica.destroy(); }
}

const ms = (timing: Timing): string => `${timing.median.toFixed(3)} / ${timing.p95.toFixed(3)}`;

export function report(samples: number): string {
  const lines = [`Node ${process.version} ${process.arch}. Synthetic script: scenes of ${SCENE} beats, ${AUDIO.length} narration and ${VISUAL.length} visual characters per beat.`,
    "Layout \"own\": every beat starts its own segment, as hydration writes it. Layout \"scene\": every scene is one segment, so every beat is mid-segment.", "",
    "| Move at 300 beats | Layout | Update bytes | Stored bytes added | Delete and re-insert: update bytes | Delete and re-insert: stored bytes added |",
    "| --- | --- | --- | --- | --- | --- |"];
  for (const row of moveBytes(300)) {
    lines.push(`| ${row.unit} | ${row.layout} | ${row.update} | ${row.growth} | ${row.copyUpdate ?? "not measured"} | ${row.copyGrowth ?? "not measured"} |`);
  }
  lines.push("", "| 1,000 random row moves at 300 beats | Layout | Stored bytes before | Stored bytes after | Kept per move | Blocks with an active placement |", "| --- | --- | --- | --- | --- | --- |");
  for (const row of lifetime(300, 1000)) lines.push(`| ${row.moves} | ${row.layout} | ${row.before} | ${row.after} | ${row.perMove.toFixed(1)} | ${row.placed} |`);
  lines.push("", "Times in ms, median / p95.", "",
    "| Beats | Layout | Moves made first | Read row order | Rebuild every row | One row move | Keystroke in a moved beat | Keystroke in an unmoved beat |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const beats of [30, 300, 900]) for (const layout of ["own", "scene"] as const) for (const moved of [0, Math.round(beats / 3)]) {
    const row = scale(beats, layout, moved, samples);
    lines.push(`| ${beats} | ${layout} | ${moved} | ${ms(row.read)} | ${ms(row.reproject)} | ${ms(row.move)} | ${ms(row.keystroke)} | ${ms(row.keystrokeUnmoved)} |`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const samples = Number(process.argv.find(value => value.startsWith("--samples="))?.split("=")[1] ?? 60);
  process.stdout.write(report(samples));
}
