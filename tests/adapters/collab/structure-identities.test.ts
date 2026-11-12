import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation } from "./executor-support.ts";
import { registerSharedSplitHandlers } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector, transactSharedDocument, applySharedUpdate, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { sharedStructureIdentity } from "../../../src/adapters/collab/structure-identity.ts";
import { observeSharedStructureIdentities } from "../../../src/adapters/collab/structure-reservations.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedMarkRecord } from "../../../src/adapters/collab/mark-record.ts";
import { projectSharedDocument, projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import { readProjectionBlocks } from "../../../src/adapters/collab/projection-reader.ts";
import { readProjectionUnits } from "../../../src/adapters/collab/projection-text-reader.ts";
import { cleanId, safeId } from "../../../src/core/document/text-policy.ts";
import { normalizeScenes } from "../../../src/core/document/scenes.ts";
import { ensureTagIds } from "../../../src/core/document/tags.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { insertBeats, typeWithMarks, beatPos } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { deliveryReplica, createMonitoredSharedDocument } from "./helpers.ts";
import { structureIdentityFixture } from "../../collab/structure-identity.ts";
import { visitSharedIdentityStructs } from "../../../src/adapters/collab/identity-structs.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";

const runtime = createFlowLoadRuntime(), ports = { cells: runtime.cells };
const beat = "structure_1_0065006e007400650072_beat_0", segment = "structure_1_0065006e007400650072_segment_0";
const visual = "structure_1_0065006e007400650072_visual_0", gallery = "structure_1_0065006e007400650072_gallery_0";
const secondGallery = "structure_1_0065006e007400650072_gallery_1";
const source = { rows: [{ id: "R1", audioText: "abcd" }] };
const declaredLimits = ["same cleaned beat id created at the same moment: the load renames the later beat and a command addressed to the id reaches the other one"] as const;
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
  t.diagnostic(JSON.stringify({ tuples: checked, loaded: loaded.rows.length, refused, invalidOperations: 9, scope: "identity tuples" }));
});

test("cleaned stored identities reserve every creation role before and after registration and on an encoded join", () => {
  for (const role of ["beat", "segment", "visual", "gallery"] as const) for (const root of ["beats", "segments", "headings", "visuals", "gallery", "comments", "replies", "people", "tags", "shots"] as const) {
    const set = replicas(2, source), id = structureIdentityFixture("1", "enter", role), raw = "[" + id + "]";
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
      const expected = ["R1", ...handles.map((_, index) => structureIdentityFixture(String(index + 1), operationId, "beat"))].sort();
      set.queue.flush(order); agree("validated creation IDs " + kind, order, handles, handle => {
        const projected = projectSharedDocument(handle), loaded = runtime.load(projected);
        for (const root of ["beats", "segments", "visuals", "gallery"] as const) for (const key of collabState(handle).roots[root].keys()) if (key.startsWith("structure_")) assert.equal(cleanId(key), key);
        return { projected: projected.rows.map(row => row.id).sort(), loaded: loaded.rows.map(row => row.id).sort() };
      }, { projected: expected, loaded: expected }); histories++;
    } finally { set.close(); }
  }
  assert.equal(histories, 32); t.diagnostic(JSON.stringify({ fixedMatrixHistories: histories, kinds: ["split", "split-before", "blank", "paste"] }));
});

