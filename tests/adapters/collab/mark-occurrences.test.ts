import test from "node:test";
import assert from "node:assert/strict";
import { FlowOperationTrace } from "../../../src/core/flow/operations.ts";
import { setMark, addComment, implode } from "../../../src/core/text/edits.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { Marks } from "../../../src/core/text/runs.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { samePayloadMarkCases, samePayloadTextFields, sharedTagNameCases, sharedTagNameLimit } from "../../core/flow/mark-occurrence-cases.ts";
import { replicas, agree, ref, operation } from "./executor-support.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { sharedTextLocation } from "../../../src/adapters/collab/executor-text-plan.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { SharedTextAddress } from "../../../src/core/collab/operations.ts";

function read(handle: SharedDocumentHandle, field: "audioText" | "visualText", kind: "tag" | "link" | "comment") {
  const prep = createSharedPreparation(handle);
  try {
    const located = sharedTextLocation(prep.view, { owner: ref("R1"), segment: ref("R1"), field }), text = prep.view.text(located.path); assert.ok(text);
    const counts: number[] = [], chars = text.units.map(unit => {
      assert.ok(unit.marks.every(group => group.kind === kind));
      const marks: Marks = {}, names = [...new Set(unit.marks.filter(group => group.kind === kind).flatMap(group => group.values.map(String)))].sort();
      counts.push(names.length); assert.ok(names.length <= 1);
      const name = names[0];
      if (name !== undefined) { if (kind === "tag") marks.tag = name; else if (kind === "link") marks.href = name; else marks.cmt = [name]; }
      assert.equal(typeof unit.value, "string"); return { ch: String(unit.value), marks };
    });
    return { counts, html: toHtml(implode(chars)) };
  } finally { prep.close(); }
}

for (const fixture of samePayloadMarkCases.filter(item => item.kind !== "tag")) for (const { field, edges } of samePayloadTextFields) test(`shared same-payload ${fixture.kind} name equals standalone in ${field}`, () => {
  const rt = createFlowLoadRuntime(), cell = rt.cells(fixture.base), next = fixture.kind === "comment" ? addComment(cell, 0, 4, "C") : setMark(cell, 0, 4, "href", fixture.mark.value);
  assert.equal(toHtml(next), fixture.html);
  for (const order of deliveryOrders) {
    const h = replicas(2, { title: "Title", rows: [{ id: "R1", [field]: fixture.base }] });
    try {
      registerSharedTextOperationHandlers(h.a);
      const command = operation({ kind: "mark", id: "mark", by: "Writer", target: { owner: "R1", segment: "R1", field }, observed: edges, mark: fixture.mark });
      assert.deepEqual(executeSharedOperations(h.a, [command], { base: readSharedRevision(h.a) }), { ok: true });
      h.queue.flush(order); agree(fixture.kind + "/" + field, order, [h.a, h.b], handle => read(handle, field, fixture.kind), { counts: [...fixture.standaloneCounts], html: fixture.html });
    } finally { h.close(); }
  }
});

