import assert from "node:assert/strict";
import { test, mock } from "node:test";
import * as Y from "yjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { execute, operation, replicas } from "./executor-support.ts";

test("status preparation enumerates unrelated status events once, with literal map-read counts", () => {
  const counts: number[] = [];
  for (const size of [0, 100]) {
    const run = replicas();
    try {
      transactSharedDocument(run.a, "remote", () => {
        for (let index = 0; index < size; index++) collabState(run.a).roots.statusEvents.set(`other${index}`,
          operation({ kind: "status", id: `other${index}`, by: "Other", target: { scope: "beat", record: "R2" }, value: "ready", parents: [] }));
      });
      const reads = mock.method(Y.Map.prototype, "get");
      try {
        execute(run.a, { kind: "status", id: "new", by: "A", target: { scope: "beat", record: "R1" }, value: "shot", parents: [] });
        counts.push(reads.mock.callCount());
      } finally { reads.mock.restore(); }
    } finally { run.close(); }
  }
  assert.deepEqual(counts, [4, 104]);
});
