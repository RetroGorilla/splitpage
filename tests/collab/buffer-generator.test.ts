import { test } from "node:test";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../application/session/shared-session-support.ts";
import { createSharedBufferedText } from "../../src/adapters/collab/buffer.ts";
import { readSharedPaintedText } from "../../src/adapters/collab/paint-base.ts";
import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState } from "../../src/adapters/collab/document.ts";
import { projectSharedDocumentWithRecovery } from "../../src/adapters/collab/project.ts";
import { assertReplicasAgree } from "./agreement.ts";
import { bufferReaders, bufferStamps } from "./buffer-readers.ts";

const DECLARED_LIMITS: readonly { readonly name: string; readonly violation: RegExp }[] = [];
const WRITERS = ["Alice", "Bob", "Carol"] as const;
const EDITS = [{ from: 1, to: 2, insert: "A", text: "aAcd" }, { from: 2, to: 3, insert: "B", text: "abBd" },
  { from: 4, to: 4, insert: "C", text: "abcdC" }] as const;

for (let seed = 1; seed <= 12; seed++) {
  test(`seeded buffered history ${seed}: three native writers, held/reversed/duplicate arrivals and encoded late join`, () => {
    let random = seed * 7919;
    const next = (below: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % below; };
    const h = new Stage1ExecutorHarness([{ id: "R1", text: "abcd" }]); h.join();
    const handles = [h.a, h.b, h.c], late = createSharedDocument();
    const sessions = handles.map(handle => sharedHarness(adapterReplica(handle)));
    try {
      const edits = handles.map((handle, index) => {
        const session = sessions[index], spec = EDITS[index], by = WRITERS[index]; assert.ok(session && spec && by);
        const at = "2026-11-12T10:00:0" + (seed + index) % 2 + ".000Z";
        const port = createSharedBufferedText(handle, session.session, { target: id => h.target(id), author: () => ({ id: by + ":buffer", by }), readers: bufferReaders,
          stamps: bufferStamps(by, () => at) });
        const painted = readSharedPaintedText(handle, h.target("R1")); assert.ok(painted);
        const edit = port.open("R1", painted); assert.ok(edit);
        edit.replace(spec.from, spec.to, spec.insert);
        return edit;
      });
      const order = ["D1", "rev", "dup"] as const;
      const commitOrder: number[] = [];
      for (const index of [0, 1, 2]) commitOrder.splice(next(commitOrder.length + 1), 0, index);
      for (const index of commitOrder) {
        const edit = edits[index], spec = EDITS[index]; assert.ok(edit && spec);
        assert.equal(edit.commit([{ text: spec.text, marks: {} }]).kind, "applied");
        const schedule = order[next(order.length)]; assert.ok(schedule);
        h.queue.flush(schedule);
      }
      h.queue.flush("dup");
      assert.deepEqual(applySharedUpdate(late, encodeSharedState(h.a)), { ok: true });
      const readings = [...handles, late].map((handle, index) => ({ order: index === 3 ? "late-C" as const : "D1" as const,
        replica: index === 0 ? "A" as const : index === 1 ? "B" as const : "C" as const, output: projectSharedDocumentWithRecovery(handle) }));
      assertReplicasAgree("seeded buffer", readings);
      const violations: string[] = [];
      for (const handle of [...handles, late]) {
        const shown = projectSharedDocumentWithRecovery(handle);
        if (shown.document.rows[0]?.audioText !== "aABdC" || shown.recovery.length) violations.push("native edit lost or moved");
        if (!WRITERS.some(by => by === shown.document.rows[0]?.updatedBy)) violations.push("no writer's stamp shown");
      }
      assert.deepEqual(violations.filter(violation => !DECLARED_LIMITS.some(limit => limit.violation.test(violation))), []);
      assert.deepEqual(DECLARED_LIMITS.filter(limit => !violations.some(violation => limit.violation.test(violation))).map(limit => limit.name), []);
    } finally { for (const session of sessions) session.session.dispose(); destroySharedDocument(late); h.destroy(); }
  });
}
