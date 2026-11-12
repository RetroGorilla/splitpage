import { structureIdentityFixture } from "../../collab/structure-identity.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type * as Y from "yjs";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { startParagraph, startBeat, selectionToOwnBeat, beatPos, enterInHeading, headingPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowPorts } from "../../../src/core/flow/flow.ts";
import { explode } from "../../../src/core/text/edits.ts";

const structurePorts = { cells: createFlowLoadRuntime().cells };

function readRows(handle: Parameters<typeof collabState>[0], aliases: ReadonlyMap<string, string>) {
  const { roots } = collabState(handle), rows: { id: string; text: string }[] = [];
  for (const segmentId of roots.order.toArray()) {
    const segment = roots.segments.get(segmentId) as Y.Map<unknown>, head = segment.get("head") as { b?: string; h?: string }, owner = head.b ?? head.h; assert.ok(owner);
    let row = { id: aliases.get(owner) ?? owner, text: "" }; rows.push(row);
    for (const delta of (segment.get("text") as Y.Text).toDelta() as { insert: unknown }[]) {
      if (typeof delta.insert === "string") row.text += delta.insert;
      else {
        const marker = delta.insert as { b?: string; before?: string };
        if (!marker.b) { row.text += "\ufffc"; continue; }
        if (marker.before) row.id = aliases.get(marker.b) ?? marker.b;
        row = { id: aliases.get(marker.before ?? marker.b) ?? marker.before ?? marker.b, text: "" }; rows.push(row);
      }
    }
  }
  return rows;
}

test("split vocabulary agrees with the flow applier for complete emitted split lists", t => {
  const rt = createFlowLoadRuntime();
  let seed = 0x5c, executed = 0, calls = 0, splits = 0, beforeSplits = 0, creates = 0;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let sample = 0; sample < 180; sample++) {
    const text = ["abcd", "A😀B", "<i>abc</i> def", "", "first<br>second"][random(5)] as string;
    const source = validatedFixture({ rows: [{ id: "R1", audioText: text }] }), doc: FlowDoc = { rows: source.rows, comments: [] };
    const length = explode(rt.cells(source.rows[0]?.audioText)).length, offset = random(length + 1);
    for (const kind of ["paragraph", "beat", "isolate"] as const) {
      let next = 0;
      const ports: FlowPorts = { ...rt.ports, newId: () => "fresh" + ++next, operations: { id: "flow", by: "Writer" } };
      const outcome = kind === "paragraph" ? startParagraph(doc, beatPos("R1", offset), ports) : kind === "beat" ? startBeat(doc, beatPos("R1", offset), ports)
        : selectionToOwnBeat(doc, { anchor: beatPos("R1", 0), head: beatPos("R1", Math.max(1, offset)) }, ports);
      calls++;
      if (!outcome || !("rows" in outcome)) continue;
      const ops = outcome.ops ?? [], handle = createMonitoredSharedDocument(), aliases = new Map<string, string>();
      try {
        collabState(handle).doc.clientID = 101; hydrateSharedDocument(handle, source);
        registerSharedSplitHandlers(handle, structurePorts); registerSharedTextOperationHandlers(handle);
        for (const op of ops) if (op.kind === "split" || op.kind === "split-before" || op.kind === "segment-create") {
          aliases.set(structureIdentityFixture("101", op.id, "beat"), op.beat);
          if (op.kind === "split") splits++; else if (op.kind === "split-before") beforeSplits++; else creates++;
        }
        assert.deepEqual(executeSharedOperations(handle, ops, { base: readSharedRevision(handle) }), { ok: true }, `${sample}/${kind}/${JSON.stringify(ops)}`);
        const expected = applyFlowOperations(doc, ops, rt.cells);
        assert.deepEqual(readRows(handle, aliases), expected.rows.map(row => ({ id: row.id, text: explode(rt.cells(row.audioText as string)).map(char => char.atom ? "\ufffc" : char.ch).join("") })), `${sample}/${kind}`);
        executed += ops.length;
      } finally { destroySharedDocument(handle); }
    }
  }
  assert.deepEqual({ calls, executed, splits, beforeSplits, creates }, { calls: 540, executed: 481, splits: 216, beforeSplits: 162, creates: 63 });
  t.diagnostic(JSON.stringify({ calls, executed, splits, beforeSplits, creates, skipped: 0, deferred: 0, limits: [] }));
});

test("a heading split retains its native characters and accepts its following anchor repair", () => {
  const rt = createFlowLoadRuntime(), handle = createMonitoredSharedDocument();
  try {
    const source = validatedFixture({ rows: [{ id: "R1", audioText: "Body" }], sections: [{ id: "H1", name: "ABCD", firstSceneId: "R1" }] });
    const doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: [] };
    const outcome = enterInHeading(doc, headingPos("H1", 2), { ...rt.ports, newId: () => "fresh", operations: { id: "heading", by: "Writer" } });
    assert.ok(outcome && "rows" in outcome && outcome.ops);
    collabState(handle).doc.clientID = 101; hydrateSharedDocument(handle, source); registerSharedSplitHandlers(handle, structurePorts);
    assert.deepEqual(executeSharedOperations(handle, outcome.ops, { base: readSharedRevision(handle) }), { ok: true });
    const id = structureIdentityFixture("101", "heading_o_0", "beat"), expected = applyFlowOperations(doc, outcome.ops, rt.cells);
    assert.deepEqual(readRows(handle, new Map([[id, "fresh"]])), [{ id: "H1", text: expected.sections?.[0]?.name }, ...expected.rows.map(row => ({ id: row.id, text: row.audioText }))]);
    assert.equal((collabState(handle).roots.headings.get("H1") as Y.Map<unknown>).get("firstSceneId"), id);
  } finally { destroySharedDocument(handle); }
});
