import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../../../collab/delivery.ts";
import { generatedHistory } from "./workload.ts";
import { interiorLoss, outsideEdge } from "./interior-loss.ts";
import { scratchMarkKinds } from "./events.ts";
import { ScratchReplica } from "./designs.ts";
import { assertReplicasAgree } from "../../../collab/agreement.ts";

for (const kind of scratchMarkKinds) for (const order of ["D1", "dup", "rev"] as const) test(`Design 1 lost mark: ${kind}/${order}`, () => {
  const result = interiorLoss("attributes", kind, order), late = new ScratchReplica("attributes", 91, undefined, result.state);
  try {
    assertReplicasAgree("lost immutable attribute", [{ order: "D1", replica: "A", output: result.expected },
      ...result.actual.map((output, index) => ({ order, replica: index ? "B" as const : "A" as const, output })),
      { order: "late-C", replica: "C", output: late.readNamed(result.book) }]);
  } finally { late.destroy(); }
});

test("Design 1 must exclude an insertion outside the selected mark range", () => {
  const result = outsideEdge("attributes", "D1");
  assert.deepEqual(result.actual[0], result.expected);
});

test("Design 1 has no permission to lose or invent a mark", t => {
  const limits: readonly string[] = [], violations: string[] = [];
  let passed = 0, commands = 0, deliveries = 0;
  let failedAttempt: { commands: number; deliveries: number } | null = null;
  histories: for (const writers of [2, 3]) for (let seed = 1; seed <= 24; seed++) {
    for (const order of deliveryOrders) {
      try {
        const result = generatedHistory("attributes", seed, writers, order, history => { failedAttempt = { commands: history.commands.length, deliveries: history.deliveries }; }, true);
        passed++; commands += result.commands; deliveries += result.deliveries;
      } catch (error) {
        violations.push(String(error));
        t.diagnostic(JSON.stringify({ stoppedAt: { seed, writers, order }, completedRuns: passed, completedCommands: commands, completedDeliveries: deliveries, failedAttempt }));
        break histories;
      }
    }
    if (violations.length) break;
  }
  assert.deepEqual(violations, limits);
});
