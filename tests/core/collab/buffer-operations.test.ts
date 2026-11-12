import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedTextBuffer } from "../../../src/core/collab/buffer.ts";
import { bufferedTextOperations } from "../../../src/core/collab/buffer-operations.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";

const ref = (value: string) => value as SharedContentRef;
const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };

test("literal native replacement operations use painted occurrence identities even when all letters match", () => {
  const buffer = createSharedTextBuffer(9, "aaa"); buffer.replace(1, 2, "a");
  const painted = { revision: 9, text: "aaa", identity: (index: number) => [ref("first"), ref("selected"), ref("last")][index] ?? null };
  assert.deepEqual(bufferedTextOperations(buffer.plan(), painted, target,
    [{ text: "a", marks: {} }, { text: "a", marks: { b: true } }, { text: "a", marks: {} }], { id: "native", by: "Alice" }), [
    { kind: "text-insert", target, at: { left: null, right: "selected", affinity: "before" }, content: [{ value: "a", marks: [{ kind: "b", value: true }] }], id: "native:0:0", by: "Alice" },
    { kind: "text-delete", target, id: "native:0:delete", by: "Alice", observed: ["selected"] }
  ]);
});

test("empty input needs a painted native gap; a different revision and unproved DOM text are refused", () => {
  const buffer = createSharedTextBuffer(1, ""); buffer.replace(0, 0, "Z");
  const painted = { revision: 1, text: "", identity: () => null };
  assert.throws(() => bufferedTextOperations(buffer.plan(), painted, target, [{ text: "Z", marks: {} }], { id: "native", by: "Alice" }), /empty gap/);
  assert.throws(() => bufferedTextOperations(buffer.plan(), { ...painted, revision: 2 }, target, [{ text: "Z", marks: {} }], { id: "native", by: "Alice" }), /native evidence/);
  assert.throws(() => bufferedTextOperations(buffer.plan(), { ...painted, emptyGap: ref("gap") }, target, [{ text: "different", marks: {} }], { id: "native", by: "Alice" }), /native evidence/);
});