function concurrentCleanedCollision(order: DeliveryOrder): string {
  const set = replicas(2, source), raw = "[structure_1_0065006e007400650072_beat_0]";
  try {
    registerSharedSplitHandlers(set.a, ports); registerSharedTextOperationHandlers(set.a);
    assert.deepEqual(executeSharedOperations(set.a, [operation({ ...create(), fields: { audioText: "Created" } })], { base: readSharedRevision(set.a) }), { ok: true });
    transactSharedDocument(set.b, "local-command", () => {
      const roots = collabState(set.b).roots, record = new Y.Map<unknown>(), container = new Y.Map<unknown>();
      record.set("id", raw); record.set("segment", "reserved-segment"); roots.beats.set(raw, record);
      container.set("head", { b: raw }); container.set("text", new Y.Text("Reserved")); container.set("markRecords", new Y.Map<unknown>());
      roots.segments.set("reserved-segment", container); roots.order.insert(0, ["reserved-segment"]);
    });
    set.queue.flush(order);
    const read = (handle: SharedDocumentHandle) => { const projection = projectSharedDocumentWithRecovery(handle); return {
      rows: projection.document.rows.map(row => ({ id: row.id, text: row.audioText })), loaded: runtime.load(projection.document).rows.map(row => ({ id: row.id, text: row.audioText })), recovery: projection.recovery }; };
    const rows = [{ id: raw, text: "Reserved" }, { id: "R1", text: "abcd" }, { id: beat, text: "Created" }];
    const loaded = [{ id: beat, text: "Reserved" }, { id: "R1", text: "abcd" }, { id: "structure_1_0065006e007400650072_beat_0-1", text: "Created" }];
    agree("declared cleaned-id collision before edit", order, [set.a, set.b], read, { rows, loaded, recovery: [] });
    const held = runtime.load(projectSharedDocument(set.a)), edit = typeWithMarks({ rows: held.rows, comments: [] }, beatPos(beat, 0), "!", {}, { ...runtime.ports, operations: { id: "held", by: "Writer" } });
    assert.ok(edit && "ops" in edit && edit.ops); assert.equal(edit.rows[0]?.audioText, "!Reserved");
    assert.deepEqual(executeSharedOperations(set.a, edit.ops, { base: readSharedRevision(set.a) }), { ok: true }); set.queue.flush(order);
    agree("declared cleaned-id collision edits the other beat", order, [set.a, set.b], read, {
      rows: [{ id: raw, text: "Reserved" }, { id: "R1", text: "abcd" }, { id: beat, text: "!Created" }],
      loaded: [{ id: beat, text: "Reserved" }, { id: "R1", text: "abcd" }, { id: "structure_1_0065006e007400650072_beat_0-1", text: "!Created" }], recovery: []
    });
    return declaredLimits[0];
  } finally { set.close(); }
}

test("declared limit: simultaneous cleaned beat identity collision renames the later beat and edits the other one", t => {
  const violations = new Set<string>();
  for (const order of ["D1", "dup", "rev", "late-C"] as const) violations.add(concurrentCleanedCollision(order));
  assert.deepEqual([...violations], declaredLimits); t.diagnostic(JSON.stringify({ histories: 4, declaredLimits, violations: [...violations] }));
});

