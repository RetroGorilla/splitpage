import { structureIdentityFixture } from "../../collab/structure-identity.ts";
import { observeSharedStructureIdentities } from "../../../src/adapters/collab/structure-reservations.ts";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { replicas, agree, operation, ref } from "./executor-support.ts";
import { registerSharedSplitHandlers, prepareSharedBeatSplit } from "../../../src/adapters/collab/split-executor.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRevision, encodeSharedState, encodeSharedStateVector, observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { applyFlowOperations } from "../../core/flow/operation-applier.ts";
import { startBeat, startParagraph, insertBeats, typeWithMarks, beatPos, headingPos, enterInHeading } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowRow } from "../../../src/core/flow/flow.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { registerSharedRecordHandlers } from "../../../src/adapters/collab/record-executor.ts";
import { readProjectionUnits } from "../../../src/adapters/collab/projection-text-reader.ts";
import { projectSharedText } from "../../../src/core/collab/projection/text.ts";
import type { SharedProjectionUnit } from "../../../src/core/collab/projection/units.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { validatedFixture, deliveryReplica } from "./helpers.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { observeSharedStructureOrder } from "../../../src/adapters/collab/structure-order-index.ts";
import { prepareSharedSegmentCreation } from "../../../src/adapters/collab/segment-executor.ts";
import { registerSharedOperationHandlers } from "../../../src/adapters/collab/operation-handlers.ts";

const runtime = createFlowLoadRuntime(), structurePorts = { cells: runtime.cells };

function membership(handle: SharedDocumentHandle) {
  const roots = collabState(handle).roots, rows: { id: string; heading: string | null }[] = [];
  let heading: string | null = null;
  for (const key of roots.order.toArray()) {
    const segment = roots.segments.get(key) as Y.Map<unknown>, head = segment.get("head") as { b?: string; h?: string };
    if (head.h) heading = head.h;
    if (head.b) rows.push({ id: head.b, heading });
    for (const delta of (segment.get("text") as Y.Text).toDelta() as { insert: unknown }[]) {
      if (typeof delta.insert !== "string" && (delta.insert as { b?: string }).b) rows.push({ id: (delta.insert as { b: string }).b, heading });
    }
  }
  return rows;
}

function read(handle: SharedDocumentHandle) {
  const roots = collabState(handle).roots, rows: { id: string; units: SharedProjectionUnit[] }[] = [], headings: string[] = [];
  for (const key of roots.order.toArray()) {
    const segment = roots.segments.get(key) as Y.Map<unknown>, head = segment.get("head") as { b?: string; h?: string };
    const projected = readProjectionUnits(handle, segment.get("text"), segment.get("markRecords")); let offset = 0;
    let current: typeof rows[number] | undefined;
    if (head.h) headings.push(head.h);
    else { assert.ok(head.b); rows.push({ id: head.b, units: [] }); }
    if (!head.h) current = rows.at(-1);
    for (const delta of (segment.get("text") as Y.Text).toDelta() as { insert: unknown }[]) {
      if (typeof delta.insert !== "string" && (delta.insert as { b?: string }).b) { rows.push({ id: (delta.insert as { b: string }).b, units: [] }); current = rows.at(-1); }
      else {
        const length = typeof delta.insert === "string" ? delta.insert.length : 1;
        if (current) current.units.push(...projected.slice(offset, offset + length));
        offset += length;
      }
    }
  }
  return { rows: rows.map(row => {
    const components = [...roots.visuals.values()].filter((value): value is Y.Map<unknown> => value instanceof Y.Map && value.get("beat") === row.id);
    const visual = components.map(component => projectSharedText(readProjectionUnits(handle, component.get("text"), component.get("markRecords")), [])).filter(Boolean).join("<br>");
    return { id: row.id, text: projectSharedText(row.units, []), visual };
  }), headings };
}

