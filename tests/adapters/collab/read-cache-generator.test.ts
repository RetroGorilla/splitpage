import assert from "node:assert/strict";
import { test } from "node:test";
import { replicas, execute, ref } from "./executor-support.ts";
import { cacheText, cacheStatus } from "./read-cache-support.ts";
import { readCollabMarkState } from "../../../src/adapters/collab/mark-store.ts";
import { destroySharedDocument, applySharedUpdate, encodeSharedState, observeSharedTransactions, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument as createSharedDocument } from "./helpers.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";

function reading(handle: SharedDocumentHandle) {
  return { texts: ["R1", "R2"].map(row => {
    const { text, store } = cacheText(handle, row);
    return { row, marks: readCollabMarkState(handle, text, store), status: cacheStatus(handle, row) };
  }), projection: projectSharedDocumentWithRecovery(handle) };
}

test("seeded cached readings match encoded fresh readings at every local and delivered transaction", t => {
  const declaredLimits: readonly string[] = [], violations: string[] = [], kinds = new Set<string>();
  const markKinds = ["b", "i", "u", "s", "hl", "dir", "cue", "comment", "tag", "link"] as const;
  const choices = new Set<string>();
  let histories = 0, commands = 0, checkpoints = 0, lateJoiners = 0;
  for (const seed of [1, 73, 1414, 0xfedcba98]) for (const writers of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) {
    const run = replicas(writers, { title: "Title", rows: [{ id: "R1", audioText: "abZ", status: "todo" }, { id: "R2", audioText: "other", status: "todo" }],
      people: [{ id: "P1", name: "Ada" }], productionTags: [{ id: "t_1", cat: "prop", name: "Cup", status: "needed" }] });
    const handles = [run.a, run.b, run.c].slice(0, writers), detach: (() => void)[] = [];
    let state = seed;
    const pick = (limit: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor(state / 4294967296 * limit);
    };
    const checkpoint = (handle: SharedDocumentHandle) => {
      const fresh = createSharedDocument();
      try {
        assert.deepEqual(applySharedUpdate(fresh, encodeSharedState(handle)), { ok: true });
        assertReplicasAgree(`seed=${seed} writers=${writers} order=${order}`, [
          { order, replica: "A", output: reading(handle) }, { order: "late-C", replica: "C", output: reading(fresh) }
        ]);
        checkpoints++;
      } catch (error) { violations.push(`seed=${seed} writers=${writers} order=${order}: ${String(error)}`); }
      finally { destroySharedDocument(fresh); }
    };
    try {
      for (const handle of handles) {
        registerSharedTextOperationHandlers(handle); registerSharedRecordHandlers(handle);
        reading(handle); detach.push(observeSharedTransactions(handle, () => { checkpoint(handle); }));
      }
      for (let round = 0; round < 2; round++) {
        for (const kind of ["text-insert", "mark", "text-delete", "status", "scalar", "record-set", "invalid-mark"] as const) {
          for (const [writer, handle] of handles.entries()) {
            const row = pick(2) ? "R2" : "R1", { text, store } = cacheText(handle, row), length = text.length;
            const from = pick(length), to = Math.min(length, from + 1 + pick(3)), choice = pick(markKinds.length);
            const id = `s${seed}_w${writer}_r${round}_${kind}`, target = { owner: row, segment: "b:" + row, field: "audioText" };
            choices.add(JSON.stringify([seed, row, from, to, choice])); kinds.add(kind);
            if (kind === "invalid-mark") {
              transactSharedDocument(handle, "local-command", () => { store.set("invalid", choice % 2 ? null : { operation: id, start: ["wrong"] }); });
            } else if (kind === "status") {
              const target = { scope: "beat" as const, record: ref(row) };
              execute(handle, { kind, id, by: "Writer", target, value: choice % 2 ? "ready" : "shot", parents: readSharedStatusHeads(handle, target) });
            } else if (kind === "scalar") execute(handle, { kind, id, by: "Writer", target: { scope: "beat", record: row }, field: "lengthSeconds", value: choice });
            else if (kind === "record-set") execute(handle, { kind, id, by: "Writer", target: { collection: "people", record: "P1" }, field: "name", value: "Ada" + choice });
            else {
              const markKind = markKinds[choice]; assert.ok(markKind);
              if (kind === "mark") kinds.add("mark:" + markKind);
              const mark = markKind === "comment" ? { kind: markKind, id: "C1", value: true } : markKind === "tag" ? { kind: markKind, id: "t_1", value: "t_1" }
                : markKind === "link" ? { kind: markKind, id: "https://example.test", value: "https://example.test" } : { kind: markKind, value: true };
              const command = readOperation(kind === "text-insert" ? { kind, id, by: "Writer", target,
                at: { left: null, right: flowBaseReference(row, "audioText", from), affinity: "before" }, content: [{ value: String.fromCharCode(65 + writer), marks: [] }] }
                : { kind, id, by: "Writer", target, observed: [flowBaseReference(row, "audioText", from, to)], ...(kind === "mark" ? { mark } : {}) });
              assert.ok(command);
              assert.deepEqual(executeSharedOperations(handle, [command], { base: readSharedRevision(handle) }), { ok: true });
            }
            commands++;
          }
        }
        run.queue.flush(order);
      }
      const late = createSharedDocument();
      try {
        assert.deepEqual(applySharedUpdate(late, encodeSharedState(run.a)), { ok: true });
        assertReplicasAgree("settled cache history", [
          ...handles.map((handle, index) => ({ order, replica: index ? "B" as const : "A" as const, output: reading(handle) })),
          { order: "late-C", replica: "C", output: reading(late) }
        ]);
        lateJoiners++;
      } finally { destroySharedDocument(late); }
      histories++;
    } catch (error) { violations.push(`seed=${seed} writers=${writers} order=${order}: ${String(error)}`); }
    finally { for (const stop of detach) stop(); run.close(); }
  }
  assert.deepEqual(violations, declaredLimits);
  assert.equal(histories, 24); assert.equal(commands, 840); assert.equal(lateJoiners, 24);
  assert.equal(checkpoints, 2620); assert.equal(choices.size, 182);
  assert.deepEqual([...kinds].sort(), ["invalid-mark", "mark", "mark:b", "mark:comment", "mark:cue", "mark:dir", "mark:hl", "mark:i", "mark:link", "mark:s", "mark:tag", "mark:u", "record-set", "scalar", "status", "text-delete", "text-insert"]);
  t.diagnostic(JSON.stringify({ histories, commands, checkpoints, lateJoiners, choices: choices.size, declaredLimits }));
});
