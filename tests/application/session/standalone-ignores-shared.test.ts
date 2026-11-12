import { test } from "node:test";
import assert from "node:assert/strict";
import { changeSet } from "../../../src/application/session/change-set.ts";
import type { CommandOutcome, Plan, SharedPlan } from "../../../src/application/session/document-session.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
import { harness, rawScript } from "../session-fakes.ts";
import type { HarnessHooks } from "../session-fakes.ts";

const NOTHING = { whole: false, cells: [], rowsInserted: [], rowsRemoved: [], rowsMoved: false, runsMoved: false, docFields: [], derive: [], saveNow: false };

function sharedPart(): SharedPlan {
  const operation = readOperation({ kind: "scalar", id: "o1", by: "A", target: { scope: "beat", record: "r1" }, field: "lengthSeconds", value: 7 });
  assert.ok(operation);
  return { operations: [operation], base: 99 };
}

function retitle(title: string, shared: SharedPlan | null): Plan {
  return { changes: changeSet({ docFields: ["title"] }), apply: live => { live.title = title; }, ...(shared ? { shared } : {}) };
}

function colour(shared: SharedPlan | null): Plan {
  return { changes: changeSet({ docFields: ["personColors"] }), apply: live => { live.personColors = { Ann: "red" }; }, ...(shared ? { shared } : {}) };
}

interface Told {
  outcome: CommandOutcome;
  log: string[];
  published: unknown[];
  document: string;
}

function told(hooks: HarnessHooks, act: (h: ReturnType<typeof harness>) => CommandOutcome): Told {
  const h = harness(undefined, hooks);
  h.session.adopt(rawScript("Harbour"));
  h.log.length = 0;
  h.published.length = 0;
  const outcome = act(h);
  return { outcome, log: h.log.slice(), published: h.published.slice(), document: h.session.read(doc => JSON.stringify(doc)) };
}

test("the standalone session ignores the shared part of a command's plan: it applies the plan as it does without one", () => {
  const run = (shared: SharedPlan | null): Told => told({}, h => h.session.run({ name: "retitle", needs: "edit", plan: () => retitle("Quay", shared) }));
  const without = run(null), withShared = run(sharedPart());
  const changes = { ...NOTHING, docFields: ["title"] };
  assert.deepEqual(withShared.outcome, { kind: "applied", generation: 1, changes });
  assert.deepEqual(withShared.published, [{ kind: "edit", epoch: 1, generation: 1, changes }]);
  assert.equal((JSON.parse(withShared.document) as { title: string }).title, "Quay");
  assert.equal((JSON.parse(withShared.document) as { rows: { lengthSeconds?: number }[] }).rows.some(row => row.lengthSeconds === 7), false);
  assert.deepEqual(withShared, without);
});

test("the standalone session ignores the shared part of a stamp's plan and of the attribution plan", () => {
  const stamp = (shared: SharedPlan | null): Told => told({}, h => h.session.stamp({ name: "colour", plan: () => colour(shared) }));
  const stamped = stamp(sharedPart());
  assert.deepEqual((JSON.parse(stamped.document) as { personColors: unknown }).personColors, { Ann: "red" });
  assert.deepEqual(stamped, stamp(null));
  const signed = (shared: SharedPlan | null): Told => told({ attribute: doc => doc.personColors ? null : colour(shared) },
    h => h.session.run({ name: "retitle", needs: "edit", plan: () => retitle("Quay", null) }));
  const attributed = signed(sharedPart());
  assert.equal(attributed.outcome.kind, "applied");
  assert.deepEqual((JSON.parse(attributed.document) as { title: unknown; personColors: unknown }).personColors, { Ann: "red" });
  assert.equal((JSON.parse(attributed.document) as { title: unknown }).title, "Quay");
  assert.deepEqual(attributed, signed(null));
});