function run(handle: SharedDocumentHandle, doc: FlowDoc, outcome: FlowOutcome, counts?: { calls: number; executed: number; kinds: Record<string, number> }) {
  assert.ok(outcome && "rows" in outcome && outcome.ops);
  const expected = applyFlowOperations(doc, outcome.ops, structurePorts.cells), aliases = new Map<string, string>();
  assert.deepEqual(expected.rows, outcome.rows); assert.deepEqual(expected.sections, outcome.sections);
  for (const op of outcome.ops) if (op.kind === "split" || op.kind === "segment-create") aliases.set(op.beat, structureIdentityFixture(String(collabState(handle).doc.clientID), op.id, "beat"));
  const rows = expected.rows.map(row => ({ ...row, id: aliases.get(String(row.id)) ?? String(row.id) })) as FlowRow[];
  assert.deepEqual(executeSharedOperations(handle, outcome.ops, { base: readSharedRevision(handle) }), { ok: true });
  assert.deepEqual(read(handle).rows, rows.map(row => ({ id: row.id, text: toHtml(structurePorts.cells(row.audioText ?? "")), visual: toHtml(structurePorts.cells(row.visualText ?? "")) })));
  const sections = expected.sections?.map(scene => ({ id: scene.id, firstSceneId: aliases.get(scene.firstSceneId) ?? scene.firstSceneId })) ?? [];
  const shared = membership(handle);
  assert.deepEqual(sections, shared.filter((row, index) => row.heading !== null && shared[index - 1]?.heading !== row.heading).map(row => ({ id: row.heading, firstSceneId: row.id })));
  if (counts) { counts.calls++; counts.executed += outcome.ops.length; for (const op of outcome.ops) counts.kinds[op.kind] = (counts.kinds[op.kind] ?? 0) + 1; }
  return { ...doc, rows, sections: expected.sections?.map(scene => ({ ...scene, firstSceneId: aliases.get(scene.firstSceneId) ?? scene.firstSceneId })) } as FlowDoc;
}

test("Enter at the end of the first inline half works repeatedly through complete app lists", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), rt = createFlowLoadRuntime();
  try {
    registerSharedSplitHandlers(set.a, structurePorts); registerSharedTextOperationHandlers(set.a);
    let doc: FlowDoc = { rows: [{ id: "R1", audioText: "abcd" }], comments: [] };
    doc = run(set.a, doc, startBeat(doc, beatPos("R1", 2), { ...rt.ports, newId: () => "tail", operations: { id: "split", by: "Writer" } }));
    for (let index = 0; index < 3; index++) doc = run(set.a, doc, startBeat(doc, beatPos("R1", 2), { ...rt.ports, newId: () => "new", operations: { id: "enter" + index, by: "Writer" } }));
    assert.equal(read(set.a).rows.length, 5); assert.equal(collabState(set.a).roots.order.length, 1);
    set.queue.flush("rev"); agree("repeated inline Enter", "rev", [set.a, set.b], read);
  } finally { set.close(); }
});

