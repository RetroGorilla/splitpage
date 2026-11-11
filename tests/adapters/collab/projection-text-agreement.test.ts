import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryOrders } from "../../collab/delivery.ts";
import { agree, execute, ref } from "./executor-support.ts";
import { createRecord, deleteRecord, recordReplicas } from "./record-support.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedStatusHeads } from "../../../src/adapters/collab/status.ts";
import type { SharedTextAddress } from "../../../src/core/collab/operations.ts";

for (const writers of [2, 3]) for (const order of deliveryOrders) test(`full projection mixed text/scalar/status/record history: ${writers} writers ${order}`, () => {
  const run = recordReplicas(writers), handles = [run.a, run.b, ...(writers === 3 ? [run.c] : [])];
  for (const handle of handles) registerSharedTextOperationHandlers(handle);
  const covered = new Set<string>(); let random = 0x6a1414, commands = 0, checkpoints = 0;
  const deliver = () => { if (order === "D2") run.queue.flush(order); };
  const checkpoint = (round: number, restored: boolean) => {
    run.queue.flush(order); agree("mixed full document " + checkpoints++, order, handles, projectSharedDocument);
    for (const handle of handles) {
      const doc = projectSharedDocument(handle);
      assert.equal(doc.rows[0]?.lengthSeconds, 12 + round); assert.equal(doc.rows[0]?.status, "ready");
      if (restored) {
        assert.equal(doc.title, "Title"); assert.equal(doc.rows[0]?.audioText, "abZ"); assert.equal(doc.rows[0]?.visualText, "");
        assert.deepEqual(doc.sections, [{ id: "H1", name: "Scene", firstSceneId: "R1" }]); assert.deepEqual(doc.people, []);
      }
    }
  };
  try {
    for (let round = 0; round < 4; round++) {
      const deletions: { writer: number; target: SharedTextAddress; observed: string; id: string }[] = [];
      handles.forEach((handle, writer) => {
        for (const field of ["title", "heading", "audioText", "visualText"] as const) {
          const owner = field === "title" ? String(collabState(handle).roots.meta.get("docId")) : field === "heading" ? "H1" : "R1";
          const target = { owner: ref(owner), segment: ref(field === "audioText" ? "b:R1" : field === "heading" ? "h:H1" : owner), field };
          const anchor = createSharedAnchor(handle, target, 0, "after"); assert.ok(anchor);
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          const id = `${round}-${writer}-${field}`, value = String.fromCharCode(65 + random % 26);
          execute(handle, { kind: "text-insert", id: "insert" + id, by: "Writer", target, at: { left: null, right: anchor, affinity: "before" }, content: [{ value, marks: [{ kind: writer % 2 ? "i" : "b", value: true }] }] });
          const observed = captureSharedTextRange(handle, target, 0, 1); assert.ok(observed);
          deletions.push({ writer, target, observed, id }); commands++; covered.add("insert:" + field); deliver();
        }
        execute(handle, { kind: "scalar", id: `length${round}-${writer}`, by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 12 + round },
          { kind: "status", id: `status${round}-${writer}`, by: "Writer", target: { scope: "beat", record: "R1" }, value: "ready", parents: readSharedStatusHeads(handle, { scope: "beat", record: ref("R1") }) },
          createRecord("people", `P${round}-${writer}`, { name: "Person" + writer }, "Writer"));
        commands += 3; deliver(); if (order === "D3") run.queue.flush(order);
      });
      checkpoint(round, false);
      for (const deletion of deletions) {
        const handle = handles[deletion.writer]; assert.ok(handle);
        execute(handle, { kind: "text-delete", id: "delete" + deletion.id, by: "Writer", target: deletion.target, observed: [deletion.observed] });
        commands++; covered.add("delete:" + deletion.target.field); deliver();
      }
      handles.forEach((handle, writer) => { execute(handle, deleteRecord("people", `P${round}-${writer}`, "Writer")); commands++; deliver(); });
      checkpoint(round, true);
    }
    assert.equal(checkpoints, 8); assert.equal(commands, writers * 48);
    assert.deepEqual([...covered].sort(), ["delete:audioText", "delete:heading", "delete:title", "delete:visualText", "insert:audioText", "insert:heading", "insert:title", "insert:visualText"]);
  } finally { run.close(); }
});

test("full projection reads every inserted inline atom through encoded delivery", () => {
  const run = recordReplicas();
  try {
    registerSharedTextOperationHandlers(run.a);
    const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const at = createSharedAnchor(run.a, target, 0, "after"); assert.ok(at);
    execute(run.a, { kind: "text-insert", id: "all-atoms", by: "Writer", target, at: { left: null, right: at, affinity: "before" }, content: [
      { value: { atom: "broll", id: "S1" }, marks: [] }, { value: { atom: "who", name: "Ada" }, marks: [] },
      { value: { atom: "image", ref: { sha256: "a".repeat(64) } }, marks: [] },
      { value: { atom: "video", href: "https://example.test/clip", host: "Host" }, marks: [] }
    ] });
    run.queue.flush("dup"); agree("all inserted atoms", "dup", [run.a, run.b], projectSharedDocument);
    assert.equal(projectSharedDocument(run.a).rows[0]?.audioText, '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span><span class="who-anchor" data-who="Ada" contenteditable="false">@Ada</span><img class="comment-img" data-blob="' + "a".repeat(64) + '"><a class="video-embed-card" href="https://example.test/clip" target="_blank" rel="noopener"><span class="vec-play">▶</span><span>Watch video</span><span class="vec-host">· Host</span></a>abZ');
  } finally { run.close(); }
});
