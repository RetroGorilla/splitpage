import { test } from "node:test";
import assert from "node:assert/strict";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, encodeSharedStateVector, observeSharedTransactions, observeSharedUpdates, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { operation } from "./executor-support.ts";
import { createMonitoredSharedDocument, deliveryReplica } from "./helpers.ts";
import { recordReplicas } from "./record-support.ts";

const DECLARED_LIMITS: readonly { readonly name: string; readonly violation: RegExp }[] = [];

const SOURCE = { title: "Title", rows: [{ id: "R1", audioText: "ab", status: "todo" }, { id: "R2", audioText: "cd", status: "todo" }] };

class Planned extends Error {}

function shown(handle: SharedDocumentHandle): string {
  return JSON.stringify(projectSharedDocument(handle));
}

function written(handle: SharedDocumentHandle, by: string, count: number, next: (below: number) => number): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const stop = deliveryReplica(handle).onLocalUpdate(update => { updates.push(update); });
  for (let index = 0; index < count; index++) {
    const list = [operation({ kind: "scalar", id: `${by}${index}`, by, target: { scope: "beat", record: next(2) ? "R1" : "R2" }, field: "lengthSeconds", value: 100 * (index + 1) + next(90) })];
    assert.deepEqual(executeSharedOperations(handle, list, { base: readSharedRevision(handle) }), { ok: true });
  }
  stop();
  assert.equal(updates.length, count);
  return updates;
}

function planned(error: unknown): number {
  if (error instanceof Planned) return 1;
  assert.ok(error instanceof AggregateError, String(error));
  return (error.errors as unknown[]).reduce((sum: number, inner) => sum + planned(inner), 0);
}

const totals = { top: 0, notified: 0, drained: 0, repeated: 0, waiting: 0, thrown: 0, aborted: 0 };

for (let seed = 1; seed <= 12; seed++) {
  test(`seeded ${seed}: updates that arrive at the top, inside notifications and inside the drain, with callbacks that throw: each announced revision holds exactly its prefix of the arrival order`, () => {
    let random = 0x16a7e + seed * 7919;
    const next = (below: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % below; };
    const run = recordReplicas(3, SOURCE), reference = createMonitoredSharedDocument();
    try {
      assert.deepEqual(applySharedUpdate(reference, encodeSharedState(run.b)), { ok: true });
      const made = [...written(run.a, "A", 7, next), ...written(run.c, "C", 5, next)], schedule: Uint8Array[] = [];
      for (const update of made) schedule.splice(next(schedule.length + 1), 0, update);
      for (let extra = 0; extra < 6; extra++) { const copy = schedule[next(schedule.length)]; assert.ok(copy); schedule.splice(next(schedule.length + 1), 0, copy); }

      const expected = new Map<number, string>([[1, shown(reference)]]);
      let quiet = 0;
      for (const update of schedule) {
        const before = readSharedRevision(reference);
        assert.deepEqual(applySharedUpdate(reference, update), { ok: true });
        if (readSharedRevision(reference) === before) quiet++;
        else expected.set(readSharedRevision(reference), shown(reference));
      }

      const state = collabState(run.b), violations: string[] = [], announced = [1];
      let position = 0, inside = false, draining = false, thrown = 0, surfaced = 0;
      const arrive = (): void => {
        const update = schedule[position];
        if (!update) return;
        position++;
        if (!inside) totals.top++; else if (draining) totals.drained++; else totals.notified++;
        const result = applySharedUpdate(run.b, update);
        if (!result.ok) violations.push(`arrival ${position}: refused`);
      };
      const maybe = (fail: boolean): void => {
        inside = true;
        for (let more = next(5); more > 2; more--) arrive();
        if (fail && !next(6)) { thrown++; throw new Planned(); }
      };
      observeSharedTransactions(run.b, () => {
        const revision = readSharedRevision(run.b);
        if (expected.get(revision) !== shown(run.b)) violations.push(`revision ${revision}: its projection is not the projection of its prefix`);
        if (announced.at(-1) !== revision) announced.push(revision);
        maybe(true);
      });
      observeSharedUpdates(run.b, () => maybe(true));
      state.doc.on("beforeTransaction", () => { if (state.ingress.held.length) draining = true; maybe(false); });
      state.doc.on("afterAllTransactions", () => maybe(false));
      state.doc.on("update", () => { if (!next(9)) { thrown++; totals.aborted++; throw new Planned(); } });

      while (position < schedule.length) {
        const queued = state.ingress.held.length;
        draining = false; inside = false;
        try { arrive(); } catch (error) { surfaced += planned(error); }
        if (queued) violations.push(`arrival ${position}: the queue held ${queued} at the top`);
      }

      const last = readSharedRevision(reference);
      assert.deepEqual(announced, Array.from({ length: last }, (_unused, index) => index + 1), "each advancing revision is announced once, in order");
      assert.deepEqual([readSharedRevision(run.b), shown(run.b), encodeSharedStateVector(run.b)], [last, shown(reference), encodeSharedStateVector(reference)]);
      assert.deepEqual([state.ingress.holds.size, state.ingress.held.length, state.ingress.frames, state.doc._transactionCleanups.length], [0, 0, 0, 0]);
      assert.equal(surfaced, thrown, "each thrown error is thrown again after the drain");
      assert.deepEqual(violations.filter(violation => !DECLARED_LIMITS.some(limit => limit.violation.test(violation))), []);
      assert.deepEqual(DECLARED_LIMITS.filter(limit => !violations.some(violation => limit.violation.test(violation))).map(limit => limit.name), [], "a declared limit no run reached");
      totals.repeated += 6; totals.waiting += quiet - 6; totals.thrown += thrown;
    } finally { run.close(); destroySharedDocument(reference); }
  });
}

test("the seeded runs reached every placement: the top, a notification, the drain, repeats, updates waiting for an earlier one, thrown callbacks and aborted cleanups", () => {
  for (const [name, count] of Object.entries(totals)) assert.ok(count >= 5, `${name}: ${count}`);
});
