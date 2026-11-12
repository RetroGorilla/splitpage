import test from "node:test";
import assert from "node:assert/strict";
import { projectSharedRemovalState, readSharedBufferRecoveryMetadata } from "../../../src/core/collab/removal-state.ts";

test("removal groups cancel identical unseen removals while an old restore cannot cancel a fresh removal", () => {
  const cases = [
    { entries: [], expected: { generation: null, removed: false } },
    { entries: [["raw", true], ["inactive", false]], expected: { generation: 0, removed: true } },
    { entries: [["A", { generation: 0, removed: true }], ["B", { generation: 0, removed: true }]], expected: { generation: 0, removed: true } },
    { entries: [["A", { generation: 0, removed: false }], ["B", { generation: 0, removed: true }]], expected: { generation: 0, removed: false } },
    { entries: [["A", { generation: 0, removed: false }], ["B", { generation: 0, removed: false }], ["C", { generation: 1, removed: true }]], expected: { generation: 1, removed: true } },
    { entries: [["A", { generation: 0, removed: true }], ["C", { generation: 1, removed: false }]], expected: { generation: 1, removed: false } }
  ];
  for (const { entries, expected } of cases) {
    assert.deepEqual(projectSharedRemovalState(entries), expected);
    assert.deepEqual(projectSharedRemovalState([...entries].reverse()), expected);
    assert.deepEqual(projectSharedRemovalState([...entries, ...entries]), expected);
  }
});

test("wrong-shaped removal flags and malformed identities cannot hide or cancel a beat", () => {
  for (const value of [undefined, null, false, 1, "true", [], {}, { generation: -1, removed: true }, { generation: 0.5, removed: true },
    { generation: Infinity, removed: true }, { generation: 0, removed: "false" }]) {
    assert.deepEqual(projectSharedRemovalState([["invalid", value]]), { generation: null, removed: false });
  }
  const hole = new Array<unknown>(2); hole[1] = true;
  assert.deepEqual(projectSharedRemovalState([["", true], ["\ud800", true], ["\ufffd", true], undefined, hole]), { generation: null, removed: false });
  assert.deepEqual(projectSharedRemovalState([["A", true], ["bad", { generation: 99, removed: "false" }]]), { generation: 0, removed: true });
});

test("buffer recovery metadata retains a historical source and revision through one validator", () => {
  assert.deepEqual(readSharedBufferRecoveryMetadata({ bufferSourceOwner: "R1", bufferPaintedBase: 7, audioText: "aZd" }),
    { bufferSourceOwner: "R1", bufferPaintedBase: 7 });
  for (const value of [null, [], {}, { bufferSourceOwner: "R1" }, { bufferPaintedBase: 7 }, { bufferSourceOwner: "", bufferPaintedBase: 7 },
    { bufferSourceOwner: "\ud800", bufferPaintedBase: 7 }, { bufferSourceOwner: "R1", bufferPaintedBase: -1 }, { bufferSourceOwner: "R1", bufferPaintedBase: 0.5 }]) {
    assert.equal(readSharedBufferRecoveryMetadata(value), null);
  }
});
