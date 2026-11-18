import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { projectionReferences } from "../proj/reference.ts";
import { records } from "../proj/value.ts";
import type { ProjectionBag } from "../proj/value.ts";
import { longDemo, scaledDemo } from "./tape.ts";
import { NativeReplica } from "./variant.ts";
import type { NativeScheme } from "./variant.ts";

const LIMIT = 2 * 1024 * 1024;

export interface HeavyStep { repetition: number; server: number; editor: number }
export interface HeavyResult {
  fixture: string; scheme: NativeScheme; fresh: number; afterText: number; afterStructure: number; afterFormatting: number;
  steps: HeavyStep[]; repetitions: number; crossedAt: number | null; seconds: number; reloaded: number; undoPairs: number;
}
export interface ActCostRow { scheme: NativeScheme; shape: string; acts: number; bytes: number; afterUnformat: number; readMs: number; keysOnBusiestCharacter: number }

function fixture(name: string): ProjectionBag {
  if (name === "long") return longDemo();
  if (name === "large") return scaledDemo(10);
  const source = projectionReferences().find(item => item.name === "src/seed-state.json");
  if (!source) throw new Error("Missing short fixture");
  return source.document;
}

// why: a server holds the document without an undo manager, so deleted text is collected there at once;
// the editing copy keeps what its undo history may restore, and is reported separately
function server(replica: NativeReplica): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, replica.encode());
  replica.doc.on("update", (update: Uint8Array) => { Y.applyUpdate(doc, update); });
  return doc;
}

const size = (doc: Y.Doc): number => Y.encodeStateAsUpdate(doc).length;

// why: the schedule of docs/collaboration/stage-2-growth-admission.md, one command per transaction
function schedule(replica: NativeReplica, first: string, second: string, serial: number, mark: (name: string) => void): void {
  const length = (): number => { const cell = replica.cell(first, "audioText"); return cell.end - cell.start; };
  const back = (): void => { assert.ok(replica.undo.undo()); replica.changes(); };
  for (let block = 0; block < 100; block++) {
    const at = length();
    for (let index = 0; index < 100; index++) { replica.splice(first, "audioText", at + index, at + index, [{ text: "x", marks: {} }]); replica.changes(); }
    replica.splice(first, "audioText", at, at + 100, []); replica.changes();
    back();
    assert.equal(length(), at + 100);
    assert.ok(replica.undo.redo()); replica.changes();
    assert.equal(length(), at);
  }
  mark("text");
  for (let index = 0; index < 50; index++) { replica.split(first, 2, `split-${serial}-${index}`); replica.changes(); back(); }
  for (let index = 0; index < 50; index++) { replica.join(second, first, " "); replica.changes(); back(); }
  for (let index = 0; index < 100; index++) { replica.remove(second, "Writer", 1); replica.changes(); back(); }
  mark("structure");
  for (let index = 0; index < 100; index++) { replica.format(first, "audioText", 0, 2, { b: true }); replica.changes(); back(); }
  mark("formatting");
}

export function heavyUse(name: string, scheme: NativeScheme, limit: number, seconds: number): HeavyResult {
  const document = fixture(name), rows = records(document.rows), first = String(rows[0]?.id), second = String(rows[1]?.id);
  const replica = new NativeReplica(1, 0, scheme);
  replica.hydrate(document);
  const remote = server(replica), fresh = size(remote), entered = JSON.stringify(replica.rows()), started = performance.now();
  const steps: HeavyStep[] = [], marks: Record<string, number> = {};
  let crossedAt: number | null = null, repetition = 0;
  while (repetition < limit && crossedAt === null && (performance.now() - started) / 1000 < seconds) {
    schedule(replica, first, second, repetition, label => { if (repetition === 0) marks[label] = size(remote); });
    repetition++;
    assert.equal(JSON.stringify(replica.rows()), entered);
    replica.undo.clear();
    const bytes = size(remote);
    if (bytes >= LIMIT) crossedAt = repetition;
    if (repetition <= 3 || repetition % 25 === 0 || crossedAt !== null) steps.push({ repetition, server: bytes, editor: replica.encode().length });
  }
  if (steps.at(-1)?.repetition !== repetition) steps.push({ repetition, server: size(remote), editor: replica.encode().length });
  const reloaded = new Y.Doc();
  Y.applyUpdate(reloaded, replica.encode());
  const probe = new NativeReplica(2, 0, scheme);
  Y.applyUpdate(probe.doc, Y.encodeStateAsUpdate(remote), "remote");
  probe.changes();
  const probeServer = server(probe), end = probe.cell(first, "audioText");
  probe.splice(first, "audioText", end.end - end.start, end.end - end.start, [{ text: "x", marks: {} }]);
  const before = size(probeServer);
  for (let pair = 0; pair < 100; pair++) { assert.ok(probe.undo.undo()); assert.ok(probe.undo.redo()); }
  return { fixture: name, scheme, fresh, afterText: marks.text ?? 0, afterStructure: marks.structure ?? 0, afterFormatting: marks.formatting ?? 0,
    steps, repetitions: repetition, crossedAt, seconds: Math.round((performance.now() - started) / 100) / 10, reloaded: size(reloaded), undoPairs: size(probeServer) - before };
}

