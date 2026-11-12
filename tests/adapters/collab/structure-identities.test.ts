import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { sharedStructureIdentity } from "../../../src/adapters/collab/structure-identity.ts";
import { observeSharedStructureIdentities } from "../../../src/adapters/collab/structure-reservations.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedMarkRecord } from "../../../src/adapters/collab/mark-record.ts";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { readProjectionBlocks } from "../../../src/adapters/collab/projection-reader.ts";
import { readProjectionUnits } from "../../../src/adapters/collab/projection-text-reader.ts";
import { cleanId, safeId } from "../../../src/core/document/text-policy.ts";
import { normalizeScenes } from "../../../src/core/document/scenes.ts";
import { ensureTagIds } from "../../../src/core/document/tags.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { insertBeats, typeWithMarks, beatPos } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { deliveryReplica } from "./helpers.ts";
import { expectedStructureIdentity } from "../../collab/structure-identity.ts";

const runtime = createFlowLoadRuntime(), ports = { cells: runtime.cells };
const beat = "structure_1_0065006e007400650072_beat_0", segment = "structure_1_0065006e007400650072_segment_0";
const visual = "structure_1_0065006e007400650072_visual_0", gallery = "structure_1_0065006e007400650072_gallery_0";
const secondGallery = "structure_1_0065006e007400650072_gallery_1";
const source = { rows: [{ id: "R1", audioText: "abcd" }] };
const create = (id = "enter") => operation({ kind: "segment-create", id, by: "Writer", beat: "new", segment: "new",
  at: { left: "R1", right: null, affinity: "after" }, fields: { audioText: "<em>P</em>", visualText: '<strong><a href="https://example.com">V</a></strong>',
    imageRef: { sha256: "a".repeat(64) }, moreImages: [{ imageRef: { sha256: "b".repeat(64) } }] } });

test("literal created keys, native record projections and every ordinary load-id path retain their identities", () => {
  const set = replicas(2, source);
  try {
    registerSharedSplitHandlers(set.a, ports);
    assert.deepEqual(executeSharedOperations(set.a, [create()], { base: readSharedRevision(set.a) }), { ok: true });
    const keys = [["beats", beat], ["segments", segment], ["visuals", visual], ["gallery", gallery], ["gallery", secondGallery]] as const;
    for (const [root, key] of keys) {
      assert.ok(collabState(set.a).roots[root].has(key)); assert.equal(cleanId(key), key);
      assert.equal(safeId(key, "unused", { id: () => { throw new Error("ID was rewritten"); } }), key);
      assert.equal(normalizeScenes([{ id: key, name: "Scene", firstSceneId: key }])?.[0]?.id, key);
      const loaded = runtime.load({ schema: 2, rows: [{ id: key, audioText: '<span class="cmt-anchor" data-cmt="' + key + '">A</span>', visualText: '<span class="broll-key" data-broll-id="' + key + '" contenteditable="false">B-roll:</span> Shot' }],
        sections: [{ id: key, name: "Scene", firstSceneId: key }], comments: [{ id: key, rowId: key, anchorId: key, field: "audioText", body: "Comment", replies: [{ id: key, body: "Reply" }] }],
        people: [{ id: key, name: "Person" }], brollShots: [{ id: key, name: "Shot", origin: "list" }], productionTags: [{ id: "t_seed", cat: "prop", name: "Cup" }] });
      const shots = loaded.brollShots, sections = loaded.sections; assert.ok(Array.isArray(shots) && Array.isArray(sections));
      assert.deepEqual([loaded.rows[0]?.id, loaded.comments[0]?.id, loaded.comments[0]?.rowId, loaded.comments[0]?.anchorId,
        loaded.comments[0]?.replies?.[0]?.id, loaded.people[0]?.id, shots[0]?.id, sections[0]?.id, sections[0]?.firstSceneId], Array(9).fill(key));
      assert.ok(loaded.rows[0]?.audioText?.includes('data-cmt="' + key + '"')); assert.ok(loaded.rows[0]?.visualText?.includes('data-broll-id="' + key + '"'));
      assert.equal(loaded.productionTags?.[0]?.id, "t_seed");
    }
    assert.deepEqual(readSharedRecords(set.a, "visuals").map(record => record.key).filter(key => key.startsWith("structure_")), [visual]);
    assert.deepEqual(readSharedRecords(set.a, "gallery").map(record => record.key).filter(key => key.startsWith("structure_")), [gallery, secondGallery]);
    const roots = collabState(set.a).roots;
    const blocks = readProjectionBlocks(roots.order, roots.segments, roots.beats, value => readProjectionUnits(set.a, value.get("text"), value.get("markRecords")));
    assert.deepEqual(blocks.filter(block => block.id === beat).map(block => ({ id: block.id, segment: block.segment })), [{ id: beat, segment }]);
    const projected = projectSharedDocument(set.a), loaded = runtime.load(projected);
    assert.deepEqual(projected.rows.map(row => row.id), ["R1", beat]); assert.deepEqual(loaded.rows.map(row => row.id), ["R1", beat]);
    registerSharedTextOperationHandlers(set.a);
    const edit = typeWithMarks({ rows: loaded.rows, comments: [] }, beatPos(beat, 0), "X", {}, { ...runtime.ports, operations: { id: "afterLoad", by: "Writer" } });
    assert.ok(edit && "ops" in edit && edit.ops);
    assert.deepEqual(executeSharedOperations(set.a, edit.ops, { base: readSharedRevision(set.a) }), { ok: true });
    assert.equal(projectSharedDocument(set.a).rows[1]?.audioText, "X<em>P</em>");
    const text = collabState(set.a).roots.visuals.get(visual) as Y.Map<unknown>;
    const occurrences = [...(text.get("markRecords") as Y.Map<unknown>)].flatMap(([key, value]) => {
      const record = readSharedMarkRecord(key, value); return record?.type === "add" && "id" in record.mark ? [JSON.parse(record.mark.id) as unknown] : [];
    });
    assert.deepEqual(occurrences, [["mark-occurrence", "1", '["initial","enter","visualText"]', 0, 1]]);
    set.queue.flush("rev"); agree("literal ID round trip", "rev", [set.a, set.b], handle => {
      const document = projectSharedDocument(handle); return { projected: document.rows.map(row => row.id), loaded: runtime.load(document).rows.map(row => row.id) };
    }, { projected: ["R1", beat], loaded: ["R1", beat] });
  } finally { set.close(); }
});

