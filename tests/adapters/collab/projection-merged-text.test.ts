import assert from "node:assert/strict";
import { test } from "node:test";
import { replicas, agree, ref } from "./executor-support.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedTextAddress } from "../../../src/core/collab/operations.ts";
import type { SharedStoredMarkValue } from "../../../src/adapters/collab/stored-mark.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { literalMergedDocument, readPureMergedProjection, mergedProjectionSave } from "./projection-merged-support.ts";

const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
function add(handle: SharedDocumentHandle, operation: string, from: number, to: number, mark: SharedStoredMarkValue, address: SharedTextAddress = target): void {
  const record = prepareSharedMarkRecord(handle, address, operation, from, to, { type: "add", mark });
  assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, address, operation, record), { ok: true });
}
const cup = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Cup" contenteditable="false">';
const ada = '<span class="tag-anchor" data-tag-cat="cast" data-tag-name="Ada" contenteditable="false">';
const aLink = '<a href="https://a.test" target="_blank" rel="noopener">';
const zLink = '<a href="https://z.test" target="_blank" rel="noopener">';
const cases = [
  { name: "the same comment name is present once across overlapping occurrences", marks: [
    [0, 3, { kind: "comment", id: "z", value: "C1" }], [2, 4, { kind: "comment", id: "a", value: "C1" }]
  ], html: '<span class="cmt-anchor" data-cmt="C1">abcd</span>', recovery: [] },
  { name: "the same link name is present once across overlapping occurrences", marks: [
    [0, 3, { kind: "link", id: "z", value: "https://a.test" }], [2, 4, { kind: "link", id: "a", value: "https://a.test" }]
  ], html: aLink + "abcd</a>", recovery: [] },
  { name: "the same tag name is present once on identical ranges", marks: [
    [0, 4, { kind: "tag", id: "z", value: "t:prop:Cup" }], [0, 4, { kind: "tag", id: "a", value: "t:prop:Cup" }]
  ], html: cup + "abcd</span>", recovery: [] },
  { name: "overlapping occurrences of one name unite without crossing recovery", marks: [
    [0, 3, { kind: "tag", id: "z", value: "t:prop:Cup" }], [2, 4, { kind: "tag", id: "a", value: "t:prop:Cup" }]
  ], html: cup + "abcd</span>", recovery: [] },
  { name: "adjacent occurrences of one name merge as the app encoder does", marks: [
    [0, 2, { kind: "tag", id: "z", value: "t:prop:Cup" }], [2, 4, { kind: "tag", id: "a", value: "t:prop:Cup" }]
  ], html: cup + "abcd</span>", recovery: [] },
  { name: "containment uses the union of a name before accepting another name", marks: [
    [0, 2, { kind: "tag", id: "z", value: "t:prop:Cup" }], [1, 4, { kind: "tag", id: "y", value: "t:prop:Cup" }],
    [1, 3, { kind: "tag", id: "a", value: "t:cast:Ada" }]
  ], html: cup + "a" + ada + "bc</span>d</span>", recovery: [] },
  { name: "nested tags use extent length before occurrence id", marks: [
    [0, 4, { kind: "tag", id: "z", value: "t:prop:Cup" }], [1, 3, { kind: "tag", id: "a", value: "t:cast:Ada" }]
  ], html: cup + "a" + ada + "bc</span>d</span>", recovery: [] },
  { name: "crossing tag is untagged and recoverable", marks: [
    [0, 3, { kind: "tag", id: "z", value: "t:prop:Cup" }], [2, 4, { kind: "tag", id: "a", value: "t:cast:Ada" }]
  ], html: cup + "abc</span>d", recovery: [{ kind: "crossing-tag", occurrence: "a", tag: "t:cast:Ada", from: 2, to: 4, words: "cd", rowId: "R1", field: "audioText" }] },
  { name: "same-start longer tag is outer", marks: [
    [0, 4, { kind: "tag", id: "z", value: "t:prop:Cup" }], [0, 2, { kind: "tag", id: "a", value: "t:cast:Ada" }]
  ], html: cup + ada + "ab</span>cd</span>", recovery: [] },
  { name: "equal extents use UTF-16 occurrence ids", marks: [
    [0, 4, { kind: "tag", id: "\ue000", value: "t:prop:Cup" }], [0, 4, { kind: "tag", id: "\ud83d\ude00", value: "t:cast:Ada" }]
  ], html: ada + cup + "abcd</span></span>", recovery: [] },
  { name: "smallest link id wins each character", marks: [
    [0, 4, { kind: "link", id: "z", value: "https://z.test" }], [1, 3, { kind: "link", id: "a", value: "https://a.test" }]
  ], html: zLink + "a</a>" + aLink + "bc</a>" + zLink + "d</a>", recovery: [] },
  { name: "a partial link covers the tag stretch", marks: [
    [0, 4, { kind: "tag", id: "z", value: "t:prop:Cup" }], [1, 3, { kind: "link", id: "a", value: "https://a.test" }]
  ], html: aLink + cup + "abcd</span></a>", recovery: [] },
  { name: "partial comments union over a tag stretch", marks: [
    [0, 4, { kind: "tag", id: "z", value: "t:prop:Cup" }], [1, 3, { kind: "comment", id: "a", value: "C1" }],
    [2, 4, { kind: "comment", id: "b", value: "C2" }]
  ], html: '<span class="cmt-anchor" data-cmt="C1"><span class="cmt-anchor" data-cmt="C2">' + cup + 'abcd</span></span></span>', recovery: [] }
] as const;

