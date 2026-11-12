import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { IdentityBook, checkModel } from "../../collab/checker.ts";
import type { CollabModel, CollabRow } from "../../collab/checker.ts";
import { beatOracles } from "../../collab/oracles/structure-oracles.ts";

const structurePorts = { cells: createFlowLoadRuntime().cells };

for (const order of ["D1", "dup", "rev", "late-C"] as const) test(`Stage 1 T05 two splits retains literal identities and both carets: ${order}`, () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), book = new IdentityBook();
  try {
    const initial = (collabState(set.a).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
    for (let index = 0; index < 4; index++) { const id = Y.createRelativePositionFromTypeIndex(initial, index).item; assert.ok(id); book.bind("s" + (index + 1), id); }
    const anchors: string[] = [];
    for (const handle of [set.a, set.b]) {
      registerSharedSplitHandlers(handle, structurePorts);
      const split = operation({ kind: "split", id: "enter", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" },
        at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [flowBaseReference("R1", "audioText", 0, 4)],
        beat: "new", boundary: "new", fields: {} });
      assert.deepEqual(executeSharedOperations(handle, [split], { base: readSharedRevision(handle) }), { ok: true });
      const anchor = createSharedAnchor(handle, "b:R1", 3, "before"); assert.ok(anchor); anchors.push(anchor);
    }
    set.queue.flush(order);
    agree("T05 literal", order, [set.a, set.b], handle => {
      const segment = collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>, text = segment.get("text") as Y.Text;
      const rows: CollabRow[] = [{ id: "R1", characters: [] }], positions: { beat: string; offset: number }[] = [{ beat: "R1", offset: 0 }];
      let offset = 0;
      for (const delta of text.toDelta() as { insert: unknown }[]) {
        if (typeof delta.insert !== "string") {
          const writer = JSON.parse((delta.insert as { b: string }).b) as string[];
          rows.push({ id: writer[1] === "1" ? "Ra" : "Rb", characters: [] }); offset++;
          positions.push({ beat: rows.at(-1)?.id ?? "", offset: 0 }); continue;
        }
        for (const value of delta.insert.split("")) {
          const row = rows.at(-1), identity = Y.createRelativePositionFromTypeIndex(text, offset++).item; assert.ok(row && identity);
          row.characters.push({ identity: { client: identity.client, clock: identity.clock }, notation: book.notation(identity), value, marks: {}, beat: row.id }); positions.push({ beat: row.id, offset: row.characters.length });
        }
      }
      const carets = Object.fromEntries(anchors.map((anchor, index) => { const resolved = resolveSharedAnchor(handle, anchor); assert.notEqual(resolved, "gone");
        const position = resolved !== "gone" ? positions[resolved.offset] : undefined; assert.ok(position); return [index ? "B" : "A", position]; }));
      const model: CollabModel = { rows, carets, recovery: [] }, oracle = beatOracles["T05 two splits"]; assert.ok(oracle);
      checkModel(model, oracle, book, "T05"); return model;
    });
  } finally { set.close(); }
});