test("seeded creation forms agree with complete app lists and a literal concurrent model", t => {
  const counts = { calls: 0, executed: 0, kinds: {} as Record<string, number> }, limits: readonly string[] = [];
  let seed = 0x5c2, histories = 0;
  for (let sample = 0; sample < 36; sample++) for (const kind of ["inline", "heading", "visual"] as const) for (const writers of [2, 3]) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const text = ["A😀B", "abcd", "wxyz"][seed % 3] as string, raw = 1 + (seed >>> 8) % 3, offset = text === "A😀B" && raw === 2 ? 3 : raw;
    const source = validatedFixture({ rows: [{ id: "R1", audioText: text, paragraphStart: true }], ...(kind === "heading" ? { sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] } : {}) });
    const set = replicas(writers, source), handles = [set.a, set.b, set.c].slice(0, writers);
    try {
      for (const handle of handles) { registerSharedSplitHandlers(handle, structurePorts); registerSharedTextOperationHandlers(handle); registerSharedRecordHandlers(handle); }
      const original = readSharedMarkCharacters(set.a, { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" }); assert.ok(original);
      let doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: [] };
      if (kind === "inline") {
        doc = run(set.a, doc, startBeat(doc, beatPos("R1", raw), { ...runtime.ports, newId: () => "tail", operations: { id: "seed", by: "Seed" } }), counts); set.queue.flush("D1");
      }
      const ids = handles.map((_, index) => structureIdentityFixture(String(index + 1), "edit_o_0", "beat"));
      for (const [index, handle] of handles.entries()) {
        const ports = { ...runtime.ports, newId: () => "same", operations: { id: "edit", by: "Writer" + index } }, letter = "MNO".charAt(index);
        const outcome = kind === "inline" ? startBeat(doc, beatPos("R1", offset), ports) : kind === "heading" ? startParagraph(doc, beatPos("R1", 0), ports)
          : insertBeats(doc, beatPos("R1", 4), [{ id: "same", audioText: letter, visualText: "<em>v" + letter + "</em>", imageRef: { sha256: "abc".charAt(index).repeat(64) }, imageName: letter, imageLinks: [{ href: "https://example.com/" + letter }] }], ports);
        const local = run(handle, doc, outcome, counts);
        if (kind !== "visual") run(handle, local, typeWithMarks(local, beatPos(ids[index] as string, 0), letter, {}, { ...runtime.ports, operations: { id: "typed", by: "Writer" + index } }), counts);
      }
      set.queue.flush(order);
      const created = ids.map((id, index) => ({ id, text: "MNO".charAt(index), visual: kind === "visual" ? "<em>v" + "MNO".charAt(index) + "</em>" : "" }));
      const base = { id: "R1", text: kind === "inline" ? text.slice(0, offset) : text, visual: "" };
      const rows = kind === "inline" ? [base, ...created, { id: structureIdentityFixture("1", "seed_o_0", "beat"), text: text.slice(offset), visual: "" }]
        : kind === "heading" ? [...created, base] : [base, ...created];
      agree(`creation seed=${seed}/${kind}`, order, handles, handle => {
        const characters = readSharedMarkCharacters(handle, { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" }); assert.ok(characters);
        for (const char of original) assert.ok(characters.some(current => current.identity.client === char.identity.client && current.identity.clock === char.identity.clock && current.value === char.value));
        const gallery = [...collabState(handle).roots.gallery.entries()].filter(([, value]) => value instanceof Y.Map && value.get("beat") !== "R1").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([record, raw]) => {
          const value = raw as Y.Map<unknown>, links = value.get("links") as Y.Map<Y.Map<unknown>>;
          return { record, beat: value.get("beat"), picture: value.get("picture"), links: [...links.values()].map(link => ({ href: link.get("href") })) };
        });
        return { ...read(handle), gallery };
      }, { rows, headings: kind === "heading" ? ["H1"] : [], gallery: kind === "visual" ? ids.map((beat, index) => ({ record: structureIdentityFixture(String(index + 1), "edit_o_0", "gallery", 0), beat,
        picture: { imageRef: { sha256: "abc".charAt(index).repeat(64) }, name: "MNO".charAt(index) }, links: [{ href: "https://example.com/" + "MNO".charAt(index) }] })) : [] }); histories++;
    } finally { set.close(); }
  }
  assert.equal(histories, 864); assert.equal(counts.calls, 3888); assert.equal(counts.executed, 6768);
  assert.deepEqual(counts.kinds, { split: 288, "segment-create": 2160, "text-insert": 2160, scalar: 720, "record-create": 1440 });
  assert.deepEqual(Object.keys(counts.kinds).sort(), ["record-create", "scalar", "segment-create", "split", "text-insert"]);
  t.diagnostic(JSON.stringify({ histories, ...counts, skipped: 0, deferred: 0, limits }));
});

