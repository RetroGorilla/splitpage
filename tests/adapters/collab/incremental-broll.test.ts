import assert from "node:assert/strict";
import { test } from "node:test";
import { execute, replicas } from "./executor-support.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { assertIncremental, nativeText } from "./incremental-support.ts";
import * as Y from "yjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { registerBenchmarkHandlers } from "../../collab/benchmark-document.ts";

const marker = (id: string): string => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">B-roll:</span>`;

test("b-roll keys scan only the changed cell's units, yet a new first occurrence re-keys a marker in an unscanned row", () => {
  const rows = Array.from({ length: 300 }, (_unused, index) => ({ id: "R" + String(index), audioText: "text " + String(index),
    visualText: index % 3 ? "" : marker(index % 2 ? "S1" : "S2") }));
  const run = replicas(2, { title: "Script", rows, brollShots: [{ id: "S1", name: "Street", status: "unshot", origin: "list" }] });
  const work: string[] = [], projector = createSharedIncrementalProjector(run.a, (kind, key) => { if (kind === "broll-scan") work.push(key); });
  const stop = projector.observe(() => assertIncremental(run.a, projector));
  try {
    assert.equal(work.length, 600);
    assertIncremental(run.a, projector);
    const visual = (index: number): unknown => projector.read().document.rows[index]?.visualText ?? projector.read().document.rows[index]?.audioText;
    const ids = (): unknown[] => [0, 3, 6, 9, 15].map(index => visual(index));
    assert.deepEqual(ids(), ["S2", "S1", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
    const kept = projector.read().document.rows.slice(4);
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R150").insert(0, "x"));
    assert.deepEqual(work, ["[\"R150\",\"audioText\"]"]);
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").insertEmbed(0, { k: "S1", label: "B-roll:" }));
    assert.deepEqual(work, ["[\"R1\",\"audioText\"]"]);
    assert.equal(projector.read().document.rows[1]?.audioText, marker("S1") + "text 1");
    assert.deepEqual(ids(), ["S2", "broll_00530031_1_139", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
    assert.deepEqual(projector.read().document.rows.slice(4).flatMap((row, at) => row === kept[at] ? [] : [row.id]), ["R150"]);
    registerSharedRecordHandlers(run.a);
    execute(run.a, { kind: "record-create", id: "reserve", by: "Writer", target: { collection: "shots", record: "broll_00530031_1_139" },
      fields: { id: "broll_00530031_1_139", name: "Reserved", status: "unshot", origin: "list" } });
    assert.deepEqual(work, ["[\"R1\",\"audioText\"]"]);
    assert.deepEqual(ids(), ["S2", "broll_00530031_1_139_", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
    work.length = 0;
    transactSharedDocument(run.a, "local-command", () => nativeText(run.a, "b:R1").delete(0, 1));
    assert.deepEqual(work, ["[\"R1\",\"audioText\"]"]);
    assert.deepEqual(ids(), ["S2", "S1", "broll_00530032_1_227", "broll_00530031_1_315", "broll_00530031_1_497"].map(marker));
  } finally { stop(); projector.dispose(); run.close(); }
});

const BROLL_KINDS = ["type", "type-marked", "marker", "unmarker", "shot-create", "shot-rename", "shot-id", "shot-delete", "wrong-shot",
  "split", "join", "unjoin", "remove", "restore"] as const;

test("seeded: b-roll keys from the incremental projection equal a fresh full projection at every publication, wrong-shape records included", t => {
  const violations: string[] = [], kinds = new Set<string>();
  let histories = 0, checkpoints = 0, rekeyedUnscanned = 0, scannedCells = 0;
  for (const seed of [6, 1414, 0x6c6c6c6c]) for (const order of ["D1", "rev", "dup"] as const) {
    const run = replicas(2, { title: "Script", rows: [
      { id: "R1", audioText: "one", visualText: marker("S1") }, { id: "R2", audioText: marker("S1") + "two" },
      { id: "R3", audioText: "three", visualText: marker("S2") }, { id: "R4", audioText: "four" + marker("S3"), visualText: marker("S1") },
      { id: "R5", audioText: "five" }
    ], brollShots: [{ id: "S1", name: "Street", status: "unshot", origin: "list" }, { id: "S2", name: "Cup", status: "unshot", origin: "list" }] });
    const handles = [run.a, run.b], works: string[][] = [[], []], where = `seed=${seed} order=${order}`;
    const projectors = handles.map((handle, index) => createSharedIncrementalProjector(handle, (kind, key) => works[index]?.push(kind + "\n" + key)));
    let state = seed;
    const pick = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 4294967296 * limit); };
    const checkpoint = (index: number): void => {
      const handle = handles[index], projector = projectors[index], work = works[index]; assert.ok(handle && projector && work);
      const scans = new Set(work.flatMap(entry => entry.startsWith("broll-scan\n") ? [entry.slice(11)] : []));
      rekeyedUnscanned += work.filter(entry => entry.startsWith("cell\n") && /^\["[^"]*","(audio|visual)Text"/.test(entry.slice(5)) && !scans.has(entry.slice(5))).length;
      scannedCells += scans.size; work.length = 0;
      try { assertIncremental(handle, projector); checkpoints++; } catch (error) { violations.push(`${where}: ${String(error)}`); }
    };
    for (const [index, handle] of handles.entries()) { const projector = projectors[index]; assert.ok(projector); assertIncremental(handle, projector); }
    const stops = projectors.map((projector, index) => projector.observe(() => checkpoint(index)));
    try {
      for (const handle of handles) registerBenchmarkHandlers(handle);
      for (let step = 0; step < 12; step++) for (const [writer, handle] of handles.entries()) {
        const roots = collabState(handle).roots, name = `s${seed}w${writer}n${step}`, kind = step ? BROLL_KINDS[pick(BROLL_KINDS.length)] ?? "type" : "split";
        const texts = [...roots.segments.entries(), ...roots.visuals.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([, value]) => {
          const text: unknown = value instanceof Y.Map && !(value.get("head") as { h?: unknown } | undefined)?.h ? value.get("text") : null;
          return text instanceof Y.Text ? [text] : [];
        });
        const embedded = (text: Y.Text): number => { let at = 0;
          for (const part of text.toDelta() as { insert: unknown }[]) { if (typeof part.insert !== "string") return at; at += part.insert.length; } return -1; };
        const marked = texts.filter(text => embedded(text) >= 0), shots = [...roots.shots.keys()].sort();
        const beatIds = ["R1", "R2", "R3", "R4", "R5"], beatId = beatIds[pick(beatIds.length)] ?? "R1", other = beatIds[pick(beatIds.length)] ?? "R1";
        const inner = (field: "joins" | "removals", id = beatId): Y.Map<unknown> | null => {
          const beat: unknown = roots.beats.get(id), value: unknown = beat instanceof Y.Map ? beat.get(field) : null; return value instanceof Y.Map ? value : null; };
        const command = (value: Record<string, unknown>): boolean => {
          const parsed = readOperation({ id: name, by: "Writer", ...value }); assert.ok(parsed);
          return executeSharedOperations(handle, [parsed], { base: readSharedRevision(handle) }).ok;
        };
        let done = true;
        if (kind === "split") {
          const length = nativeText(handle, "b:" + beatId).length;
          done = length > 1 && command({ kind, target: { owner: beatId, segment: "b:" + beatId, field: "audioText" }, observed: [], fields: { status: "todo" },
            at: { left: null, right: flowBaseReference(beatId, "audioText", 1 + pick(length - 1)), affinity: "before" }, boundary: name + "b", beat: name + "beat" });
        } else if (kind === "shot-create") {
          const id = pick(2) ? "S3" : "S4";
          done = command({ kind: "record-create", target: { collection: "shots", record: id }, fields: { id, name: "New", status: "unshot", origin: "list" } });
        } else if (kind === "shot-rename" && shots.length) done = command({ kind: "record-set", target: { collection: "shots", record: shots[pick(shots.length)] }, field: "name", value: name });
        else if (kind === "shot-delete" && shots.length) done = command({ kind: "record-delete", target: { collection: "shots", record: shots[pick(shots.length)] } });
        else transactSharedDocument(handle, "local-command", () => {
          const text = (kind === "type-marked" || kind === "unmarker" ? marked : texts)[pick(kind === "type-marked" || kind === "unmarker" ? marked.length : texts.length)];
          if (kind === "type" || kind === "type-marked") { if (text) text.insert(pick(text.length + 1), String.fromCharCode(97 + pick(26))); else done = false; }
          else if (kind === "marker") { if (text) text.insertEmbed(pick(text.length + 1), { k: ["S1", "S2", "S3", "S4"][pick(4)], label: "B-roll:" }); else done = false; }
          else if (kind === "unmarker") { if (text) text.delete(embedded(text), 1); else done = false; }
          else if (kind === "shot-id") { const shot: unknown = roots.shots.get(shots[pick(shots.length)] ?? ""); if (shot instanceof Y.Map) shot.set("id", pick(2) ? "S4" : 7); else done = false; }
          else if (kind === "wrong-shot") roots.shots.set(name, pick(2) ? { id: "S3", name: "plain object" } : 12);
          else if (kind === "join") { const joins = inner("joins"); if (joins && other !== beatId) joins.set(name, { into: other, glue: " " }); else done = false; }
          else if (kind === "remove") { const removals = inner("removals"); if (removals) removals.set(name, true); else done = false; }
          else {
            const entries = beatIds.map(id => inner(kind === "unjoin" ? "joins" : "removals", id)).find(value => value?.size), key = entries ? [...entries.keys()].sort()[0] : undefined;
            if (entries && key !== undefined && (kind === "unjoin" || kind === "restore")) entries.delete(key); else done = false;
          }
        });
        if (done) kinds.add(kind);
      }
      run.queue.flush(order);
      for (const index of handles.keys()) checkpoint(index);
      histories++;
    } catch (error) { violations.push(`${where}: ${String(error)}`); }
    finally { for (const stop of stops) stop(); for (const projector of projectors) projector.dispose(); run.close(); }
  }
  t.diagnostic(JSON.stringify({ histories, checkpoints, rekeyedUnscanned, scannedCells, kinds: [...kinds].sort() }));
  assert.deepEqual(violations, []);
  assert.deepEqual([...kinds].sort(), [...BROLL_KINDS].sort());
  assert.deepEqual({ histories, checkpoints, rekeyedUnscanned, scannedCells }, { histories: 9, checkpoints: 326, rekeyedUnscanned: 59, scannedCells: 545 });
});