// why: formatting that stays is where one key per act can cost more than one key per name, so it is measured alone:
// "apart" formats a different word each time, "stacked" formats one range again and again
export function actCost(scheme: NativeScheme, shape: "apart" | "stacked", acts: number): ActCostRow {
  const replica = new NativeReplica(1, 0, scheme), words = shape === "apart" ? acts : 100;
  replica.hydrate({ rows: [{ id: "one", audioText: "word ".repeat(words), visualText: "" }] });
  replica.undo.destroy();
  const base = replica.encode().length;
  for (let index = 0; index < acts; index++) {
    if (shape === "apart") replica.format("one", "audioText", index * 5, index * 5 + 4, { b: true });
    else replica.format("one", "audioText", 5 + index % 3, 300 - index % 5, { b: true });
  }
  const bytes = replica.encode().length - base, started = performance.now();
  let keys = 0;
  for (let round = 0; round < 20; round++) {
    const text = replica.cell("one", "audioText").text;
    for (const item of text.toDelta() as { attributes?: Record<string, unknown> }[]) keys = Math.max(keys, Object.keys(item.attributes ?? {}).length);
  }
  const readMs = (performance.now() - started) / 20;
  replica.format("one", "audioText", 0, words * 5, { b: null });
  assert.ok(!replica.rows()[0]?.audioText.includes("<b>"));
  return { scheme, shape, acts, bytes, afterUnformat: replica.encode().length - base, readMs: Math.round(readMs * 1000) / 1000, keysOnBusiestCharacter: keys };
}

export function heavyReport(results: readonly HeavyResult[], costs: readonly ActCostRow[]): string {
  const lines = ["| Document | Key scheme | Fresh bytes | After the text part | After splits, joins and removals | After one full schedule | Repetitions run | Bytes then (server copy) | Bytes then (editing copy) | Editing copy reloaded | Crossed 2 MiB | 100 undo and redo pairs |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of results) {
    const last = row.steps.at(-1);
    lines.push(`| ${row.fixture} | ${row.scheme} | ${row.fresh} | ${row.afterText} | ${row.afterStructure} | ${row.afterFormatting} | ${row.repetitions} (${row.seconds} s) | ${last?.server ?? ""} | ${last?.editor ?? ""} | ${row.reloaded} | ${row.crossedAt === null ? "no" : `at repetition ${row.crossedAt}`} | ${row.undoPairs} |`);
  }
  lines.push("", "| Key scheme | Formatting acts that stay | Shape | Bytes added | Bytes added once all is unformatted | Reading the cell, ms | Keys on the busiest character |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of costs) lines.push(`| ${row.scheme} | ${row.acts} | ${row.shape} | ${row.bytes} | ${row.afterUnformat} | ${row.readMs} | ${row.keysOnBusiestCharacter} |`);
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flag = (name: string, fallback: number): number => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
  const output = process.argv.find(value => value.startsWith("--write="))?.split("=")[1];
  const results: HeavyResult[] = [], costs: ActCostRow[] = [];
  for (const scheme of ["name", "act"] as const) for (const name of ["short", "long", "large"]) {
    results.push(heavyUse(name, scheme, name === "long" ? flag("repetitions", 400) : 1, flag("seconds", 600)));
    process.stderr.write(`${name} ${scheme}: ${results.at(-1)?.repetitions ?? 0} repetitions\n`);
  }
  for (const scheme of ["name", "act"] as const) for (const shape of ["apart", "stacked"] as const) for (const acts of [100, 1000, 10000]) {
    if (shape === "stacked" && acts > 1000) continue;
    costs.push(actCost(scheme, shape, acts));
  }
  if (output) writeFileSync(output, JSON.stringify({ node: process.version, limit: LIMIT, results, costs }, null, 2) + "\n");
  process.stdout.write(heavyReport(results, costs));
}