test("multi-beat visual insertion agrees with the app at beginning, middle and end, including rich atoms and metadata", t => {
  const html = ['<strong>B</strong><em>I</em><u>U</u><s>S</s><mark>H</mark>', '<span class="stage-dir">Turn</span><span class="audio-cue">SFX: Bell</span>',
    '<span class="cmt-anchor" data-cmt="c1"><a href="https://example.com">Link</a></span>', '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Cup">Cup</span>',
    '<span class="who-anchor" data-who="Sam" contenteditable="false">@Sam</span>', '<span class="broll-key" data-broll-id="S1" contenteditable="false">Steam</span>',
    '<img class="comment-img" data-blob="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">'];
  let calls = 0, executed = 0;
  for (const [sample, visualText] of html.entries()) for (const position of [0, 2, 4]) {
    const source = validatedFixture({ rows: [{ id: "R1", audioText: "abcd", paragraphStart: true }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] }), set = replicas(2, source);
    try {
      registerSharedSplitHandlers(set.a, structurePorts); registerSharedTextOperationHandlers(set.a); registerSharedRecordHandlers(set.a);
      const doc: FlowDoc = { rows: source.rows, sections: source.sections, comments: [] };
      const beats = [{ id: "first", audioText: "<em>A</em>", visualText, updatedAt: "2026-01-01T00:00:00Z", updatedBy: "Original", custom: { keep: true } }, { id: "second", audioText: "B", visualText: "<strong>Second</strong>" }];
      const outcome = insertBeats(doc, beatPos("R1", position), beats, { ...runtime.ports, newId: () => "tail", operations: { id: "batch", by: "Writer" } });
      const result = run(set.a, doc, outcome); assert.ok(outcome && "rows" in outcome && outcome.ops);
      const first = result.rows.find(row => row.custom); assert.ok(first);
      const stored = collabState(set.a).roots.beats.get(first.id) as Y.Map<unknown>;
      assert.deepEqual(stored.get("stamp"), { at: "2026-01-01T00:00:00Z", by: "Original" }); assert.equal(stored.get("extra"), '{"custom":{"keep":true}}');
      set.queue.flush("dup"); agree(`rich batch ${sample}/${position}`, "dup", [set.a, set.b], read); calls++; executed += outcome.ops.length;
    } finally { set.close(); }
  }
  assert.equal(calls, 21); t.diagnostic(JSON.stringify({ calls, executed, skipped: 0, deferred: 0, limits: [] }));
});

test("initial content accepts subsequent narration and visual edits in the same list and emits one transaction and update", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), origins: unknown[] = [], updates: Uint8Array[] = [];
  try {
    let decodes = 0;
    registerSharedSplitHandlers(set.a, { cells: html => { assert.equal(collabState(set.a).execution?.applying, false); decodes++; return structurePorts.cells(html); } });
    registerSharedTextOperationHandlers(set.a);
    const stop = observeSharedTransactions(set.a, origin => origins.push(origin)), detach = deliveryReplica(set.a).onLocalUpdate(update => updates.push(update));
    const create = operation({ kind: "segment-create", id: "create", by: "Writer", beat: "new", segment: "new", at: { left: "R1", right: null, affinity: "after" }, fields: { audioText: "<em>A😀B</em>", visualText: "<strong>Look</strong>", moreImages: null } });
    const insert = (field: "audioText" | "visualText", offset: number) => operation({ kind: "text-insert", id: "insert" + field, by: "Writer", target: { owner: "new", segment: "new", field },
      at: { left: null, right: flowBaseReference("new", field, offset), affinity: "before" }, content: [{ value: "X", marks: [] }] });
    assert.deepEqual(executeSharedOperations(set.a, [create, insert("audioText", 4), insert("visualText", 4)], { base: readSharedRevision(set.a) }), { ok: true });
    assert.equal(decodes, 2); assert.deepEqual(origins, ["local-command"]); assert.equal(updates.length, 1); stop(); detach();
    const row = read(set.a).rows[1]; assert.ok(row); assert.equal(row.text, "<em>A😀B</em>X"); assert.equal(row.visual, "<strong>Look</strong>X");
    set.queue.flush("rev"); agree("initial content and subsequent edits", "rev", [set.a, set.b], read);
  } finally { set.close(); }
});