for (const scenario of cases) for (const writers of [2, 3]) for (const order of deliveryOrders) test(`merged text: ${scenario.name}, ${writers} writers ${order}`, () => {
  const run = replicas(writers, { rows: [{ id: "R1", audioText: "abcd" }] });
  const handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])];
  try {
    scenario.marks.forEach(([from, to, mark], index) => {
      const handle = handles[index % writers]; assert.ok(handle);
      add(handle, "literal" + index, from, to, mark as SharedStoredMarkValue);
      if (order === "D2" || order === "D3" && index === 1) run.queue.flush(order);
    });
    if (writers === 3 && scenario.marks.length === 2) {
      const [from, to, mark] = scenario.marks[0]; add(run.c, "identical", from, to, mark as SharedStoredMarkValue);
    }
    run.queue.flush(order);
    const document = literalMergedDocument(scenario.html);
    for (const handle of handles) {
      assert.deepEqual(projectSharedDocumentWithRecovery(handle), { document, recovery: scenario.recovery });
      assert.equal(readPureMergedProjection(handle).save, mergedProjectionSave(document));
    }
    agree(scenario.name, order, handles, readPureMergedProjection);
  } finally { run.close(); }
});

for (const writers of [2, 3]) for (const order of deliveryOrders) test(`tag split parts constructed directly: same occurrence per beat, ${writers} writers ${order}`, () => {
  const run = replicas(writers, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }] });
  const handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])];
  try {
    add(run.a, "left-part", 0, 2, { kind: "tag", id: ref("same"), value: ref("t:prop:Cup") });
    if (order === "D2") run.queue.flush(order);
    add(run.b, "right-part", 0, 2, { kind: "tag", id: ref("same"), value: ref("t:prop:Cup") }, { owner: ref("R2"), segment: ref("b:R2"), field: "audioText" });
    if (writers === 3) add(run.c, "duplicate-part", 0, 2, { kind: "tag", id: ref("same"), value: ref("t:prop:Cup") });
    run.queue.flush(order);
    const document = literalMergedDocument(cup + "ab</span>");
    document.rows.push({ id: "R2", status: "todo", visualText: "", audioText: cup + "cd</span>", imageRef: null, updatedAt: "", updatedBy: null });
    for (const handle of handles) assert.deepEqual(projectSharedDocumentWithRecovery(handle), { document, recovery: [] });
    agree("split occurrence", order, handles, readPureMergedProjection);
  } finally { run.close(); }
});

test("seeded merged marks: 24 seeds, every mark kind, shuffled writers and duplicate/reverse delivery, no declared limits", t => {
  const kinds = ["b", "i", "u", "s", "hl", "dir", "cue"] as const, covered = new Set<string>();
  const declaredLimits: readonly string[] = [];
  let random = 0x6b1414, commands = 0, checkpoints = 0;
  for (let seed = 0; seed < 24; seed++) for (const writers of [2, 3]) for (const order of deliveryOrders) {
    const run = replicas(writers, { rows: [{ id: "R1", audioText: "abcd" }] });
    const handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])];
    try {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const scenario = cases[random % cases.length]; assert.ok(scenario);
      const marks = [...scenario.marks].sort((a, b) => (random & 1 ? a[0] - b[0] : b[0] - a[0]));
      marks.forEach(([from, to, mark], index) => {
        const handle = handles[(index + seed) % writers]; assert.ok(handle);
        add(handle, "seed" + index, from, to, mark as SharedStoredMarkValue); covered.add(mark.kind); commands++;
        if (order === "D2") run.queue.flush(order);
      });
      for (let index = 0; index < kinds.length; index++) {
        const kind = kinds[index], handle = handles[(index + seed) % writers]; assert.ok(handle && kind);
        const record = prepareSharedMarkRecord(handle, target, "format" + index, 0, 4, { type: "add", mark: { kind, value: true } });
        assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, target, "format" + index, record), { ok: true }); commands++; covered.add(kind);
        const removal = prepareSharedMarkRecord(handle, target, "clear" + index, 0, 4, { type: "remove", observed: [JSON.stringify([record.writer, record.operation])] });
        assert.ok(removal); assert.deepEqual(writeSharedMarkRecord(handle, target, "clear" + index, removal), { ok: true }); commands++; covered.add("remove");
        if (order === "D3") run.queue.flush(order);
      }
      run.queue.flush(order);
      const expected = { document: literalMergedDocument(scenario.html), recovery: scenario.recovery };
      for (const handle of handles) assert.deepEqual(projectSharedDocumentWithRecovery(handle), expected, "unmatched violation at seed " + seed);
      agree("seeded merged text " + seed, order, handles, readPureMergedProjection); checkpoints++;
    } finally { run.close(); }
  }
  assert.deepEqual(declaredLimits, []); assert.equal(checkpoints, 288); assert.ok(commands >= 4608);
  assert.deepEqual([...covered].sort(), ["b", "comment", "cue", "dir", "hl", "i", "link", "remove", "s", "tag", "u"]);
  t.diagnostic(JSON.stringify({ seeds: 24, commands, checkpoints, declaredLimits }));
});