test("shared tag names match exactly the declared standalone stacking limit", t => {
  const rt = createFlowLoadRuntime(); let cases = 0;
  for (const fixture of sharedTagNameCases) {
    const field = samePayloadTextFields.find(item => item.field === fixture.field); assert.ok(field);
    const added = setMark(rt.cells(fixture.base), 0, 4, "tag", "t:prop:Box"), cleared = setMark(added, 0, 4, "tag", false);
    assert.equal(toHtml(added), fixture.standaloneAdded); assert.equal(toHtml(cleared), fixture.standaloneCleared);
    assert.notEqual(fixture.standaloneAdded, fixture.sharedAdded); assert.notEqual(fixture.standaloneCleared, fixture.sharedCleared);
    const sharedClear = new FlowOperationTrace({ rows: [{ id: "R1", audioText: fixture.sharedAdded }] }, rt.ports, { id: "clear", by: "Writer" });
    sharedClear.marks("R1", rt.cells(fixture.sharedAdded), 0, 4, setMark(rt.cells(fixture.sharedAdded), 0, 4, "tag", false), "tag", false);
    assert.deepEqual(sharedClear.ops, [{ kind: "mark", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: samePayloadTextFields[0].all,
      mark: { kind: "tag", id: "t:prop:Box", value: null }, id: "clear:0", by: "Writer" }]);
    for (const order of deliveryOrders) {
      const h = replicas(2, { title: "Title", rows: [{ id: "R1", [fixture.field]: fixture.base }] });
      const doubled = replicas(2, { title: "Title", rows: [{ id: "R1", [fixture.field]: fixture.standaloneAdded }] });
      try {
        agree("doubled tag hydration", order, [doubled.a, doubled.b], handle => read(handle, fixture.field, "tag"), { counts: [1, 1, 1, 1], html: fixture.sharedAdded });
        registerSharedTextOperationHandlers(h.a);
        const target = { owner: "R1", segment: "R1", field: fixture.field };
        const command = operation({ kind: "mark", id: "add", by: "Writer", target, observed: field.edges, mark: { kind: "tag", id: "t:prop:Box", value: "t:prop:Box" } });
        assert.deepEqual(executeSharedOperations(h.a, [command], { base: readSharedRevision(h.a) }), { ok: true }); h.queue.flush(order);
        agree("same tag addition", order, [h.a, h.b], handle => read(handle, fixture.field, "tag"), { counts: [1, 1, 1, 1], html: fixture.sharedAdded });
        const clear = operation({ kind: "mark", id: "clear", by: "Writer", target, observed: field.all, mark: { kind: "tag", id: "t:prop:Box", value: null } });
        assert.deepEqual(executeSharedOperations(h.a, [clear], { base: readSharedRevision(h.a) }), { ok: true }); h.queue.flush(order);
        agree("same tag clear", order, [h.a, h.b], handle => read(handle, fixture.field, "tag"), { counts: [0, 0, 0, 0], html: fixture.sharedCleared });
        registerSharedTextOperationHandlers(doubled.a);
        assert.deepEqual(executeSharedOperations(doubled.a, [clear], { base: readSharedRevision(doubled.a) }), { ok: true }); doubled.queue.flush(order);
        agree("doubled tag clear", order, [doubled.a, doubled.b], handle => read(handle, fixture.field, "tag"), { counts: [0, 0, 0, 0], html: fixture.sharedCleared });
      } finally { h.close(); doubled.close(); }
    }
    cases += 2;
  }
  assert.equal(cases, 4); t.diagnostic(JSON.stringify({ limits: [{ description: sharedTagNameLimit, cases }] }));
});

test("the declared tag-name limit does not excuse an unrelated formatting difference", () => {
  const h = replicas(2, { title: "Title", rows: [{ id: "R1", audioText: '<em><span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">abcd</span></em>' }] });
  try { assert.throws(() => read(h.a, "audioText", "tag"), assert.AssertionError); } finally { h.close(); }
});

test("two simultaneous additions of one tag name read once and one clear removes both", () => {
  const target: SharedTextAddress = { owner: ref("R1"), segment: ref("R1"), field: "audioText" };
  for (const order of ["D1", "dup", "rev"] as const) {
    const h = replicas(3, { title: "Title", rows: [{ id: "R1", audioText: "abcd" }] });
    try {
      for (const handle of [h.a, h.b]) registerSharedTextOperationHandlers(handle);
      for (const [index, handle] of [h.a, h.b].entries()) {
        const observed = captureSharedTextRange(handle, target, 1, 3); assert.ok(observed);
        const add = operation({ kind: "mark", id: "add" + index, by: "Writer", target, observed: [observed], mark: { kind: "tag", id: "t:prop:Box", value: "t:prop:Box" } });
        assert.deepEqual(executeSharedOperations(handle, [add]), { ok: true });
      }
      h.queue.flush(order);
      agree("concurrent tag union", order, [h.a, h.b, h.c], handle => read(handle, "audioText", "tag"), { counts: [0, 1, 1, 0], html: samePayloadMarkCases[0].base });
      const observed = captureSharedTextRange(h.a, target, 0, 4); assert.ok(observed);
      const clear = operation({ kind: "mark", id: "clear", by: "Writer", target, observed: [observed], mark: { kind: "tag", id: "t:prop:Box", value: null } });
      assert.deepEqual(executeSharedOperations(h.a, [clear]), { ok: true }); h.queue.flush(order);
      agree("single tag clear", order, [h.a, h.b, h.c], handle => read(handle, "audioText", "tag"), { counts: [0, 0, 0, 0], html: "abcd" });
      const prep = createSharedPreparation(h.a), located = sharedTextLocation(prep.view, target), text = prep.view.text(located.path); assert.ok(text); prep.close();
      assert.equal(text.records.filter(record => record.record.type === "add").length, 2);
      assert.deepEqual(text.records.filter(record => record.record.type === "remove").map(record => record.record.type === "remove" ? record.record.observed.length : -1), [2]);
    } finally { h.close(); }
  }
});
