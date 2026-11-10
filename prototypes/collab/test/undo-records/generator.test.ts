import assert from "node:assert/strict";
import { test } from "node:test";
import { execute, generate, generatorLength, generatorRuns } from "./generator.ts";
import type { Violation } from "./generator.ts";
import { declaredLimits, fixedReaderLimits, keptSeeds, limitFor } from "./limits.ts";

function unmatched(violations: readonly Violation[]): Violation[] {
  return violations.filter(violation => !limitFor(violation));
}

for (const fixed of fixedReaderLimits) {
  test(`fixed reader limit ${fixed.id}: the literal now passes`, () => {
    const result = fixed.run();
    assert.equal(result.failure, null, result.history.join("\n"));
    assert.ok(result.checks >= 2);
  });
  if ("minimal" in fixed) test(`fixed reader limit ${fixed.id}: its minimized generator history has no violation`, () => {
    const run = execute(fixed.minimal);
    assert.deepEqual(run.violations, [], run.history.join("\n"));
  });
}

for (const writers of [2, 3] as const) {
  test(`generator: ${generatorRuns} seeded ${writers}-writer histories; every violation matches a declared limit`, () => {
    let validated = 0, redone = 0;
    for (let seed = 1; seed <= generatorRuns; seed++) {
      const run = execute(generate(seed, writers, generatorLength));
      const open = unmatched(run.violations);
      assert.deepEqual(open, [], `seed ${seed}, ${writers} writers\n${run.history.filter(line => !line.startsWith("enqueue")).join("\n")}`);
      validated += run.executed["status events validated"] ?? 0;
      redone += run.executed["status events written by a redo validated"] ?? 0;
    }
    assert.ok(validated > 0 && redone > 0, `readStatusEvent saw ${validated} status events, ${redone} written by a redo`);
  });
}

for (const kept of keptSeeds) {
  test(`generator kept seed ${kept.seed}/${kept.writers} (${kept.found})`, () => {
    const run = execute(generate(kept.seed, kept.writers, generatorLength));
    assert.deepEqual(unmatched(run.violations), [], run.history.join("\n"));
    if (kept.reaches) assert.ok(run.violations.some(violation => limitFor(violation)?.id === kept.reaches), `seed no longer reaches ${kept.reaches}`);
  });
}

for (const limit of declaredLimits) {
  if (limit.minimal) {
    test(`limit ${limit.id}: its minimized generator history still shows it`, () => {
      const run = execute(limit.minimal ?? { writers: 2, reorderWithinSender: false, steps: [] }, { actOnPending: limit.actOnPending ?? false });
      assert.ok(run.violations.some(violation => limit.matches?.(violation)), run.history.join("\n"));
    });
  }
  if (limit.literal) {
    test(`limit ${limit.id}: its literal case still fails as declared`, () => {
      assert.match(limit.literal?.run().failure ?? "passed", limit.literal?.failure ?? /^$/);
    });
  }
}
