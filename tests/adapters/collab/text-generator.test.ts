import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../../collab/delivery.ts";
import { generatedHistory } from "./marks/workload.ts";
import { TextExecutorTraceReplica } from "./text-trace-replica.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";

test("seeded text and mark executor obeys the independent rule in two and three writer histories", t => {
  const limits: readonly string[] = [], violations: string[] = [];
  const kinds = new Map<string, number>(), variants = new Set<string>(), schedules = new Map(deliveryOrders.map(order => [order, 0]));
  let commands = 0, deliveries = 0, checkpoints = 0, joins = 0, sameHistories = 0;
  for (const writers of [2, 3]) for (let seed = 1; seed <= 24; seed++) {
    const histories = new Map<string, ReplicaReading<unknown>>();
    for (const order of deliveryOrders) {
      try {
        const result = generatedHistory(seed, writers, order, (client, initial, state) => new TextExecutorTraceReplica(client, initial, state, kind => kinds.set(kind, (kinds.get(kind) ?? 0) + 1)));
        commands += result.commands; deliveries += result.deliveries; checkpoints += result.checkpoints; joins++;
        schedules.set(order, (schedules.get(order) ?? 0) + 1); result.kinds.forEach(kind => variants.add(kind));
        assert.equal(result.sequential, order === "D2" ? result.commands : 0); assert.equal(result.selective > 0, order === "D3");
        assert.equal(result.early, order === "late-C"); assert.equal(result.afterJoin > 0, order === "late-C");
        const fingerprint = result.log.join("\n");
        if (histories.has(fingerprint)) {
          const previous = histories.get(fingerprint), late = result.readings.at(-1); assert.ok(previous && late);
          assertReplicasAgree("same generated commands across schedules", [previous, late]); sameHistories++;
        } else { const first = result.readings[0]; assert.ok(first); histories.set(fingerprint, first); }
      } catch (error) { violations.push(String(error)); break; }
    }
    if (violations.length) break;
  }
  assert.deepEqual(violations, limits);
  assert.deepEqual([...schedules], [["D1",48],["D2",48],["D3",48],["dup",48],["rev",48],["late-C",48]]);
  assert.deepEqual([...kinds].sort(), [["mark", 14400], ["text-delete", 7200], ["text-insert", 14400]]);
  assert.equal(variants.size, 24); assert.equal(commands, 36000); assert.equal(deliveries, 70200); assert.equal(checkpoints, 6336); assert.equal(joins, 288); assert.equal(sameHistories, 96);
  t.diagnostic(JSON.stringify({ commands, executed: [...kinds], deliveries, checkpoints, joins, sameHistories, schedules: [...schedules], variants: variants.size, limits }));
});
