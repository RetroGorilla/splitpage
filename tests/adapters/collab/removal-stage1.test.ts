import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { IdentityBook, checkModel } from "../../collab/checker.ts";
import type { CollabModel, CollabRow } from "../../collab/checker.ts";
import { removedOracle, restorationOracle } from "../../collab/oracles/oracles.ts";

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`Stage 1 T10 removal against typing and restore retains identities: ${copies}/${order}`, () => {
  const set = replicas(copies, { rows: [{ id: "R1", audioText: "ab" }, { id: "R2", audioText: "cd" }, { id: "R3", audioText: "ef" }] });
  const handles = [set.a, set.b, set.c].slice(0, copies), book = new IdentityBook();
  const send = (handle: typeof set.a, op: unknown) => assert.deepEqual(executeSharedOperations(handle, [operation(op)], { base: readSharedRevision(handle) }), { ok: true });
  try {
    for (const handle of handles) { registerSharedRemovalHandlers(handle); registerSharedTextOperationHandlers(handle); }
    let number = 0;
    for (const beat of ["R1", "R2", "R3"]) {
      const text = (collabState(set.a).roots.segments.get("b:" + beat) as Y.Map<unknown>).get("text") as Y.Text;
      for (let offset = 0; offset < 2; offset++) { const id = Y.createRelativePositionFromTypeIndex(text, offset).item; assert.ok(id); book.bind("s" + ++number, id); }
    }
    const anchor = createSharedAnchor(set.a, "b:R2", 0, "before"); assert.ok(anchor);
    send(set.a, { kind: "remove", id: "a", by: "Alice", removalKind: "beat", targets: ["R2"], observed: [flowBaseReference("R2", "audioText", 0, 2)], boundaries: ["R2"], components: [], gallery: [], at: 1 });
    send(set.b, { kind: "text-insert", id: "typed", by: "Bob", target: { owner: "R2", segment: "b:R2", field: "audioText" },
      at: { left: null, right: flowBaseReference("R2", "audioText", 1), affinity: "before" }, content: [{ value: "X", marks: [] }] });
    const text = (collabState(set.b).roots.segments.get("b:R2") as Y.Map<unknown>).get("text") as Y.Text;
    const inserted = Y.createRelativePositionFromTypeIndex(text, 1).item; assert.ok(inserted); book.bind("b1", inserted);
    set.queue.flush(order);
    const read = (handle: typeof set.a, restored: boolean) => {
      const projected = projectSharedDocumentWithRecovery(handle), roots = collabState(handle).roots;
      const row = (id: string): CollabRow => {
        const native = (roots.segments.get("b:" + id) as Y.Map<unknown>).get("text") as Y.Text;
        return { id, characters: native.toString().split("").map((value, offset) => { const identity = Y.createRelativePositionFromTypeIndex(native, offset).item; assert.ok(identity);
          return { identity: { client: identity.client, clock: identity.clock }, notation: book.notation(identity), value, marks: {}, beat: id }; }) };
      };
      const resolved = resolveSharedAnchor(handle, anchor); assert.ok(resolved !== "gone");
      const storedOrder = roots.order.toArray(), source = (roots.segments.get(resolved.segment) as Y.Map<unknown>).get("head") as { b: string };
      const visible = new Set(projected.document.rows.map(row => row.id));
      const next = storedOrder.slice(storedOrder.indexOf(resolved.segment) + 1).map(segment => ((roots.segments.get(segment) as Y.Map<unknown>).get("head") as { b: string }).b).find(id => visible.has(id));
      const caret = visible.has(source.b) ? { beat: source.b, offset: resolved.offset } : { beat: next, offset: 0 }; assert.ok(typeof caret.beat === "string");
      const model: CollabModel = { rows: projected.document.rows.map(value => row(value.id)),
        carets: { A: { beat: caret.beat, offset: caret.offset } },
        recovery: projected.recovery.map(entry => { assert.ok(entry.kind === "removed-beat"); const recovered = row(String(entry.row.id));
          assert.equal(entry.row.audioText, recovered.characters.map(char => char.value).join(""));
          assert.ok(entry.removal); assert.deepEqual(entry.removal.ids, ["structure_1_0061_removal_0"]);
          return { row: recovered, by: entry.removal.by, edited: entry.removal.edited.map(identity => book.notation(identity)) }; }) };
      checkModel(model, restored ? restorationOracle : removedOracle, book, order); return model;
    };
    agree("T10 removed", order, handles, handle => read(handle, false));
    send(set.a, { kind: "restore", id: "back", by: "Alice", removals: ["structure_1_0061_removal_0"] }); set.queue.flush(order);
    agree("T10 restored", order, handles, handle => read(handle, true));
    assert.equal(collabState(set.a).roots.order.length, 3);
  } finally { set.close(); }
});