test("seeded raw tuples remain distinct after real app validation, with separators escaped and invalid operations refused", t => {
  let seed = 0x1462, checked = 0, refused = 0;
  const ids = new Map<string, string>(), roles = ["beat", "segment", "visual", "gallery"] as const;
  const operations = ["enter", "_", "__", "a_b", "a__b", "1x", "x", "11x", "enter_o_0", "a-2", "A", "a"];
  const invalid = ["", "a:b", "a.b", "a b", "a/b", "a\u005cb", "\u00e9", "\ufffd", "\ud800"], covered = new Set<string>(), rejected = new Set<string>();
  for (let sample = 0; sample < 128; sample++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    for (const writer of ["0", "1", "11", "111", "4294967295"]) for (const role of roles) for (const slot of [0, 1, 13]) {
      const operation = operations[seed % operations.length] + "_" + sample;
      const bad = invalid[(seed >>> 8) % invalid.length] as string;
      covered.add(operations[seed % operations.length] as string); rejected.add(bad);
      assert.throws(() => sharedStructureIdentity(writer, bad, role, slot), { message: "invalid-structure-operation-id" }); refused++;
      const id = sharedStructureIdentity(writer, operation, role, slot), tuple = JSON.stringify([writer, operation, role, slot]);
      assert.ok(!ids.has(id), "Distinct tuples share an identity"); ids.set(id, tuple);
      assert.equal(cleanId(id), id); assert.equal(Buffer.from(id).toString(), id); assert.ok(!id.includes("\ufffd"));
      const parts = id.split("_"); assert.equal(parts.length, 5);
      const raw = (parts[2]?.match(/.{4}/g) ?? []).map(part => String.fromCharCode(Number.parseInt(part, 16))).join("");
      assert.deepEqual([parts[1], raw, parts[3], Number(parts[4])], [writer, operation, role, slot]); checked++;
    }
  }
  assert.equal(checked, 7680); assert.equal(ids.size, 7680); assert.equal(refused, 7680); assert.equal(covered.size, 12); assert.equal(rejected.size, 9);
  const input = [...ids.keys()], loaded = runtime.load({ schema: 2, rows: input.map(id => ({ id, audioText: "" })) });
  assert.deepEqual(loaded.rows.map(row => row.id), input);
  assert.deepEqual([sharedStructureIdentity("1", "1x", "beat"), sharedStructureIdentity("11", "x", "beat")],
    ["structure_1_00310078_beat_0", "structure_11_0078_beat_0"]);
  for (const operation of invalid) {
    assert.throws(() => sharedStructureIdentity("1", operation, "beat"), { message: "invalid-structure-operation-id" });
  }
  const tags = [{ id: "t_seed", cat: "prop", name: "Cup" }]; ensureTagIds(tags); assert.equal(tags[0]?.id, "t_seed");
  t.diagnostic(JSON.stringify({ tuples: checked, loaded: loaded.rows.length, refused, invalidOperations: 9, limits: [] }));
});

