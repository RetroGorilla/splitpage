import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedTextBuffer } from "../../../src/core/collab/buffer.ts";
import { bufferedRecoveryOperations, bufferedTextOperations } from "../../../src/core/collab/buffer-operations.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";
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

test("rule 29 literal list: one creation after the source's segment carrying the source owner and painted base, then its removal; an empty field observes nothing", () => {
  const literal = bufferedRecoveryOperations({ owner: "R1", base: 7, html: "aZd", units: 3, segment: "b:R1" }, { id: "r17", by: "Alice" }, { rows: 2, visual: "structure_1_007200310037_visual_0" });
  assert.deepEqual(literal, [
    { kind: "segment-create", id: "r17", by: "Alice", segment: "draft_segment_r17", beat: "draft_r17",
      at: { left: "b:R1", right: null, affinity: "after" }, fields: { audioText: "aZd", bufferSourceOwner: "R1", bufferPaintedBase: 7 } },
    { kind: "remove", id: "r17_remove", by: "Alice", removalKind: "beat", targets: ["draft_r17"], observed: ['["flow-base","draft_r17","audioText",0,3]'],
      boundaries: ["draft_r17"], components: ["structure_1_007200310037_visual_0"], gallery: [], comments: [], at: 2 }
  ]);
  const empty = bufferedRecoveryOperations({ owner: "R9", base: 0, html: "", units: 0 }, { id: "e1", by: "Bob" }, { rows: 0, visual: "v" });
  assert.deepEqual(empty[0]?.kind === "segment-create" && [empty[0].fields, empty[0].at], [{ audioText: "", bufferSourceOwner: "R9", bufferPaintedBase: 0 }, { left: null, right: null, affinity: "after" }]);
  assert.deepEqual(empty[1]?.kind === "remove" && [empty[1].observed, empty[1].targets, empty[1].at], [[], ["draft_e1"], 0]);
  for (const made of [...literal, ...empty]) assert.deepEqual(readOperation(made), made);
});

test("empty input needs a painted native gap; a different revision and unproved DOM text are refused", () => {
  const buffer = createSharedTextBuffer(1, ""); buffer.replace(0, 0, "Z");
  const painted = { revision: 1, text: "", identity: () => null };
  assert.throws(() => bufferedTextOperations(buffer.plan(), painted, target, [{ text: "Z", marks: {} }], { id: "native", by: "Alice" }), /empty gap/);
  assert.throws(() => bufferedTextOperations(buffer.plan(), { ...painted, revision: 2 }, target, [{ text: "Z", marks: {} }], { id: "native", by: "Alice" }), /native evidence/);
  assert.throws(() => bufferedTextOperations(buffer.plan(), { ...painted, emptyGap: ref("gap") }, target, [{ text: "different", marks: {} }], { id: "native", by: "Alice" }), /native evidence/);
});

for (const insertion of ["X", ""]) {
  test(`work bound: 100 separated ${insertion ? "replacements" : "deletions"} normalize the supplied field once`, context => {
    const buffer = createSharedTextBuffer(1, "a".repeat(1000));
    for (let index = 99; index >= 0; index--) buffer.replace(5 + index * 10, 6 + index * 10, insertion);
    const native = buffer.text();
    let reads = 0;
    const runs = Array.from({ length: native.length }, (_, index) => ({
      get text(): string { reads++; return native.charAt(index); }, marks: {}
    }));
    const painted = { revision: 1, text: "a".repeat(1000), identity: (index: number) => ref("unit:" + index) };
    const operations = bufferedTextOperations(buffer.plan(), painted, target, runs, { id: "bounded", by: "Alice" });
    assert.equal(operations.length, insertion ? 200 : 100);
    assert.ok(reads <= 4 * native.length, `${reads} supplied text reads for ${native.length} units`);
    context.diagnostic(JSON.stringify({ units: native.length, splices: 100, suppliedTextReads: reads }));
  });
}

test("prepared native units keep the existing surrogate-pair slicing policy", () => {
  const buffer = createSharedTextBuffer(1, "\ud83d\ude00"); buffer.replace(0, 1, "\ud83c");
  const painted = { revision: 1, text: "\ud83d\ude00", identity: (index: number) => ref("unit:" + index) };
  const operations = bufferedTextOperations(buffer.plan(), painted, target, [{ text: "\ud83c\ude00", marks: {} }], { id: "pair", by: "Alice" });
  assert.deepEqual(operations[0]?.kind === "text-insert" && operations[0].content, [{ value: "\ud83c\ude00", marks: [] }]);
});
