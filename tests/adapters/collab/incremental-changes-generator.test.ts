import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { replicas } from "./executor-support.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { projectSharedDocumentStep, projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { assertIncremental, incrementalReports } from "./incremental-support.ts";

const KINDS = ["type", "move", "join", "unjoin", "remove", "restore", "create", "title", "number", "person", "heading",
  "wrong-beat", "wrong-id", "right-id", "wrong-field", "wrong-join", "wrong-record", "wrong-segment"] as const;

test("seeded: the report equals a fresh full comparison at every publication, wrong-shape records included, with no declared limits", t => {
  const declaredLimits: readonly string[] = [], violations: string[] = [], kinds = new Set<string>();
  const totals = { added: 0, removed: 0, moved: 0, changed: 0, fields: 0, whole: 0, empty: 0 };
  const started = incrementalReports.compared;
  let histories = 0, checkpoints = 0, commands = 0, lateJoiners = 0;
  for (const seed of [6, 1414, 0x6c6c6c6c]) for (const writers of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const run = replicas(writers, { title: "Script", rows: [
      { id: "R1", audioText: "one" }, { id: "R2", audioText: "two" }, { id: "R3", audioText: "three" }, { id: "R4", audioText: "four" }, { id: "R5", audioText: "five" }
    ], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] });
    const handles = [run.a, run.b, run.c].slice(0, writers), projectors = handles.map(handle => createSharedIncrementalProjector(handle));
    const where = `seed=${seed} writers=${writers} order=${order}`;
    let state = seed;
    const pick = (limit: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor(state / 4294967296 * limit); };
    const checkpoint = (index: number): void => {
      const handle = handles[index], projector = projectors[index]; assert.ok(handle && projector);
      try {
        assertIncremental(handle, projector); checkpoints++;
        const changes = projector.read().changes;
        totals.added += changes.added.length; totals.removed += changes.removed.length; totals.moved += changes.moved.length;
        totals.changed += changes.changed.length; totals.fields += changes.fields.length; if (changes.whole) totals.whole++;
        if (!changes.whole && !changes.added.length && !changes.removed.length && !changes.moved.length && !changes.changed.length && !changes.fields.length) totals.empty++;
      } catch (error) { violations.push(`${where}: ${String(error)}`); }
    };
    for (const [index, handle] of handles.entries()) { const projector = projectors[index]; assert.ok(projector); assertIncremental(handle, projector); }
    const stops = projectors.map((projector, index) => projector.observe(() => checkpoint(index)));
    try {
      const base = projectSharedDocumentWithRecovery(run.a).document;
      for (let step = 0; step < 14; step++) for (const [writer, handle] of handles.entries()) {
        const roots = collabState(handle).roots, name = `s${seed}w${writer}n${step}`, kind = KINDS[pick(KINDS.length)] ?? "type";
        const beatIds = [...roots.beats.keys()].sort(), beatId = beatIds[pick(beatIds.length)] ?? "R1", other = beatIds[pick(beatIds.length)] ?? "R1";
        const beat: unknown = roots.beats.get(beatId);
        const inner = (field: "joins" | "removals"): Y.Map<unknown> | null => { const value: unknown = beat instanceof Y.Map ? beat.get(field) : null; return value instanceof Y.Map ? value : null; };
        transactSharedDocument(handle, "local-command", () => {
          if (kind === "type") {
            const segment: unknown = roots.segments.get("b:" + beatId), text: unknown = segment instanceof Y.Map ? segment.get("text") : null;
            if (text instanceof Y.Text) text.insert(pick(text.length + 1), String.fromCharCode(97 + pick(26))); else roots.meta.set("targetSeconds", 30 + pick(60));
          } else if (kind === "move") {
            const keys = roots.order.toArray(), from = pick(keys.length), moved = keys.splice(from, 1);
            keys.splice(pick(keys.length + 1), 0, ...moved); roots.order.delete(0, roots.order.length); roots.order.push(keys);
          } else if (kind === "join") inner("joins")?.set(name, { into: other, glue: pick(2) ? " " : "" });
          else if (kind === "unjoin") { const joins = inner("joins"), key = joins ? [...joins.keys()].sort()[0] : undefined; if (joins && key !== undefined) joins.delete(key); else roots.meta.set("targetSeconds", 30 + pick(60)); }
          else if (kind === "remove") inner("removals")?.set(name, true);
          else if (kind === "restore") { const removals = inner("removals"), key = removals ? [...removals.keys()].sort()[0] : undefined; if (removals && key !== undefined) removals.delete(key); else roots.meta.set("targetSeconds", 30 + pick(60)); }
          else if (kind === "create") {
            const created = new Y.Map<unknown>(), segment = new Y.Map<unknown>();
            created.set("id", name); created.set("segment", "s:" + name); created.set("joins", new Y.Map()); created.set("removals", new Y.Map());
            segment.set("head", { b: name }); segment.set("text", new Y.Text("new " + name));
            roots.beats.set(name, created); roots.segments.set("s:" + name, segment); roots.order.insert(pick(roots.order.length + 1), ["s:" + name]);
          } else if (kind === "title") { const title: unknown = roots.meta.get("title"); if (title instanceof Y.Text) title.insert(0, String(pick(9))); }
          else if (kind === "number") roots.meta.set("wordsPerMinute", 100 + pick(80));
          else if (kind === "person") { const person = new Y.Map<unknown>(); person.set("id", name); person.set("name", "Ada " + String(pick(9))); roots.people.set(name, person); }
          else if (kind === "heading") {
            const heading = new Y.Map<unknown>(), segment = new Y.Map<unknown>(); heading.set("id", name);
            segment.set("head", { h: name }); segment.set("text", new Y.Text("Scene " + String(pick(9))));
            roots.headings.set(name, heading); roots.segments.set("h:" + name, segment); roots.order.insert(pick(roots.order.length + 1), ["h:" + name]);
          } else if (kind === "wrong-beat") roots.beats.set(name, pick(2) ? false : [1, { nested: null }]);
          else if (kind === "wrong-id") { if (beat instanceof Y.Map) beat.set("id", pick(2) ? null : 7); else roots.beats.set(beatId, "text"); }
          else if (kind === "right-id") { if (beat instanceof Y.Map) beat.set("id", beatId); else roots.meta.set("targetSeconds", 30 + pick(60)); }
          else if (kind === "wrong-field") { if (beat instanceof Y.Map) beat.set(pick(2) ? "lengthSeconds" : "segment", pick(2) ? { wrong: true } : "missing-segment"); else roots.meta.set("wordsPerMinute", "fast"); }
          else if (kind === "wrong-join") { const joins = inner("joins"); if (joins) joins.set(name, pick(2) ? { into: 5, glue: " " } : "R1"); else if (beat instanceof Y.Map) beat.set("joins", 3); }
          else if (kind === "wrong-record") roots.people.set(name, pick(2) ? { id: name, name: "plain object" } : 12);
          else roots.segments.set(pick(2) ? "b:" + beatId : name, pick(2) ? new Y.Map() : "not a segment");
        });
        kinds.add(kind); commands++;
      }
      run.queue.flush(order);
      const late = createMonitoredSharedDocument(), lateProjector = createSharedIncrementalProjector(late);
      try {
        assertIncremental(late, lateProjector);
        assert.deepEqual(applySharedUpdate(late, encodeSharedState(run.a)), { ok: true }); assertIncremental(late, lateProjector);
        const readings: ReplicaReading<unknown>[] = handles.map((handle, index) => {
          checkpoint(index);
          return { order, replica: index ? "B" as const : "A" as const, output: projectSharedDocumentStep(handle, base).changes };
        });
        readings.push({ order: "late-C", replica: "C", output: projectSharedDocumentStep(late, base).changes });
        assertReplicasAgree("report from the common start to the settled document on every copy", readings); lateJoiners++;
      } finally { lateProjector.dispose(); destroySharedDocument(late); }
      histories++;
    } catch (error) { violations.push(`${where}: ${String(error)}`); }
    finally { for (const stop of stops) stop(); for (const projector of projectors) projector.dispose(); run.close(); }
  }
  assert.deepEqual(violations, declaredLimits);
  assert.deepEqual([...kinds].sort(), [...KINDS].sort());
  t.diagnostic(JSON.stringify({ histories, commands, checkpoints, lateJoiners, reports: incrementalReports.compared - started, totals }));
  assert.deepEqual({ histories, commands, lateJoiners }, { histories: 18, commands: 630, lateJoiners: 18 });
  assert.deepEqual({ checkpoints, reports: incrementalReports.compared - started, totals }, { checkpoints: 1387, reports: 1360,
    totals: { added: 164, removed: 149, moved: 16, changed: 103, fields: 521, whole: 0, empty: 689 } });
});