test("cleaned stored identities reserve every creation role before and after registration and on an encoded join", () => {
  for (const role of ["beat", "segment", "visual", "gallery"] as const) for (const root of ["beats", "segments", "headings", "visuals", "gallery", "comments", "replies", "people", "tags", "shots"] as const) {
    const set = replicas(2, source), id = expectedStructureIdentity("1", "enter", role), raw = "[" + id + "]";
    try {
      registerSharedSplitHandlers(set.a, ports);
      transactSharedDocument(set.a, "local-command", () => {
        const roots = collabState(set.a).roots, record = new Y.Map<unknown>(); record.set("id", raw);
        if (root === "people") record.set("name", "Reserved");
        if (root === "beats") {
          record.set("segment", "reserved-segment");
          const container = new Y.Map<unknown>(); container.set("head", { b: raw }); container.set("text", new Y.Text("Reserved")); container.set("markRecords", new Y.Map<unknown>());
          roots.segments.set("reserved-segment", container); roots.order.push(["reserved-segment"]);
        }
        roots[root].set(raw, record);
      });
      if (root === "beats") {
        const projected = projectSharedDocument(set.a); assert.ok(projected.rows.some(row => row.id === raw));
        assert.ok(runtime.load(projected).rows.some(row => row.id === id));
      }
      set.queue.flush("D1"); registerSharedSplitHandlers(set.b, ports);
      const before = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a); let delivered = 0;
      const stop = deliveryReplica(set.a).onLocalUpdate(() => { delivered++; });
      assert.deepEqual(executeSharedOperations(set.a, [create()], { base: revision }), { ok: false, reason: "existing-identity", index: 0, operation: create() });
      assert.deepEqual(encodeSharedState(set.a), before); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision); assert.equal(delivered, 0); stop();
      agree("cleaned stored reservation " + root + role, "D1", [set.a, set.b], handle => observeSharedStructureIdentities(handle).has(id), true);
      transactSharedDocument(set.a, "local-command", () => { collabState(set.a).roots[root].delete(raw); });
      assert.equal(observeSharedStructureIdentities(set.a).has(id), false);
    } finally { set.close(); }
  }
});

test("same-list record reservations and invalid operation IDs refuse the entire list in either order", () => {
  const set = replicas(2, source);
  try {
    registerSharedSplitHandlers(set.a, ports); registerSharedRecordHandlers(set.a); registerSharedTextOperationHandlers(set.a);
    const record = operation({ kind: "record-create", id: "record", by: "Writer", target: { collection: "people", record: "[" + beat + "]" }, fields: { name: "Reserved" } });
    const reply = operation({ kind: "record-create", id: "reply", by: "Writer", target: { collection: "replies", record: JSON.stringify(["comment", "[" + beat + "]"]) },
      fields: { id: "[" + beat + "]", commentId: "comment" } });
    const atom = operation({ kind: "text-insert", id: "atom", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" },
      at: { left: null, right: flowBaseReference("R1", "audioText", 0), affinity: "before" }, content: [{ value: { atom: "broll", id: "[" + beat + "]", text: "B-roll:" }, marks: [] }] });
    const lists = [[record, create()], [create(), record], [reply, create()], [create(), reply], [atom, create()], [create(), atom], ...["enter:0", "a.b", "a b", "a/b"].map(id => [record, create(id)])];
    const before = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a); let delivered = 0;
    const stop = deliveryReplica(set.a).onLocalUpdate(() => { delivered++; });
    for (const [index, commands] of lists.entries()) {
      assert.deepEqual(executeSharedOperations(set.a, commands, { base: revision }), { ok: false, reason: index < 6 ? "existing-identity" : "invalid-structure-operation-id", index: 1, operation: commands[1] });
      assert.deepEqual(encodeSharedState(set.a), before); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision); assert.equal(delivered, 0);
    }
    stop();
  } finally { set.close(); }
});

