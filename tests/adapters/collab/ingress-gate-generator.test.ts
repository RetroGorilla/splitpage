import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate, observeSharedTransactions, observeSharedUpdates, readSharedRevision, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { holdSharedBuffer, observeSharedDeclined } from "../../../src/adapters/collab/ingress.ts";
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

function snapshot(handle: SharedDocumentHandle) {
  return { revision: readSharedRevision(handle), projection: shown(handle), vector: encodeSharedStateVector(handle) };
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

const totals = { top: 0, notified: 0, drained: 0, repeated: 0, waiting: 0, thrown: 0, buffered: 0 };

for (let seed = 1; seed <= 12; seed++) {
  test(`seeded ${seed}: updates that arrive at the top, inside notifications and inside the drain, with callbacks that throw: each announced revision holds exactly its prefix of the arrival order`, () => {
    let random = 0x16a7e + seed * 7919;
    const next = (below: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % below; };
    const run = recordReplicas(3, SOURCE), reference = createMonitoredSharedDocument();
    try {
      assert.deepEqual(applySharedUpdate(reference, encodeSharedState(run.b)), { ok: true });
      const made = [...written(run.a, "A", 7, next), ...written(run.c, "C", 5, next)], schedule: Uint8Array[] = [];
      for (const update of made) schedule.splice(next(schedule.length + 1), 0, update);
      for (let extra = 0; extra < 6; extra++) { const copy = schedule[next(schedule.length)]; assert.ok(copy); schedule.splice(next(schedule.length + 1), 0, copy); }

      const initial = snapshot(reference), expected: ReturnType<typeof snapshot>[] = [];
      let quiet = 0;
      for (const update of schedule) {
        const before = readSharedRevision(reference);
        assert.deepEqual(applySharedUpdate(reference, update), { ok: true });
        if (readSharedRevision(reference) === before) quiet++;
        expected.push(snapshot(reference));
      }

      const state = collabState(run.b), violations: string[] = [], announced: ReturnType<typeof snapshot>[] = [];
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
        announced.push(snapshot(run.b));
        maybe(true);
      });
      observeSharedUpdates(run.b, () => maybe(true));
      state.doc.on("beforeTransaction", () => { if (state.ingress.held.length) draining = true; maybe(false); });
      state.doc.on("afterAllTransactions", () => maybe(false));

      while (position < schedule.length) {
        const queued = state.ingress.held.length;
        draining = false; inside = false;
        try {
          if (next(2)) {
            const release = holdSharedBuffer(run.b), before = snapshot(run.b);
            totals.buffered++;
            for (let count = 1 + next(4); count > 0; count--) arrive();
            assert.deepEqual(snapshot(run.b), before, "a dirty interval publishes and applies no arrival");
            release();
          } else arrive();
        } catch (error) { surfaced += planned(error); }
        if (queued) violations.push(`arrival ${position}: the queue held ${queued} at the top`);
      }

      const last = readSharedRevision(reference);
      assert.deepEqual(announced, expected, "one notification per transaction, including repeated revisions, with its own content");
      let previous = initial;
      for (const current of announced) {
        const changed = current.projection !== previous.projection || !isDeepStrictEqual(current.vector, previous.vector);
        assert.ok(current.revision >= previous.revision, "revisions never decrease");
        assert.equal(current.revision, previous.revision + Number(changed), "only a changing transaction advances, by exactly one");
        previous = current;
      }
      assert.deepEqual([readSharedRevision(run.b), shown(run.b), encodeSharedStateVector(run.b)], [last, shown(reference), encodeSharedStateVector(reference)]);
      assert.deepEqual([state.ingress.holds.size, state.ingress.held.length, state.ingress.frames], [0, 0, 0]);
      assert.equal(surfaced, thrown, "each thrown error is thrown again after the drain");
      assert.deepEqual(violations.filter(violation => !DECLARED_LIMITS.some(limit => limit.violation.test(violation))), []);
      assert.deepEqual(DECLARED_LIMITS.filter(limit => !violations.some(violation => limit.violation.test(violation))).map(limit => limit.name), [], "a declared limit no run reached");
      totals.repeated += 6; totals.waiting += quiet - 6; totals.thrown += thrown;
    } finally { run.close(); destroySharedDocument(reference); }
  });
}