test("late creation refusals preserve bytes, vector, revision and delivered count", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "Tail" }] }), updates: Uint8Array[] = [];
  try {
    registerSharedSplitHandlers(set.a, structurePorts); registerSharedRecordHandlers(set.a);
    const bytes = encodeSharedState(set.a), vector = encodeSharedStateVector(set.a), revision = readSharedRevision(set.a), detach = deliveryReplica(set.a).onLocalUpdate(update => updates.push(update));
    const create = { kind: "segment-create", id: "create", by: "Writer", beat: "new", segment: "new", at: { left: "R1", right: "R2", affinity: "before" }, fields: { visualText: "Look" } };
    const lists = [[operation(create), operation({ kind: "record-create", id: "record", by: "Writer", target: { collection: "visuals", record: "new:visual" }, fields: { beat: "new", html: "Different" } })],
      [operation({ ...create, at: { left: "R2", right: "R1", affinity: "before" } })], [operation({ ...create, segment: "b:R1" })],
      [operation({ ...create, fields: { visualText: "Look", imageLinks: [{ name: "File", size: 1, location: { kind: "bundled", name: "clip.mp4" } }] } })],
      [operation({ ...create, fields: { visualText: "Look", visualImage: "data:image/png;base64,AAAA" } })],
      [operation({ ...create, fields: { imageLinks: [{ href: "https://example.com" }, { href: "https://example.com" }] } })]];
    for (const operations of lists) {
      assert.ok(!executeSharedOperations(set.a, operations, { base: revision }).ok);
      assert.deepEqual(encodeSharedState(set.a), bytes); assert.deepEqual(encodeSharedStateVector(set.a), vector); assert.equal(readSharedRevision(set.a), revision); assert.equal(updates.length, 0);
    }
    detach();
  } finally { set.close(); }
});

test("inline rich creation reads only touched records and freezes its descriptions with unrelated content present", t => {
  const counts: number[] = [];
  for (const unrelated of [0, 10000]) {
    const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), handle = set.a;
    try {
      const identities = observeSharedStructureIdentities(handle);
      registerSharedOperationHandlers(handle, { split: (op, view) => prepareSharedBeatSplit(op, view, identities) });
      const split = operation({ kind: "split", id: "cut", by: "Writer", target: { owner: "R1", segment: "b:R1", field: "audioText" }, at: { left: null, right: flowBaseReference("R1", "audioText", 2), affinity: "before" }, observed: [], boundary: "tail", beat: "tail", fields: {} });
      assert.deepEqual(executeSharedOperations(handle, [split], { base: readSharedRevision(handle) }), { ok: true });
      transactSharedDocument(handle, "local-command", () => {
        for (let index = 0; index < unrelated; index++) {
          collabState(handle).roots.beats.set("unrelated" + index, { status: "todo" }); collabState(handle).roots.order.push(["unrelated" + index]);
        }
      });
      const order = observeSharedStructureOrder(handle); let reads = 0;
      registerSharedOperationHandlers(handle, { "segment-create": (op, view) => {
        const prepared = prepareSharedSegmentCreation(op, { ...view, get: path => { reads++; assert.ok(["beats", "segments", "visuals", "gallery"].includes(path[0] ?? "")); return view.get(path); }, keys: () => { throw new Error("whole root read"); } }, order, structurePorts, identities);
        assert.ok(prepared.ok); assert.ok(Object.isFrozen(prepared.description)); assert.ok(Object.isFrozen(prepared.description.boundary));
        assert.ok(prepared.description.texts.every(text => Object.isFrozen(text) && Object.isFrozen(text.path)));
        assert.ok(prepared.description.content.every(content => Object.isFrozen(content) && Object.isFrozen(content.steps)));
        return prepared;
      } });
      const whole = mock.method(collabState(handle).roots.order, "toArray", () => { throw new Error("whole order read during preparation"); });
      try {
        const command = operation({ kind: "segment-create", id: "create", by: "Writer", beat: "new", segment: "new", at: { left: "R1", right: structureIdentityFixture("1", "cut", "beat"), affinity: "before" }, fields: { audioText: "<em>A😀</em>", visualText: "<strong>V</strong>" } });
        assert.deepEqual(executeSharedOperations(handle, [command], { base: readSharedRevision(handle) }), { ok: true }); counts.push(reads); assert.equal(whole.mock.callCount(), 0);
      } finally { whole.mock.restore(); }
    } finally { set.close(); }
  }
  assert.deepEqual(counts, [0, 0]); t.diagnostic(JSON.stringify({ unrelated: [0, 10000], reads: counts, wholeOrderReads: 0 }));
});

