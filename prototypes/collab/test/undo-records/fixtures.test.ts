import assert from "node:assert/strict";
import { test } from "node:test";
import { bufferOracles, bufferTraceOrder } from "../buffer-oracles.ts";
import { replacementIntentFixtures } from "../buffer-replacements.ts";
import { attempt, bufferOrders, runBufferTrace, runReplacement } from "./buffer-runner.ts";
import { recordTraces, runRecord } from "./runner.ts";

for (const [trace, orders] of Object.entries(recordTraces)) {
  for (const swapped of trace === "T06" ? [false, true] : [false]) {
    for (const order of orders) {
      test(`B command records: ${trace} ${order}${swapped ? " swapped client ids" : ""}, literal forward and undo oracles`, () => {
        const result = runRecord(trace, order, swapped);
        assert.equal(result.failure, null, result.history.join("\n"));
        assert.ok(result.checks >= 2);
      });
    }
  }
}

for (const trace of bufferTraceOrder) {
  for (const order of bufferOrders(bufferOracles[trace].orders)) {
    test(`B/M1 command records: ${trace} ${order}, literal forward and undo oracles; the library manager stays empty`, () => {
      assert.equal(attempt(() => runBufferTrace(trace, order)), null);
    });
  }
}

for (const fixture of replacementIntentFixtures) {
  for (const order of bufferOrders(fixture.orders)) {
    test(`B/M1 command records: replacement ${fixture.name} ${order}, literal forward and undo oracles`, () => {
      assert.equal(attempt(() => runReplacement(fixture, order)), null);
    });
  }
}
