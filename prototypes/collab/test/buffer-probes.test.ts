import assert from "node:assert/strict";
import { test } from "node:test";
import { minimalSplices, bufferMechanisms } from "../src/editing-buffer.ts";
import { probeAmbiguousDiff, probeDeleteFirst, probeMissingRecovery, probeProviderBypass, probeQueueBound, probeRecapturedBase } from "./buffer-probes.ts";

test("the the -> the has four indistinguishable minimal string diffs", () => {
  assert.deepEqual(minimalSplices("the the", "the"), [
    { from: 0, to: 4, insert: "" }, { from: 1, to: 5, insert: "" },
    { from: 2, to: 6, insert: "" }, { from: 3, to: 7, insert: "" }
  ]);
});

for (const candidate of ["A", "B"] as const) {
  for (const mechanism of bufferMechanisms) {
    test(`${candidate} ${mechanism}: missing native target evidence fails T03`, () => {
      const result = probeAmbiguousDiff(candidate, mechanism);
      assert.equal(result.status, "FAIL");
      assert.match(result.difference ?? "", /Ambiguous native diff: 4 minimal splices/);
    });
    test(`${candidate} ${mechanism}: a recaptured input-handler base fails T02`, () => {
      const result = probeRecapturedBase(candidate, mechanism, "T02");
      assert.equal(result.status, "FAIL");
      assert.match(result.difference ?? "", /A.E.rows\[0\].characters\[0\].identity/);
    });
    for (const order of ["D1", "D3"] as const) {
      test(`${candidate} ${mechanism} ${order}: delete-first replacement probes the original-gap requirement`, () => {
        const result = probeDeleteFirst(candidate, mechanism, order);
        assert.equal(result.status, mechanism === "M2" && order === "D3" ? "PASS" : "FAIL");
        if (result.status === "FAIL") assert.match(result.difference ?? "", /A.E.rows\[0\].characters\[1\].identity/);
      });
    }
  }
  for (const mechanism of ["M1", "M3"] as const) {
    test(`${candidate} ${mechanism}: prolonged composition reaches its byte bound without dropping the transport message`, () => {
      const result = probeQueueBound(candidate, mechanism);
      assert.equal(result.status, "FAIL");
      assert.match(result.difference ?? "", /dirty queue needs \d+ bytes, bound \d+/);
      const actual = result.observed as { A: { dirty: boolean; transportPending: number } };
      assert.equal(actual.A.dirty, true);
      assert.equal(actual.A.transportPending, 1);
    });
  }
  test(`${candidate} M2: recapturing the replica base at composition commit fails T04`, () => {
    assert.equal(probeRecapturedBase(candidate, "M2", "T04").status, "FAIL");
  });
  test(`${candidate} M2: an active-only mapper cannot commit to a removed target`, () => {
    const result = probeMissingRecovery(candidate);
    assert.equal(result.status, "FAIL");
    assert.match(result.difference ?? "", /Painted target R1 is removed/);
  });
  test(`${candidate} M1: the actual provider bypasses deferral; identity mapping still passes the content oracle`, () => {
    const result = probeProviderBypass(candidate);
    assert.equal(result.status, "FAIL");
    assert.match(result.difference ?? "", /M1 deferral violated/);
    assert.ok(result.history.at(-1)?.includes("content oracle still PASS"));
  });
}