test("insertBeats initializes visual runs, marks, gallery records and following narration through the app list", () => {
  const set = replicas(2, { rows: [{ id: "R1", audioText: "abcd" }] }), rt = createFlowLoadRuntime();
  try {
    registerSharedSplitHandlers(set.a, structurePorts); registerSharedTextOperationHandlers(set.a); registerSharedRecordHandlers(set.a);
    const imageRef = { sha256: "a".repeat(64) }, rows = [{ id: "pasted", audioText: "<strong>New</strong>", visualText: '<em>Look</em><br><a href="https://example.com">here</a>', imageRef }];
    const doc: FlowDoc = { rows: [{ id: "R1", audioText: "abcd" }], comments: [] };
    const expected = run(set.a, doc, insertBeats(doc, beatPos("R1", 2), rows, { ...rt.ports, newId: () => "tail", operations: { id: "paste", by: "Writer" } }));
    const id = expected.rows[1]?.id; assert.ok(id);
    const gallery = [...collabState(set.a).roots.gallery.values()].filter((value): value is Y.Map<unknown> => value instanceof Y.Map && value.get("beat") === id);
    assert.equal(gallery.length, 1); assert.deepEqual(gallery[0]?.get("picture"), { imageRef });
    set.queue.flush("rev"); agree("rich inserted beat", "rev", [set.a, set.b], read);
  } finally { set.close(); }
});

test("startParagraph before a scene's first beat stays after its heading and repairs its anchor", () => {
  const source = { rows: [{ id: "R1", audioText: "abcd", paragraphStart: true }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] }, set = replicas(2, source), rt = createFlowLoadRuntime();
  try {
    registerSharedSplitHandlers(set.a, structurePorts);
    const doc = run(set.a, { ...source, comments: [] }, startParagraph({ ...source, comments: [] }, beatPos("R1", 0), { ...rt.ports, newId: () => "new", operations: { id: "enter", by: "Writer" } }));
    const fresh = doc.rows[0]?.id; assert.ok(fresh);
    assert.equal((collabState(set.a).roots.headings.get("H1") as Y.Map<unknown>).get("firstSceneId"), fresh);
    assert.deepEqual(collabState(set.a).roots.order.toArray(), ["h:H1", structureIdentityFixture("1", "enter_o_0", "segment"), "b:R1"]);
    set.queue.flush("D1"); agree("scene first paragraph", "D1", [set.a, set.b], read);
  } finally { set.close(); }
});


