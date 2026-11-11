import test from "node:test";
import assert from "node:assert/strict";
import { deliveryOrders } from "../../../collab/delivery.ts";
import { generatedHistory } from "./workload.ts";

for (const design of ["records"] as const) test(`${design}: seeded text and every mark obey the independent command rule`, t => {
  const limits: readonly string[] = [], violations: string[] = [];
  let commands = 0, deliveries = 0, checkpoints = 0, joins = 0, sameCommandComparisons = 0, formatItems = 0;
  const schedules = new Map(deliveryOrders.map(order => [order, 0]));
  const kinds = new Set<string>();
  for (const writers of [2, 3]) for (let seed = 1; seed <= 24; seed++) {
    const fingerprints = new Map<string, unknown>();
    for (const order of deliveryOrders) {
      try {
        const result = generatedHistory(design, seed, writers, order, undefined, true), fingerprint = result.log.join("\n");
        commands += result.commands; deliveries += result.deliveries; checkpoints += result.checkpoints; joins++; formatItems += result.formatItems;
        schedules.set(order, (schedules.get(order) ?? 0) + 1); result.kinds.forEach(kind => kinds.add(kind));
        assert.equal(result.sequential, order === "D2" ? result.commands : 0);
        assert.equal(result.selective > 0, order === "D3");
        assert.equal(result.early, order === "late-C"); assert.equal(result.afterJoin > 0, order === "late-C");
        if (fingerprints.has(fingerprint)) { assert.deepEqual(result.output, fingerprints.get(fingerprint), "same commands across schedules"); sameCommandComparisons++; }
        else fingerprints.set(fingerprint, result.output);
      } catch (error) { violations.push(String(error)); break; }
    }
    if (violations.length) break;
  }
  if (violations.length) throw new Error(violations.join("\n\n"));
  assert.deepEqual(violations, limits);
  assert.deepEqual([...schedules], [["D1",48],["D2",48],["D3",48],["dup",48],["rev",48],["late-C",48]]);
  assert.equal(kinds.size, 24);
  assert.equal(commands, 36000); assert.equal(deliveries, 70200); assert.equal(checkpoints, 6336); assert.equal(joins, 288);
  assert.equal(sameCommandComparisons, 96);
  if (design === "records") assert.equal(formatItems, 0);
  t.diagnostic(JSON.stringify({ commands, deliveries, checkpoints, joins, sameCommandComparisons, formatItems, schedules: [...schedules], kinds: [...kinds].sort() }));
});