test("the seeded runs reached every placement: the top, a notification, the drain, repeats, updates waiting for an earlier one, thrown callbacks", () => {
  for (const [name, count] of Object.entries(totals)) assert.ok(count >= 5, `${name}: ${count}`);
});

for (let seed = 1; seed <= 6; seed++) {
  test(`seeded overflow ${seed}: every copy publishes its accepted arrival prefixes through refusal, release and redelivery`, () => {
    let random = seed * 7919;
    const next = (below: number): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % below; };
    const run = recordReplicas(3, SOURCE), references: SharedDocumentHandle[] = [];
    try {
      const updates: Uint8Array[][] = [[], []];
      for (const [index, handle] of [run.a, run.c].entries()) {
        const list = updates[index]; assert.ok(list);
        const stop = observeSharedUpdates(handle, update => { list.push(update); });
        transactSharedDocument(handle, "local-command", () => collabState(handle).roots.meta.set("extra", JSON.stringify({ payload: String(index).repeat(40000), seed })));
        if (!index) written(handle, "small", 1, () => 0);
        stop();
      }
      const controls = [run.a, run.b, run.c].map((handle, index) => {
        const reference = createMonitoredSharedDocument(); references.push(reference);
        assert.deepEqual(applySharedUpdate(reference, encodeSharedState(handle)), { ok: true });
        const revision = [3, 1, 2][index]; assert.ok(revision);
        assert.equal(readSharedRevision(handle), revision);
        collabState(reference).revision = revision;
        const expected: ReturnType<typeof snapshot>[] = [];
        observeSharedTransactions(handle, () => {
          const prefix = expected.shift(); assert.ok(prefix, "publication without an accepted arrival");
          assert.deepEqual(snapshot(handle), prefix, "each publication is exactly its accepted arrival prefix");
        });
        return {
          receive: (update: Uint8Array, accepted: boolean): void => {
            const before = snapshot(handle);
            if (accepted) { assert.deepEqual(applySharedUpdate(reference, update), { ok: true }); expected.push(snapshot(reference)); }
            assert.deepEqual(applySharedUpdate(handle, update), accepted ? { ok: true } : { ok: false, reason: "queue-full" });
            if (!accepted) assert.deepEqual(snapshot(handle), before, "a refusal changes neither projection nor native state");
          },
          settled: () => { assert.deepEqual(expected, [], "accepted prefixes were all published"); }
        };
      });
      const first = updates[next(2)]?.[0], a = updates[0], c = updates[1]; assert.ok(first && a && c);
      const oversized = first === a[0] ? c[0] : a[0], small = a[1]; assert.ok(oversized && small);
      const target = controls[1]; assert.ok(target);
      let declined = 0;
      const release = holdSharedBuffer(run.b), frozen = snapshot(run.b);
      observeSharedDeclined(run.b, () => { declined++; assert.notDeepEqual(snapshot(run.b), frozen); });
      target.receive(first, true);
      target.receive(oversized, false);
      target.receive(small, false);
      assert.deepEqual(snapshot(run.b), frozen);
      release();
      assert.equal(declined, 1);
      const retry = [oversized, small];
      if (next(2)) retry.reverse();
      for (const update of retry) {
        target.receive(update, true);
        if (next(2)) target.receive(update, true);
      }
      for (const [index, handle] of [run.a, run.b, run.c].entries()) {
        const control = controls[index]; assert.ok(control);
        control.receive(encodeSharedUpdate(run.b, encodeSharedStateVector(handle)), true);
        control.settled();
      }
      assert.deepEqual([shown(run.a), shown(run.c)], [shown(run.b), shown(run.b)]);
      assert.equal(projectSharedDocument(run.b).rows[1]?.lengthSeconds, 100);
    } finally { run.close(); for (const reference of references) destroySharedDocument(reference); }
  });
}