test("seeded creation and native mutation checkpoints compare maintained reservations with encoded fresh indexes", t => {
  let seed = 0x14664, histories = 0, checkpoints = 0, copies = 0, deliveries = 0;
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const violations = new Set<string>(), covered = new Set<string>(), probes = new Set([beat, segment, visual, gallery, "probeA", "probeB", "probeAtom"]);
  const checkpoint = (handles: readonly SharedDocumentHandle[]) => {
    checkpoints++;
    for (const handle of handles) {
      for (const root of ["segments", "beats", "headings", "visuals", "gallery", "comments", "replies", "people", "tags", "shots"] as const) for (const [key, raw] of collabState(handle).roots[root]) {
        probes.add(cleanId(key)); if (raw instanceof Y.Map && typeof raw.get("id") === "string") probes.add(cleanId(raw.get("id") as string));
      }
      const fresh = createMonitoredSharedDocument();
      try {
        assert.ok(applySharedUpdate(fresh, encodeSharedState(handle)).ok);
        const maintained = observeSharedStructureIdentities(handle), rebuilt = observeSharedStructureIdentities(fresh);
        for (const id of probes) if (maintained.has(id) !== rebuilt.has(id)) violations.add("patched reservation index differs from encoded fresh index");
        copies++;
      } finally { destroySharedDocument(fresh); }
    }
  };
  for (let sample = 0; sample < 8; sample++) for (const writers of [2, 3]) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
    const set = replicas(writers, source), handles = [set.a, set.b, set.c].slice(0, writers);
    try {
      for (const handle of handles) { registerSharedSplitHandlers(handle, ports); registerSharedTextOperationHandlers(handle); observeSharedStructureIdentities(handle); }
      checkpoint(handles);
      for (const [writer, handle] of handles.entries()) {
        const kind = ["split", "split-before", "blank", "paste"][(sample + writer + random(4)) % 4] as "split" | "split-before" | "blank" | "paste"; covered.add(kind);
        const command = kind === "blank" || kind === "paste" ? operation({ ...create(), fields: kind === "blank" ? {} : { audioText: "Created", visualText: "Visual", imageRef: { sha256: "a".repeat(64) } } })
          : operation({ kind, id: "enter", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" }, at: { left: null, right: flowBaseReference("R1", "audioText", random(5)), affinity: "before" }, observed: [], boundary: "new", beat: "new", fields: {} });
        assert.deepEqual(executeSharedOperations(handle, [command], { base: readSharedRevision(handle) }), { ok: true }); checkpoint(handles);
      }
      for (let step = 0; step < 8; step++) {
        const handle = handles[random(writers)]; assert.ok(handle);
        transactSharedDocument(handle, "local-command", () => {
          const roots = collabState(handle).roots, text = (roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
          const kind = (sample + step) % 8; covered.add("mutation" + kind);
          if (kind === 0) { const reply = new Y.Map<unknown>(); reply.set("id", "[probeA]"); roots.replies.set("probe-reply", reply); }
          if (kind === 1) { const reply = roots.replies.get("probe-reply"); if (reply instanceof Y.Map) reply.set("id", "[probeB]"); }
          if (kind === 2) roots.order.push(["[probeA]"]);
          if (kind === 3) { const at = roots.order.toArray().indexOf("[probeA]"); if (at >= 0) roots.order.delete(at, 1); }
          if (kind === 4) text.insertEmbed(0, { k: "[probeAtom]", label: "B-roll:" });
          if (kind === 5) { const first = text.toDelta()[0]; if (first && typeof first.insert !== "string" && "k" in first.insert) text.delete(0, 1); }
          if (kind === 6) { text.insertEmbed(0, { k: "[probeB]", label: "B-roll:" }); text.delete(0, 1); }
          if (kind === 7) { roots.replies.delete("probe-reply"); text.insert(0, "X"); }
        }); checkpoint(handles);
      }
      while (set.queue.pending.length) {
        const at = order === "rev" ? set.queue.pending.length - 1 : order === "dup" ? random(set.queue.pending.length) : 0, message = set.queue.pending[at]; assert.ok(message);
        set.queue.deliver(message.id, order === "dup" ? 2 : 1); deliveries++; checkpoint(handles);
      }
      agree("seeded identity checkpoints", order, handles, handle => {
        const document = projectSharedDocument(handle), loaded = runtime.load(document);
        if (document.rows.some((row, index) => row.id !== loaded.rows[index]?.id)) violations.add("a generated beat id changes on load");
        return { document, loaded };
      }); histories++;
    } finally { set.close(); }
  }
  for (const order of ["D1", "dup", "rev", "late-C"] as const) { violations.add(concurrentCleanedCollision(order)); histories++; }
  assert.equal(covered.size, 12); assert.equal(histories, 68); assert.deepEqual({ checkpoints, copies, deliveries }, { checkpoints: 1542, copies: 4050, deliveries: 806 });
  assert.deepEqual([...violations].sort(), [...declaredLimits].sort());
  t.diagnostic(JSON.stringify({ seed: 0x14664, histories, checkpoints, copies, deliveries, covered: [...covered].sort(), declaredLimits, violations: [...violations] }));
});

test("one character or embed patches reservations without inspecting the existing item chain or reading a delta", t => {
  const counts: number[] = [], visits: number[] = [];
  for (const existing of [1, 2048]) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "" }] });
    try {
      const state = collabState(set.a), text = (state.roots.segments.get("b:R1") as Y.Map<unknown>).get("text") as Y.Text;
      for (let index = 0; index < existing; index++) transactSharedDocument(set.a, "local-command", () => { text.insert(0, "a"); });
      const index = observeSharedStructureIdentities(set.a); let inspections = 0, observing = false, visited = 0;
      state.doc.on("beforeObserverCalls", () => { observing = true; }); state.doc.on("afterTransaction", transaction => {
        observing = false; visitSharedIdentityStructs(transaction, () => { visited++; });
      });
      let items = 0;
      for (let item = text._start; item; item = item.right) {
        items++;
        const content = item.content; Object.defineProperty(item, "content", { configurable: true, get: () => { if (observing) inspections++; return content; }, set: value => { Object.defineProperty(item, "content", { configurable: true, writable: true, value }); } });
      }
      assert.equal(items, existing);
      const delta = text.toDelta; text.toDelta = () => { if (observing) throw new Error("Typing read the full text delta"); return delta.call(text) as unknown[]; };
      transactSharedDocument(set.a, "local-command", () => { text.insert(0, "X"); }); counts.push(inspections); visits.push(visited);
      transactSharedDocument(set.a, "local-command", () => { text.insertEmbed(0, { k: "[probeAtom]", label: "B-roll:" }); }); assert.equal(index.has("probeAtom"), true);
      transactSharedDocument(set.a, "local-command", () => { text.insertEmbed(0, { k: "[probeAtom]", label: "B-roll:" }); });
      transactSharedDocument(set.a, "local-command", () => { text.delete(0, 1); }); assert.equal(index.has("probeAtom"), true);
      transactSharedDocument(set.a, "local-command", () => { text.delete(0, 1); }); assert.equal(index.has("probeAtom"), false);
    } finally { set.close(); }
  }
  assert.deepEqual(counts, [0, 0]); assert.deepEqual(visits, [1, 1]); t.diagnostic(JSON.stringify({ existingItems: [1, 2048], oldItemInspections: counts, changedStructVisits: visits }));
});
