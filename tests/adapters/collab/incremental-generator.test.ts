import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { replicas, ref } from "./executor-support.ts";
import { createSharedIncrementalProjector } from "../../../src/adapters/collab/incremental-project.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerBenchmarkHandlers, submitBenchmarkOperations } from "../../collab/benchmark-document.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { createMonitoredSharedDocument } from "./helpers.ts";
import { assertIncremental, incrementalReports, nativeMap } from "./incremental-support.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { operationExamples } from "../../core/collab/operation-examples.ts";
import { sharedJoinGlueRegisterField } from "../../../src/core/collab/projection/join-glue.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";
import type { SharedDocumentProjectionResult } from "../../../src/adapters/collab/project.ts";
import { registerSharedUndoOperationHandlers } from "../../../src/adapters/collab/undo-handlers.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";

test("seeded incremental projection agrees at every authored and delivered revision with no declared limits", t => {
  const declaredLimits: readonly string[] = [], violations: string[] = [], kinds = new Set<string>(), choices = new Set<string>();
  let histories = 0, checkpoints = 0, commands = 0, lateJoiners = 0;
  const reported = incrementalReports.compared;
  for (const seed of [1, 73, 1414, 0xfedcba98]) for (const writers of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const run = replicas(writers, { title: "Script", rows: [
      { id: "R1", audioText: "abcdefgh" }, { id: "R2", audioText: "uvwxyz" }, { id: "R3", audioText: "thirty" }, { id: "R4", audioText: "heading source" }
    ], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }], productionTags: [{ id: "t_1", cat: "prop", name: "Cup", status: "needed" }] });
    const handles = [run.a, run.b, run.c].slice(0, writers), projectors = handles.map(handle => createSharedIncrementalProjector(handle));
    let state = seed;
    const pick = (limit: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const choice = Math.floor(state / 4294967296 * limit); choices.add(JSON.stringify([seed, state, limit, choice])); return choice;
    };
    const checkpoint = (index: number): void => {
      const handle = handles[index], projector = projectors[index]; assert.ok(handle && projector);
      try { assertIncremental(handle, projector); checkpoints++; }
      catch (error) { violations.push(`seed=${seed} writers=${writers} order=${order}: ${String(error)}`); }
    };
    for (const [index, handle] of handles.entries()) { const projector = projectors[index]; assert.ok(projector); assertIncremental(handle, projector); }
    const stops = projectors.map((projector, index) => projector.observe(() => checkpoint(index)));
    try {
      for (const handle of handles) { registerBenchmarkHandlers(handle); registerSharedUndoOperationHandlers(handle); }
      for (const [writer, handle] of handles.entries()) {
        const roots = collabState(handle).roots, prefix = `s${seed}w${writer}`, by = "Writer";
        const submit = (command: { kind: string } & Record<string, unknown>): void => {
          submitBenchmarkOperations(handle, [{ id: prefix + command.kind, by, ...command }]); kinds.add(command.kind); commands++;
        };
        const target = { owner: "R1", segment: "b:R1", field: "audioText" }, offset = pick(5);
        submit({ kind: "text-insert", target, at: { left: null, right: flowBaseReference("R1", "audioText", offset), affinity: "before" },
          content: [{ value: String.fromCharCode(65 + pick(26)), marks: [] }] });
        submit({ kind: "mark", target, observed: [flowBaseReference("R1", "audioText", 0, 2 + pick(3))], mark: { kind: pick(2) ? "b" : "i", value: true } });
        const preparation = createSharedPreparation(handle);
        const occurrences = preparation.view.text(["segments", "b:R1", "text"])?.records.filter(item => item.record.type === "add").map(item => item.identity);
        preparation.close(); assert.ok(occurrences); assert.equal(occurrences.length, 1);
        submit({ kind: "mark-retract", target, occurrences });
        const anchorTarget = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
        const deleted = createSharedAnchor(handle, anchorTarget, 6, "after"), left = createSharedAnchor(handle, anchorTarget, 5, "after"); assert.ok(deleted && left);
        submit({ kind: "text-delete", target, observed: [flowBaseReference("R1", "audioText", 6, 7)] });
        submit({ kind: "text-restore", target, units: [{ unit: deleted, left, value: "f", marks: [] }] });
        submit({ kind: "scalar", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 1 + pick(40) });
        const statusTarget = { scope: "beat" as const, record: ref("R1") };
        const status = pick(2) ? "ready" : "shot";
        submit({ kind: "status", target: statusTarget, value: status, parents: readSharedStatusHeads(handle, statusTarget) });
        submit({ kind: "status-retire", target: statusTarget, value: status, event: JSON.stringify([String(collabState(handle).doc.clientID), prefix + "status"]) });
        const person = "P" + writer;
        submit({ kind: "record-create", target: { collection: "people", record: person }, fields: { id: person, name: "Ada" } });
        submit({ kind: "record-set", target: { collection: "people", record: person }, field: "name", value: "Ada" + pick(99) });
        submit({ kind: "record-delete", target: { collection: "people", record: person } });
        for (const [kind, row] of [["split", "R2"], ["split-before", "R3"]] as const) submit({ kind,
          target: { owner: row, segment: "b:" + row, field: "audioText" }, at: { left: null, right: flowBaseReference(row, "audioText", 1 + pick(4)), affinity: "before" },
          observed: [], boundary: prefix + kind + "boundary", beat: prefix + kind + "beat", fields: { status: "todo" } });
        submit({ kind: "segment-create", segment: prefix + "segment", beat: prefix + "new", at: { left: null, right: null, affinity: "after" }, fields: { status: "todo" } });
        const raw = (kind: string, change: () => void): void => { transactSharedDocument(handle, "local-command", change); kinds.add(kind); commands++; };
        raw("join", () => {
          const joins = nativeMap(handle, "beats", "R2").get("joins"); assert.ok(joins instanceof Y.Map); joins.set(prefix, { into: "R1", glue: " " });
          if (pick(2)) { const reverse = nativeMap(handle, "beats", "R1").get("joins"); assert.ok(reverse instanceof Y.Map); reverse.set(prefix + "cycle", { into: "R2", glue: " " }); }
        });
        raw("join-glue", () => {
          roots.meta.set(sharedJoinGlueRegisterField('["join-retirement","R2","R1"," ",0]'), pick(2) ? " " : "");
        });
        raw("remove", () => {
          const removals = nativeMap(handle, "beats", "R4").get("removals"); assert.ok(removals instanceof Y.Map); removals.set(prefix, true);
        });
        raw("restore", () => {
          const removals = nativeMap(handle, "beats", "R4").get("removals"); assert.ok(removals instanceof Y.Map); removals.delete(prefix);
        });
        raw("heading-create", () => {
          const heading = new Y.Map<unknown>(); heading.set("id", prefix + "heading"); roots.headings.set(prefix + "heading", heading);
          const segment = new Y.Map<unknown>(); segment.set("head", { h: prefix + "heading" }); segment.set("text", new Y.Text("New Scene " + pick(9)));
          roots.segments.set(prefix + "heading-segment", segment); roots.order.push([prefix + "heading-segment"]);
        });
        raw("heading-finalize", () => nativeMap(handle, "segments", "b:R4").set("head", { h: prefix + "heading" }));
        raw("heading-remove", () => roots.headings.delete(prefix + "heading"));
        raw("segment-move", () => {
          const order = roots.order.toArray();
          for (let index = order.length - 1; index > 0; index--) { const other = pick(index + 1); [order[index], order[other]] = [order[other] as string, order[index] as string]; }
          roots.order.delete(0, roots.order.length); roots.order.push(order);
        });
      }
      run.queue.flush(order);
      const late = createMonitoredSharedDocument(), lateProjector = createSharedIncrementalProjector(late);
      try {
        assertIncremental(late, lateProjector);
        assert.deepEqual(applySharedUpdate(late, encodeSharedState(run.a)), { ok: true }); assertIncremental(late, lateProjector);
        const readings: ReplicaReading<SharedDocumentProjectionResult>[] = handles.map((handle, index) => {
          checkpoint(index); const value = projectors[index]?.read(); assert.ok(value);
          return { order, replica: index ? "B" as const : "A" as const, output: { document: value.document, recovery: value.recovery } };
        });
        readings.push({ order: "late-C", replica: "C", output: projectSharedDocumentWithRecovery(late) });
        assertReplicasAgree("settled incremental history including encoded late joiner", readings); lateJoiners++;
      } finally { lateProjector.dispose(); destroySharedDocument(late); }
      histories++;
    } catch (error) { violations.push(`seed=${seed} writers=${writers} order=${order}: ${String(error)}`); }
    finally { for (const stop of stops) stop(); for (const projector of projectors) projector.dispose(); run.close(); }
  }
  assert.deepEqual(violations, declaredLimits);
  assert.equal(histories, 24); assert.equal(lateJoiners, 24); assert.equal(commands, 1320);
  assert.equal(checkpoints, 2756);
  assert.equal(incrementalReports.compared - reported, 2720);
  assert.equal(choices.size, 216);
  assert.deepEqual([...kinds].sort(), ["heading-create", "heading-finalize", "heading-remove", "join", "join-glue", "mark", "mark-retract", "record-create", "record-delete", "record-set",
    "remove", "restore", "scalar", "segment-create", "segment-move", "split", "split-before", "status", "status-retire", "text-delete", "text-insert", "text-restore"]);
  assert.deepEqual([...new Set(operationExamples.map(example => example.operation.kind))].sort(), [...kinds].sort());
  t.diagnostic(JSON.stringify({ histories, commands, checkpoints, lateJoiners, choices: choices.size, declaredLimits }));
});
