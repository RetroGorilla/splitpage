import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { ReplicaHarness } from "../../src/delivery.ts";
import { addComment, addReply, changeStatus, undoStatus } from "../../src/marks/commands.ts";
import { projectComments } from "../../src/marks/projection.ts";
import { fromDocument, createProjectionReplica } from "../../src/proj/document.ts";
import { structureManager } from "../../src/structure.ts";
import { statusReaders } from "./status-readers.ts";
import type { CollabModel } from "../../src/model.ts";

test("review finding: canonically equivalent reply ids retain replica-local order under localeCompare", () => {
  const h = new ReplicaHarness("B", [{ id: "R1", text: "" }]);
  try {
    addComment(h.alice, "C1", "R1", 0, 0, "Alice"); h.queue.flush("D2");
    addReply(h.alice, "\u00e9", "C1", "Alice", 0); addReply(h.bob, "e\u0301", "C1", "Bob", 0); h.queue.flush("rev");
    assert.equal("\u00e9".localeCompare("e\u0301"), 0);
    assert.deepEqual(Y.encodeStateAsUpdate(h.alice.doc), Y.encodeStateAsUpdate(h.bob.doc));
    h.lateJoin(h.alice);
    const observations = h.replicas.map(replica => {
      const model: CollabModel = { rows: [{ id: "R1", characters: [] }], carets: {}, recovery: [] };
      projectComments(model, replica.doc);
      const comments = model.records?.comments as Record<string, { replies: { id: string }[] }>;
      return comments.C1?.replies.map(reply => reply.id);
    });
    assert.deepEqual(observations, [["\u00e9", "e\u0301"], ["e\u0301", "\u00e9"], ["e\u0301", "\u00e9"]]);
  } finally { h.destroy(); }
});

for (const complete of [false, true]) test(`open Stage 2 question: authoring with ${complete ? "complete" : "partial"} status ancestry`, () => {
  const seed = fromDocument({ title: "", rows: [{ id: "R1", audioText: "", visualText: "", status: "todo" }] }, "B", 100);
  const replicas = [1, 2, 3, 4, 5].map(client => createProjectionReplica("B", client));
  const [x, p, a, c, late] = replicas; assert.ok(x && p && a && c && late);
  const managers = replicas.map(replica => structureManager(replica));
  const [mx, mp, ma, mc] = managers; assert.ok(mx && mp && ma && mc);
  const capture = (replica: typeof x, edit: () => void): Uint8Array => {
    const updates: Uint8Array[] = [], listener = (update: Uint8Array): void => { updates.push(update); };
    replica.doc.on("update", listener); try { edit(); } finally { replica.doc.off("update", listener); }
    assert.equal(updates.length, 1); const update = updates[0]; assert.ok(update); return update;
  };
  try {
    for (const replica of replicas) Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(seed.doc));
    const ux = capture(x, () => changeStatus(x, mx, "R1", "x", "ready", "X"));
    for (const replica of [p, a, c]) Y.applyUpdate(replica.doc, ux);
    const up = capture(p, () => changeStatus(p, mp, "R1", "p", "todo", "P")); Y.applyUpdate(a.doc, up);
    const ua = capture(a, () => changeStatus(a, ma, "R1", "a", "shot", "A")); Y.applyUpdate(c.doc, ua);
    assert.equal(c.doc.getMap("statusEvents").has("a"), true); assert.equal(c.doc.getMap("statusEvents").has("p"), false);
    if (complete) Y.applyUpdate(c.doc, up);
    changeStatus(c, mc, "R1", "c", "ready", "C");
    const event = c.doc.getMap<{ parents: string[] }>("statusEvents").get("c"); assert.ok(event);
    assert.deepEqual(event.parents, complete ? ["a"] : ["a", "x"]);
    Y.applyUpdate(c.doc, up); undoStatus(c, mc);
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(c.doc));
    for (const replica of [c, late]) for (const status of Object.values(statusReaders(replica))) assert.equal(status, complete ? "shot" : "todo");
  } finally { for (const manager of managers) manager.destroy(); for (const replica of replicas) replica.destroy(); seed.destroy(); }
});