test("reservations follow reply id fields and dangling order identities without retaining deleted names", () => {
  const set = replicas(2, source);
  try {
    const index = observeSharedStructureIdentities(set.a), raw = "[" + beat + "]";
    transactSharedDocument(set.a, "local-command", () => {
      const reply = new Y.Map<unknown>(); reply.set("id", raw); collabState(set.a).roots.replies.set("reply-key", reply);
    });
    assert.equal(index.has(beat), true);
    transactSharedDocument(set.a, "local-command", () => { (collabState(set.a).roots.replies.get("reply-key") as Y.Map<unknown>).set("id", "other"); });
    assert.equal(index.has(beat), false);
    transactSharedDocument(set.a, "local-command", () => { collabState(set.a).roots.order.push([raw]); });
    set.queue.flush("rev"); agree("dangling reservation", "rev", [set.a, set.b], handle => observeSharedStructureIdentities(handle).has(beat), true);
    transactSharedDocument(set.a, "local-command", () => { collabState(set.a).roots.order.delete(1, 1); });
    assert.equal(index.has(beat), false);
    const text = (collabState(set.a).roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
    transactSharedDocument(set.a, "local-command", () => { text.insertEmbed(0, { k: raw, label: "B-roll:" }); });
    set.queue.flush("dup"); agree("inline b-roll ID reservation", "dup", [set.a, set.b], handle => observeSharedStructureIdentities(handle).has(beat), true);
    transactSharedDocument(set.a, "local-command", () => { text.delete(0, 1); });
    assert.equal(index.has(beat), false);
  } finally { set.close(); }
});

test("split, prefix, blank and rich paste IDs survive projection and app load on every copy", t => {
  let histories = 0;
  for (const kind of ["split", "split-before", "blank", "paste"] as const) for (const writers of [2, 3]) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
    const set = replicas(writers, source), handles = [set.a, set.b, set.c].slice(0, writers), operationId = kind === "paste" ? "paste_o_0" : "enter";
    try {
      for (const handle of handles) {
        registerSharedSplitHandlers(handle, ports); registerSharedTextOperationHandlers(handle); registerSharedRecordHandlers(handle);
        let commands;
        if (kind === "paste") {
          const out = insertBeats({ ...source, comments: [] }, beatPos("R1", 4), [{ id: "pasted", audioText: "<em>P</em>", visualText: "<strong>V</strong>", imageRef: { sha256: "a".repeat(64) } }],
            { ...runtime.ports, operations: { id: "paste", by: "Writer" } });
          assert.ok(out && "ops" in out && out.ops); commands = out.ops;
        } else if (kind === "blank") commands = [operation({ kind: "segment-create", id: "enter", by: "Writer", beat: "new", segment: "new", at: { left: "R1", right: null, affinity: "after" }, fields: {} })];
        else commands = [operation({ kind, id: "enter", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" },
          at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [], beat: "new", boundary: "new", fields: {} })];
        assert.deepEqual(executeSharedOperations(handle, commands, { base: readSharedRevision(handle) }), { ok: true });
      }
      const expected = ["R1", ...handles.map((_, index) => expectedStructureIdentity(String(index + 1), operationId, "beat"))].sort();
      set.queue.flush(order); agree("validated creation IDs " + kind, order, handles, handle => {
        const projected = projectSharedDocument(handle), loaded = runtime.load(projected);
        for (const root of ["beats", "segments", "visuals", "gallery"] as const) for (const key of collabState(handle).roots[root].keys()) if (key.startsWith("structure_")) assert.equal(cleanId(key), key);
        return { projected: projected.rows.map(row => row.id).sort(), loaded: loaded.rows.map(row => row.id).sort() };
      }, { projected: expected, loaded: expected }); histories++;
    } finally { set.close(); }
  }
  assert.equal(histories, 32); t.diagnostic(JSON.stringify({ histories, kinds: ["split", "split-before", "blank", "paste"], limits: [] }));
});