test("creation affinity preserves literal scene membership at scene gaps and script edges", () => {
  const source = { rows: [{ id: "R0", audioText: "abcd" }, { id: "R1", audioText: "efgh", paragraphStart: true }],
    sections: [{ id: "H0", name: "First", firstSceneId: "R0" }, { id: "H1", name: "Second", firstSceneId: "R1" }] };
  const fresh = structureIdentityFixture("1", "action_o_0", "beat");
  const cases = [
    { kind: "beat", owner: "R0", offset: 4, affinity: "after", expected: [["R0", "H0"], [fresh, "H0"], ["R1", "H1"]] },
    { kind: "paragraph", owner: "R0", offset: 4, affinity: "after", expected: [["R0", "H0"], [fresh, "H0"], ["R1", "H1"]] },
    { kind: "paste", owner: "R0", offset: 4, affinity: "after", expected: [["R0", "H0"], [fresh, "H0"], ["R1", "H1"]] },
    { kind: "paragraph", owner: "R1", offset: 0, affinity: "before", expected: [["R0", "H0"], [fresh, "H1"], ["R1", "H1"]] },
    { kind: "beat", owner: "R1", offset: 4, affinity: "after", expected: [["R0", "H0"], ["R1", "H1"], [fresh, "H1"]] },
    { kind: "paragraph", owner: "R1", offset: 4, affinity: "after", expected: [["R0", "H0"], ["R1", "H1"], [fresh, "H1"]] },
    { kind: "paste", owner: "R1", offset: 4, affinity: "after", expected: [["R0", "H0"], ["R1", "H1"], [fresh, "H1"]] },
    { kind: "heading", owner: "H0", offset: 0, affinity: "after", expected: [[fresh, null], ["R0", "H0"], ["R1", "H1"]] },
    { kind: "paste-heading", owner: "H0", offset: 0, affinity: "after", expected: [[fresh, null], ["R0", "H0"], ["R1", "H1"]] },
    { kind: "paragraph", owner: "R0", offset: 0, affinity: "before", expected: [[fresh, "H0"], ["R0", "H0"], ["R1", "H1"]] }
  ];
  for (const item of cases) {
    const set = replicas(2, source), doc = { ...source, comments: [] }, ports = { ...runtime.ports, newId: () => "new", operations: { id: "action", by: "Writer" } };
    try {
      registerSharedSplitHandlers(set.a, structurePorts); registerSharedTextOperationHandlers(set.a);
      const pos = item.kind.includes("heading") ? headingPos(item.owner, item.offset) : beatPos(item.owner, item.offset);
      const out = item.kind === "beat" ? startBeat(doc, pos, ports) : item.kind === "paragraph" ? startParagraph(doc, pos, ports)
        : item.kind === "heading" ? enterInHeading(doc, pos, ports) : insertBeats(doc, pos, [{ id: "pasted", audioText: "P" }], ports);
      assert.ok(out && "ops" in out); assert.equal(out.ops?.[0]?.kind, "segment-create");
      assert.equal((out.ops?.[0] as { at: { affinity: string } }).at.affinity, item.affinity);
      run(set.a, doc, out); set.queue.flush("rev");
      agree("scene gap " + item.kind + item.owner + item.offset, "rev", [set.a, set.b], handle => membership(handle).map(row => [row.id, row.heading]), item.expected);
    } finally { set.close(); }
  }
});

test("reverse-emitted pasted groups stay before the next scene's heading", () => {
  for (const first of [false, true]) {
    const source = { rows: [{ id: "R0", audioText: "abcd" }, { id: "R1", audioText: "efgh" }],
      sections: [{ id: "H0", name: "First", firstSceneId: "R0" }, { id: "H1", name: "Second", firstSceneId: "R1" }] };
    const set = replicas(2, source), doc = { ...source, comments: [] };
    try {
      registerSharedSplitHandlers(set.a, structurePorts); registerSharedTextOperationHandlers(set.a);
      run(set.a, doc, insertBeats(doc, first ? headingPos("H0", 0) : beatPos("R0", 4), [{ id: "p1", audioText: "P" }, { id: "p2", audioText: "Q" }],
        { ...runtime.ports, operations: { id: "paste", by: "Writer" } }));
      const p1 = structureIdentityFixture("1", "paste_o_2", "beat"), p2 = structureIdentityFixture("1", "paste_o_0", "beat");
      const expected = first ? [[p1, null], [p2, null], ["R0", "H0"], ["R1", "H1"]] : [["R0", "H0"], [p1, "H0"], [p2, "H0"], ["R1", "H1"]];
      set.queue.flush("dup"); agree("reverse paste scene edge", "dup", [set.a, set.b], handle => membership(handle).map(row => [row.id, row.heading]), expected);
    } finally { set.close(); }
  }
});

test("concurrent creations keep their own scenes at the middle, end and first heading", () => {
  for (const edge of ["middle", "end", "first"] as const) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
    const source = { rows: [{ id: "R0", audioText: "abcd" }, { id: "R1", audioText: "efgh", paragraphStart: true }],
      sections: [{ id: "H0", name: "First", firstSceneId: "R0" }, { id: "H1", name: "Second", firstSceneId: "R1" }] };
    const set = replicas(2, source), doc = { ...source, comments: [] };
    try {
      for (const handle of [set.a, set.b]) registerSharedSplitHandlers(handle, structurePorts);
      const ports = { ...runtime.ports, newId: () => "same", operations: { id: "enter", by: "Writer" } };
      run(set.a, doc, edge === "first" ? enterInHeading(doc, headingPos("H0", 0), ports) : startBeat(doc, beatPos(edge === "middle" ? "R0" : "R1", 4), ports));
      run(set.b, doc, startParagraph(doc, beatPos(edge === "first" ? "R0" : "R1", edge === "end" ? 4 : 0), ports));
      const a = structureIdentityFixture("1", "enter_o_0", "beat"), b = structureIdentityFixture("2", "enter_o_0", "beat");
      const expected = edge === "middle" ? [["R0", "H0"], [a, "H0"], [b, "H1"], ["R1", "H1"]]
        : edge === "end" ? [["R0", "H0"], ["R1", "H1"], [a, "H1"], [b, "H1"]] : [[a, null], [b, "H0"], ["R0", "H0"], ["R1", "H1"]];
      set.queue.flush(order); agree("concurrent scene intent " + edge, order, [set.a, set.b], handle => membership(handle).map(row => [row.id, row.heading]), expected);
    } finally { set.close(); }
  }
});


test("creation before a heading stays outside its inline first beat", () => {
  for (const mode of ["enter", "paste", "fallback"]) {
    const source = { rows: [{ id: "R0", audioText: "abcd" }], sections: [{ id: "H0", name: "First", firstSceneId: "R0" }] }, set = replicas(2, source);
    try {
      registerSharedSplitHandlers(set.a, structurePorts); registerSharedTextOperationHandlers(set.a);
      const doc = run(set.a, { ...source, comments: [] }, enterInHeading({ ...source, comments: [] }, headingPos("H0", 2),
        { ...runtime.ports, newId: () => "tail", operations: { id: "tail", by: "Writer" } }));
      const ports = { ...runtime.ports, newId: () => "new", operations: { id: "before", by: "Writer" } };
      if (mode === "fallback") assert.deepEqual(executeSharedOperations(set.a, [operation({ kind: "segment-create", id: "before_o_0", by: "Writer",
        beat: "new", segment: "new", at: { left: "future", right: "R0", affinity: "after" }, fields: { audioText: "N" } })], { base: readSharedRevision(set.a) }), { ok: true });
      else run(set.a, doc, mode === "paste" ? insertBeats(doc, headingPos("H0", 0), [{ id: "p1", audioText: "P" }, { id: "p2", audioText: "Q" }], ports)
        : enterInHeading(doc, headingPos("H0", 0), ports));
      const tail = structureIdentityFixture("1", "tail_o_0", "beat"), last = structureIdentityFixture("1", "before_o_0", "beat"), first = structureIdentityFixture("1", "before_o_2", "beat");
      const expected = mode === "paste" ? [[first, null], [last, null], [tail, "H0"], ["R0", "H0"]]
        : mode === "fallback" ? [[tail, "H0"], [last, "H0"], ["R0", "H0"]] : [[last, null], [tail, "H0"], ["R0", "H0"]];
      set.queue.flush("rev"); agree("before inline heading beat", "rev", [set.a, set.b], handle => membership(handle).map(row => [row.id, row.heading]), expected);
    } finally { set.close(); }
  }
});
