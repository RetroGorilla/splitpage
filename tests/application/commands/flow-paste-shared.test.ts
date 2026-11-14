import "../../../src/test/_dom.mjs";
import "../../../src/test/_copy-paste-mounted.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, caretAt, replaceRange, typeWithMarks } from "../../../src/core/flow/flow.ts";
import type { FlowRange } from "../../../src/core/flow/flow.ts";
import { setLiveCut, startBeatClip } from "../../../src/features/clipboard/beat-clip.ts";
import { pasteFlowClipboard, pasteSharedFlowClipboard } from "../../../src/features/clipboard/flow-clip.ts";
import { standaloneFlowCommand } from "../../../src/application/commands/flow.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import { writerFlowCommands } from "../../../src/bootstrap/wiring/ports/writer-flow.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { createMonitoredSharedDocument } from "../../adapters/collab/helpers.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { replicas } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { createSharedUndo } from "../../../src/application/editing/undo/shared-undo.ts";
import { executeSharedCommand, reverseSharedUndoRecord, supportsSharedUndoPart } from "../../../src/adapters/collab/undo-executor.ts";

const stamps = { clock: { nowIso: () => "2026-11-13T12:00:00.000Z" }, editor: { name: () => "Alice" } };
const pasted = "structure_1_00770031005f0031005f006f005f0030_beat_0";
const firstOfTwo = "structure_1_00770031005f0031005f006f005f0032_beat_0";
const heading = "structure_1_00770031005f0031005f006f005f0032_heading_0";
const headingSource = "structure_1_00770031005f0031005f006f005f0032005f0073006f0075007200630065_beat_0";
const cup = "t_omzgqc181rmzb";
const tagHtml = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Cup" contenteditable="false">Cup</span>';
const brollHtml = '<span class="broll-key" data-broll-id="S" contenteditable="false">B-roll:</span> gulls';
const pastedBroll = '<span class="broll-key" data-broll-id="paste_w1_1_shot_0" contenteditable="false">B-roll:</span> gulls';
const image = { sha256: "a".repeat(64), width: 3, height: 2, mime: "image/jpeg" };
const annotation = { imageRef: { sha256: "c".repeat(64), width: 3, height: 2, mime: "image/jpeg" },
  marks: [{ kind: "pen", color: "#e5383b", width: 0.01, points: [0.1, 0.1, 0.5, 0.5] }] };
const sortedAnnotation = { imageRef: { sha256: "c".repeat(64), width: 3, height: 2, mime: "image/jpeg" },
  marks: [{ color: "#e5383b", kind: "pen", points: [0.1, 0.1, 0.5, 0.5], width: 0.01 }] };
const changed = { updatedAt: "2026-11-13T12:00:00.000Z", updatedBy: "Alice" };
const at = caretAt(beatPos("R1", 1));

function expectedRow(id: string, audioText: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, status: "todo", visualText: "", audioText, imageRef: null, updatedAt: "", updatedBy: null, ...extra };
}

function expectedDocument(rows: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows,
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0, ...extra };
}

function wire(rows: readonly Record<string, unknown>[], records: Record<string, unknown> = {}, headers: readonly unknown[] = []) {
  const payload = JSON.stringify({ format: "splitpage-flow", version: 1, text: "X", wholeIds: rows.map(row => row.id), headers,
    beats: rows.length ? { format: "splitpage-scenes", version: 1, rows, ...records } : null });
  return { getData: (type: string) => type === "application/x-splitpage-flow" ? payload : "" };
}

function clipboardRuntime() {
  const runtime = createFlowLoadRuntime(); let next = 0;
  const clip = startBeatClip({ ids: { id: prefix => prefix + ++next }, pictures: { dataUrlFor: () => null,
    internDataUrl: () => null, queuePersist: () => {} }, text: { cellOf: runtime.cells,
    fromHtml: html => runtime.rich.decode(html, { media: true }), inertBody: runtime.rich.inertBody },
  migrate: runtime.load, tagsInRows: () => [], recordPastedBroll: () => {} });
  return { ...runtime, close: clip.dispose };
}

function creation(beat: string, id: string, audioText: string, extra: Record<string, unknown> = {}, left = "R1", right = "R2") {
  return { kind: "segment-create", id, by: "Alice", segment: beat, beat,
    at: { left, right, affinity: "before" }, fields: { visualText: "", status: "todo", updatedAt: "", updatedBy: null, audioText, ...extra } };
}

function stamp(beat = pasted, index = 0) {
  return { kind: "scalar", id: "w1_1_stamp_" + index + ":stamp", by: "Alice", target: { scope: "beat", record: beat }, field: "stamp", value: { at: "2026-11-13T12:00:00.000Z", by: "Alice" } };
}

function record(collection: string, key: string, fields: Record<string, unknown>, index = 0) {
  return { kind: "record-create", id: "w1_1:paste:" + index, by: "Alice", target: { collection, record: key }, fields };
}

interface PasteLiteral {
  readonly name: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly records?: Record<string, unknown>;
  readonly headers?: readonly unknown[];
  readonly operations: readonly unknown[];
  readonly expected: Record<string, unknown>;
  readonly refused?: string;
  readonly selection?: { anchor: unknown; head: unknown };
  readonly source?: Record<string, unknown>;
  readonly standaloneExpected?: Record<string, unknown>;
}

const literals: readonly PasteLiteral[] = [
  { name: "one formatted beat", rows: [{ id: "old", audioText: "<strong>X</strong>" }],
    operations: [creation(pasted, "w1_1_o_0", "<strong>X</strong>"), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, "<strong>X</strong>", changed), expectedRow("R2", "B")]),
    selection: { anchor: { kind: "beat", rowId: pasted, offset: 0 }, head: { kind: "beat", rowId: pasted, offset: 1 } } },
  { name: "several beats", rows: [{ id: "old", audioText: "X" }, { id: "old2", audioText: "Y" }], operations: [
    creation(pasted, "w1_1_o_0", "Y", {}, firstOfTwo), creation(firstOfTwo, "w1_1_o_2", "X", {}, "R1", pasted), stamp(firstOfTwo), stamp(pasted, 1)
  ], expected: expectedDocument([expectedRow("R1", "A"), expectedRow(firstOfTwo, "X", changed), expectedRow(pasted, "Y", changed), expectedRow("R2", "B")]) },
  { name: "beat with heading", rows: [{ id: "old", audioText: "X" }], headers: [{ index: 0, scene: { name: "Scene" } }], operations: [
    creation(pasted, "w1_1_o_0", "X"),
    { kind: "segment-create", id: "w1_1_o_2_source", by: "Alice", segment: headingSource, beat: headingSource,
      at: { left: null, right: pasted, affinity: "before" }, fields: { audioText: "# Scene<br>", visualText: "", status: "todo" } },
    { kind: "heading-finalize", id: "w1_1_o_2", by: "Alice", target: { owner: headingSource, segment: headingSource, field: "audioText" }, heading,
      prefix: ['["flow-base","' + headingSource + '","audioText",0,2]'], name: ['["flow-base","' + headingSource + '","audioText",2,7]'],
      separator: ['["flow-base","' + headingSource + '","audioText",7,8]'], tail: { left: null, right: '["flow-base","' + headingSource + '","audioText",8,8]', affinity: "before" }, retainedBeat: pasted, emptyBeat: null }, stamp()
  ], expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, "X", changed), expectedRow("R2", "B")], { sections: [{ id: heading, name: "Scene", firstSceneId: pasted }] }) },
  { name: "tags and people", rows: [{ id: "old", audioText: tagHtml }],
    records: { people: [{ id: "P", name: "Pat" }], productionTags: [{ id: "t_old", cat: "prop", name: "Cup", owner: "P", notes: "Keep", status: "have" }] },
    operations: [record("people", "person_007000610074", { name: "Pat", rank: "0000000000", extra: "{}" }),
      record("tags", cup, { cat: "prop", name: "Cup", owner: "person_007000610074", notes: "Keep", status: "have", rank: "0000000000", extra: "{}" }, 1),
      creation(pasted, "w1_1_o_0", tagHtml), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, tagHtml, changed), expectedRow("R2", "B")], {
      people: [{ id: "person_007000610074", name: "Pat" }], productionTags: [{ id: cup, cat: "prop", name: "Cup", owner: "person_007000610074", notes: "Keep", status: "have" }] }) },
  { name: "reuse natural tag and person keys", rows: [{ id: "old", audioText: tagHtml, visualText: brollHtml }],
    source: { people: [{ id: "existing", name: "PAT" }], productionTags: [{ id: "t_existing", cat: "prop", name: "Cup", owner: "existing", notes: "Original", status: "have" }] },
    records: { people: [{ id: "P", name: "  pat  " }], productionTags: [{ id: "t_old", cat: "prop", name: " cup ", owner: "P" }], brollShots: [{ id: "S", name: "gulls", owner: "P", origin: "script", props: [{ id: "t_old", name: "Cup" }] }] },
    operations: [record("shots", "paste_w1_1_shot_0", { name: "gulls", desc: "", status: "unshot", reshoot: false, notes: "", audioRef: "", location: "", owner: "existing", origin: "script", props: [{ id: "t_existing", name: "Cup" }], extra: "{}", rank: "0000000000" }), creation(pasted, "w1_1_o_0", tagHtml, { visualText: pastedBroll }), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, tagHtml, { ...changed, visualText: pastedBroll }), expectedRow("R2", "B")], {
      people: [{ id: "existing", name: "PAT" }], productionTags: [{ id: "t_existing", cat: "prop", name: "Cup", owner: "existing", notes: "Original", status: "have" }],
      brollShots: [{ id: "paste_w1_1_shot_0", name: "gulls", desc: "", status: "unshot", reshoot: false, notes: "", owner: "existing", audioRef: "", location: "", props: [{ id: "t_existing", name: "Cup" }], origin: "script" }] }) },
  { name: "sound cue", rows: [{ id: "old", audioText: '<span class="audio-cue">SFX: Bang</span>' }],
    operations: [record("tags", "t_y48ehapauupx", { cat: "sound", name: "Bang", owner: "", notes: "", status: "needed", rank: "0000000000", extra: "{}" }), creation(pasted, "w1_1_o_0", '<span class="audio-cue">SFX: Bang</span>'), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, '<span class="audio-cue">SFX: Bang</span>', changed), expectedRow("R2", "B")], { productionTags: [{ id: "t_y48ehapauupx", cat: "sound", name: "Bang", owner: "", notes: "", status: "needed" }] }) },
  { name: "visual text and shot", rows: [{ id: "old", audioText: "X", visualText: brollHtml }], records: { brollShots: [{ id: "S", name: "gulls", desc: "", status: "unshot", owner: "", props: [], origin: "script" }] },
    operations: [record("shots", "paste_w1_1_shot_0", { name: "gulls", desc: "", status: "unshot", reshoot: false, notes: "", audioRef: "", location: "", owner: "", origin: "script", props: [], extra: "{}", rank: "0000000000" }),
      creation(pasted, "w1_1_o_0", "X", { visualText: pastedBroll }), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, "X", { ...changed, visualText: pastedBroll }), expectedRow("R2", "B")], {
      brollShots: [{ id: "paste_w1_1_shot_0", name: "gulls", desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "script" }] }) },
  { name: "gallery picture", rows: [{ id: "old", audioText: "X", imageRef: image, imageName: "wide.jpg" }],
    operations: [creation(pasted, "w1_1_o_0", "X"), record("gallery", "paste_w1_1_picture_0", { beat: pasted, rank: "0000000000", picture: { imageRef: image, name: "wide.jpg" }, links: [] }), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, "X", { ...changed, imageRef: image, imageName: "wide.jpg" }), expectedRow("R2", "B")]) },
  { name: "marked gallery picture", rows: [{ id: "old", audioText: "X", imageRef: image, imageName: "wide.jpg", imageAnnotation: annotation }],
    operations: [creation(pasted, "w1_1_o_0", "X"), record("gallery", "paste_w1_1_picture_0", { beat: pasted, rank: "0000000000", picture: { imageRef: image, name: "wide.jpg", annotation: sortedAnnotation }, links: [] }), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, "X", { ...changed, imageRef: image, imageName: "wide.jpg", imageAnnotation: annotation }), expectedRow("R2", "B")]),
    standaloneExpected: expectedDocument([expectedRow("R1", "A"), expectedRow("r1", "X", { ...changed, imageRef: image, imageName: "wide.jpg", imageAnnotation: annotation }), expectedRow("R2", "B")]) },
  { name: "comment and reply", rows: [{ id: "old", audioText: '<span class="cmt-anchor" data-cmt="C">X</span>' }],
    records: { comments: [{ id: "C", anchorId: "C", rowId: "old", field: "audioText", author: "Alice", body: "Note", quotedText: "X", createdAt: "2026-11-12T00:00:00.000Z", replies: [{ id: "reply", author: "Alice", body: "Reply", createdAt: "2026-11-12T01:00:00.000Z" }] }] },
    operations: [record("comments", "paste_w1_1_comment_0", { rowId: pasted, field: "audioText", anchorId: "paste_w1_1_comment_0", author: "Alice", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", assignee: "", kind: "anchor", text: "Note", quote: "X", extra: "{}", resolution: { resolved: false, resolvedAt: null, resolvedBy: null }, rank: "0000000000" }),
      record("replies", '["paste_w1_1_comment_0","paste_w1_1_reply_0_0"]', { id: "paste_w1_1_reply_0_0", commentId: "paste_w1_1_comment_0", author: "Alice", createdAt: "2026-11-12T01:00:00.000Z", text: "Reply", extra: "{}", rank: "0000000000" }, 1),
      creation(pasted, "w1_1_o_0", '<span class="cmt-anchor" data-cmt="paste_w1_1_comment_0">X</span>'), stamp()],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, '<span class="cmt-anchor" data-cmt="paste_w1_1_comment_0">X</span>', changed), expectedRow("R2", "B")], {
      comments: [{ id: "paste_w1_1_comment_0", rowId: pasted, field: "audioText", anchorId: "paste_w1_1_comment_0", author: "Alice", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", assignee: "", kind: "anchor", body: "Note", quotedText: "X", resolved: false, resolvedAt: null, resolvedBy: null,
        replies: [{ id: "paste_w1_1_reply_0_0", author: "Alice", createdAt: "2026-11-12T01:00:00.000Z", body: "Reply" }] }] }) }
];

for (const literal of literals) test("shared whole-beat paste literal and separate operations: " + literal.name, () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }], ...literal.source });
  const runtime = clipboardRuntime(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
    const ports = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1", handle: () => h.a });
    const data = wire(literal.rows, literal.records, literal.headers);
    if (literal.standaloneExpected) {
      const standalone = runtime.load({ schema: 2, docId: "d00000000000000000000000000000000", rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }] });
      const command = standaloneFlowCommand("paste", () => pasteFlowClipboard(standalone, at, data, runtime.ports, runtime.rich.inertBody, runtime.load) ?? null, stamps, at);
      const plan = command.plan(standalone, createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) }));
      assert.ok(plan && !("refused" in plan)); plan.apply(standalone);
      assert.deepEqual(standalone, literal.standaloneExpected);
    }
    const prepared = ports.commands.prepare("paste", doc => pasteSharedFlowClipboard(doc, at, data, ports.flow, runtime.rich.inertBody, runtime.load) ?? null, stamps, at);
    const outcome = a.session.run(prepared.command); assert.equal(outcome.kind, "applied", outcome.kind === "failed" ? String(outcome.error) : JSON.stringify(outcome));
    assert.equal(a.executed.length, 1);
    assert.equal(a.undo.length, 1);
    const operations = a.executed[0]?.operations; assert.ok(operations);
    assert.deepEqual(operations, literal.operations);
    collabState(h.b).doc.clientID = 1;
    for (const operation of operations) assert.deepEqual(executeSharedOperations(h.b, [operation], { base: readSharedRevision(h.b) }), { ok: true });
    const late = createMonitoredSharedDocument();
    assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    const c = sharedHarness(adapterReplica(late));
    try {
      for (const harness of [a, b, c]) assert.deepEqual(harness.session.read(doc => doc), literal.expected);
      assertReplicasAgree("whole beat list and separate", [
        { order: "D1", replica: "A", output: a.session.read(doc => doc) },
        { order: "D2", replica: "B", output: b.session.read(doc => doc) },
        { order: "late-C", replica: "C", output: c.session.read(doc => doc) }
      ]);
    } finally { c.session.dispose(); destroySharedDocument(late); }
    if (literal.selection) assert.deepEqual(prepared.result() && (prepared.result() as { selection: unknown }).selection, literal.selection);
  } finally { a.session.dispose(); b.session.dispose(); runtime.close(); h.close(); }
});

const extended: readonly { readonly name: string; readonly source?: Record<string, unknown>; readonly rows: readonly Record<string, unknown>[];
  readonly headers?: readonly unknown[]; readonly records?: Record<string, unknown>; readonly range?: FlowRange; readonly cut?: boolean;
  readonly kinds: readonly string[]; readonly refused?: string; readonly expected: Record<string, unknown>; readonly standaloneExpected?: Record<string, unknown> }[] = [
  { name: "heading only", rows: [], headers: [{ index: 0, scene: { name: "Scene" } }], kinds: ["segment-create", "remove", "segment-create", "heading-finalize"],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow("R2", "B")], { sections: [{ id: "structure_1_00770031005f0031005f006f005f0033_heading_0", name: "Scene", firstSceneId: "R2" }] }),
    standaloneExpected: expectedDocument([expectedRow("R1", "A"), expectedRow("R2", "B")], { sections: [{ id: "new3", name: "Scene", firstSceneId: "R2" }] }) },
  { name: "cross-beat selection", source: { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }] }, rows: [{ id: "old", audioText: "X" }],
    range: { anchor: beatPos("R1", 1), head: beatPos("R2", 2) }, kinds: ["text-delete", "text-delete", "segment-create", "scalar", "scalar", "scalar"],
    expected: expectedDocument([expectedRow("R1", "a", changed), expectedRow(firstOfTwo, "X", changed), expectedRow("R2", "f", changed)]) },
  { name: "empty script", source: { rows: [{ id: "R1", audioText: "" }] }, rows: [{ id: "old", audioText: "X" }], range: caretAt(beatPos("R1", 0)), kinds: ["segment-create", "scalar", "scalar"],
    expected: expectedDocument([expectedRow(pasted, "X", { ...changed, paragraphStart: true }), expectedRow("R1", "", { paragraphStart: true })]) },
  { name: "heading in middle", rows: [{ id: "old", audioText: "X" }, { id: "old2", audioText: "Y" }], headers: [{ index: 1, scene: { name: "Middle" } }],
    kinds: ["segment-create", "segment-create", "segment-create", "heading-finalize", "scalar", "scalar"],
    expected: expectedDocument([expectedRow("R1", "A"), expectedRow(firstOfTwo, "X", changed), expectedRow(pasted, "Y", changed), expectedRow("R2", "B")], {
      sections: [{ id: "structure_1_00770031005f0031005f006f005f0034_heading_0", name: "Middle", firstSceneId: pasted }] }) },
  { name: "cut from same document", rows: [{ id: "cutR", audioText: "Cut" }], cut: true, records: { cut: "reviewCut", source: { docId: "d00000000000000000000000000000000", title: "" } },
    kinds: [], refused: "move-in-shared-session", expected: expectedDocument([expectedRow("R1", "A"), expectedRow("R2", "B")]) }
];

for (const literal of extended) test("shared paste review literal: " + literal.name, () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }], ...literal.source });
  const runtime = clipboardRuntime(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
    const ports = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1", handle: () => h.a });
    if (literal.cut) setLiveCut("reviewCut", "d00000000000000000000000000000000");
    const before = encodeSharedState(h.a), data = wire(literal.rows, literal.records, literal.headers), range = literal.range ?? at;
    if (literal.standaloneExpected) {
      const standalone = runtime.load({ schema: 2, docId: "d00000000000000000000000000000000", rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }] });
      const command = standaloneFlowCommand("paste", () => pasteFlowClipboard(standalone, range, data, runtime.ports, runtime.rich.inertBody, runtime.load) ?? null, stamps, range);
      const plan = command.plan(standalone, createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) }));
      assert.ok(plan && !("refused" in plan)); plan.apply(standalone);
      assert.deepEqual(standalone, literal.standaloneExpected);
    }
    const prepared = ports.commands.prepare("paste", doc => pasteSharedFlowClipboard(doc, range, data, ports.flow, runtime.rich.inertBody, runtime.load) ?? null, stamps, range);
    const outcome = a.session.run(prepared.command);
    if (literal.refused) { assert.deepEqual(outcome, { kind: "rejected", reason: literal.refused }); assert.deepEqual(encodeSharedState(h.a), before); }
    else assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    assert.equal(a.executed.length, literal.refused ? 0 : 1); assert.equal(a.undo.length, literal.refused ? 0 : 1);
    const operations = a.executed[0]?.operations ?? [];
    assert.deepEqual(operations.map(op => op.kind), literal.kinds);
    collabState(h.b).doc.clientID = 1;
    for (const op of operations) assert.deepEqual(executeSharedOperations(h.b, [op], { base: readSharedRevision(h.b) }), { ok: true });
    const late = createMonitoredSharedDocument(); assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    const c = sharedHarness(adapterReplica(late));
    try {
      for (const harness of [a, b, c]) assert.deepEqual(harness.session.read(doc => doc), literal.expected);
      assertReplicasAgree(literal.name, [{ order: "D1", replica: "A", output: a.session.read(doc => doc) }, { order: "D2", replica: "B", output: b.session.read(doc => doc) }, { order: "late-C", replica: "C", output: c.session.read(doc => doc) }]);
    } finally { c.session.dispose(); destroySharedDocument(late); }
  } finally { a.session.dispose(); b.session.dispose(); runtime.close(); h.close(); }
});

for (const refused of [
  { name: "embedded image", row: { visualImage: "data:image/png;base64,AA==" }, records: {}, reason: "paste-gallery-legacy-image" },
  { name: "embedded secondary picture", row: { moreImages: [{ visualImage: "data:image/png;base64,AA==" }] }, records: {}, reason: "paste-gallery-legacy-image" },
  { name: "local gallery file", row: { imageLinks: [{ location: { kind: "bundled", name: "clip.mov" }, name: "clip.mov", size: 1 }] }, records: {}, reason: "paste-gallery-local-file" },
  { name: "gallery file without size", row: { imageLinks: [{ name: "clip.mov" }] }, records: {}, reason: "paste-gallery-fields-unavailable" },
  { name: "foreign comment author", row: {}, records: { comments: [{ id: "C", rowId: "old", field: "audioText", body: "Note", author: "Bob" }] }, reason: "paste-comments-foreign-author" },
  { name: "foreign reply author", row: {}, records: { comments: [{ id: "C", rowId: "old", field: "audioText", body: "Note", author: "Alice", replies: [{ id: "r", body: "Reply", author: "Bob" }] }] }, reason: "paste-replies-foreign-author" }
]) test("whole paste stays atomic when refused: " + refused.name, () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }] });
  const runtime = clipboardRuntime(), a = sharedHarness(adapterReplica(h.a));
  try {
    registerSharedOperationFamilies(h.a, { cells: runtime.cells });
    const ports = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1", handle: () => h.a });
    const data = wire([{ id: "old", audioText: "X", ...refused.row }], refused.records), before = encodeSharedState(h.a);
    const prepared = ports.commands.prepare("paste", doc => pasteSharedFlowClipboard(doc, at, data, ports.flow, runtime.rich.inertBody, runtime.load) ?? null, stamps, at);
    assert.deepEqual(a.session.run(prepared.command), { kind: "rejected", reason: refused.reason });
    assert.deepEqual(a.executed, []); assert.deepEqual(a.undo, []); assert.deepEqual(encodeSharedState(h.a), before);
    assert.deepEqual(a.session.read(doc => doc), expectedDocument([expectedRow("R1", "A"), expectedRow("R2", "B")]));
  } finally { a.session.dispose(); runtime.close(); h.close(); }
});

test("one whole paste is one command and undo step; rule 71: its creation undo, not supported yet, is skipped", () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }] });
  const runtime = clipboardRuntime(); let executions = 0;
  const undo = createSharedUndo({ now: () => 0, supports: supportsSharedUndoPart,
    reverse: record => reverseSharedUndoRecord(h.a, record, { by: "Alice", nextId: () => "undo" }) });
  const replica = adapterReplica(h.a);
  const a = sharedHarness({ ...replica, execute: (operations, options) => {
    let result: ReturnType<typeof executeSharedCommand>["result"] = { ok: true };
    undo.perform(() => { executions++; const execution = executeSharedCommand(h.a, operations, { label: "paste", selection: null, typing: null }, options); result = execution.result; return execution.record; });
    return result;
  } });
  try {
    registerSharedOperationFamilies(h.a, { cells: runtime.cells });
    const ports = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1", handle: () => h.a });
    const data = wire([{ id: "old", audioText: "X", imageRef: image }]);
    const prepared = ports.commands.prepare("paste", doc => pasteSharedFlowClipboard(doc, at, data, ports.flow, runtime.rich.inertBody, runtime.load) ?? null, stamps, at);
    assert.equal(a.session.run(prepared.command).kind, "applied");
    assert.equal(executions, 1); assert.deepEqual(undo.sizes(), { undo: 1, redo: 0, dropped: 0 });
    assert.deepEqual(undo.undo(), { ok: false, reason: "undo-unsupported:segment-create", skipped: true });
  } finally { a.session.dispose(); runtime.close(); h.close(); }
});

test("whole-beat paste inside narration resolves observed units before separate execution and caret restoration", () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "AB" }, { id: "R2", audioText: "B" }] });
  const runtime = clipboardRuntime(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
    const ports = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1", handle: () => h.a });
    const data = wire([{ id: "old", audioText: "X" }]);
    const prepared = ports.commands.prepare("paste", doc => pasteSharedFlowClipboard(doc, at, data, ports.flow, runtime.rich.inertBody, runtime.load) ?? null, stamps, at);
    const outcome = a.session.run(prepared.command); assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
    const operations = a.executed[0]?.operations; assert.ok(operations);
    assert.deepEqual(operations.map(op => op.kind), ["split", "segment-create", "scalar", "scalar", "scalar"]);
    const split = operations[0]; assert.ok(split?.kind === "split");
    assert.equal(split.observed.length, 2); assert.ok(split.observed.every(reference => !reference.startsWith('["flow-base",')));
    collabState(h.b).doc.clientID = 1;
    for (const operation of operations) assert.deepEqual(executeSharedOperations(h.b, [operation], { base: readSharedRevision(h.b) }), { ok: true });
    const inserted = "structure_1_00770031005f0031005f006f005f0031_beat_0";
    const expected = expectedDocument([expectedRow("R1", "A", changed), expectedRow(inserted, "X", changed), expectedRow(pasted, "B", changed), expectedRow("R2", "B")]);
    assert.deepEqual(a.session.read(doc => doc), expected); assert.deepEqual(b.session.read(doc => doc), expected);
    const result = prepared.result(); assert.ok(result && "rows" in result);
    assert.deepEqual(result.selection, { anchor: { kind: "beat", rowId: inserted, offset: 0 }, head: { kind: "beat", rowId: inserted, offset: 1 } });
    assert.deepEqual(a.undo[0]?.selection?.after, result.selection);
  } finally { a.session.dispose(); b.session.dispose(); runtime.close(); h.close(); }
});

test("a shared clipboard move keeps the rule 92 refusal", () => {
  const runtime = clipboardRuntime(), doc = runtime.load({ docId: "d00000000000000000000000000000000", rows: [{ id: "R1", audioText: "A" }] });
  try {
    setLiveCut("cut1", doc.docId);
    const data = wire([{ id: "old", audioText: "X" }], { cut: "cut1", source: { docId: doc.docId, title: "" } });
    assert.deepEqual(pasteSharedFlowClipboard(doc, at, data, runtime.ports, runtime.rich.inertBody, runtime.load), { refused: "move-in-shared-session" });
  } finally { runtime.close(); }
});

test("seeded whole-beat paste races preserve literal complete documents in both orders and an encoded late joiner", () => {
  const secondPaste = "structure_2_00770032005f0031005f006f005f0030_beat_0";
  const races = [
    { name: "neighbour typing", expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, "X", changed), expectedRow("R2", "BZ", { ...changed, updatedBy: "Bob" })]) },
    { name: "removal of pasted-after beat", expected: expectedDocument([expectedRow(pasted, "X", changed), expectedRow("R2", "B")]) },
    { name: "same new owned tag and person", expected: expectedDocument([expectedRow("R1", "A"), expectedRow(pasted, tagHtml, changed), expectedRow(secondPaste, tagHtml, { ...changed, updatedBy: "Bob" }), expectedRow("R2", "B")], {
      people: [{ id: "person_007000610074", name: "Pat" }], productionTags: [{ id: cup, cat: "prop", name: "Cup", owner: "person_007000610074", notes: "", status: "needed" }] }) }
  ];
  let seed = 880096;
  for (let history = 0; history < 24; history++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const raceIndex = history % races.length, race = races[raceIndex]; assert.ok(race);
    for (const order of ["D1", "D2"] as const) {
      const h = replicas(2, { rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "B" }] });
      const runtime = clipboardRuntime(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
      try {
        for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
        const pa = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1", handle: () => h.a });
        const pb = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => h.b, name: () => "Bob" }), writer: () => "2", handle: () => h.b });
        const data = raceIndex === 2 ? wire([{ id: "old", audioText: tagHtml }], { people: [{ id: "P", name: "Pat" }], productionTags: [{ id: "t_old", cat: "prop", name: "Cup", owner: "P" }] }) : wire([{ id: "old", audioText: "X" }]);
        assert.equal(a.session.run(pa.commands.prepare("paste", doc => pasteSharedFlowClipboard(doc, at, data, pa.flow, runtime.rich.inertBody, runtime.load) ?? null, stamps, at).command).kind, "applied");
        const other = pb.commands.prepare(race.name, doc => raceIndex === 0 ? typeWithMarks(doc, beatPos("R2", 1), "Z", {}, pb.flow)
          : raceIndex === 1 ? replaceRange(doc, { anchor: beatPos("R1", 0), head: beatPos("R2", 0) }, [], pb.flow, true)
          : pasteSharedFlowClipboard(doc, at, data, pb.flow, runtime.rich.inertBody, runtime.load) ?? null,
        { ...stamps, editor: { name: () => "Bob" } });
        assert.equal(b.session.run(other.command).kind, "applied");
        h.queue.deliverFrom(order === "D1" ? "A" : "B", seed & 1 ? "dup" : "rev"); h.queue.flush(seed & 2 ? "dup" : "rev");
        const late = createMonitoredSharedDocument();
        assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
        const c = sharedHarness(adapterReplica(late));
        try {
          for (const harness of [a, b, c]) assert.deepEqual(harness.session.read(doc => doc), race.expected, race.name + ":" + history + ":" + order);
          assertReplicasAgree(race.name + ":" + history, [{ order, replica: "A", output: a.session.read(doc => doc) }, { order, replica: "B", output: b.session.read(doc => doc) }, { order: "late-C", replica: "C", output: c.session.read(doc => doc) }]);
        } finally { c.session.dispose(); destroySharedDocument(late); }
      } finally { a.session.dispose(); b.session.dispose(); runtime.close(); h.close(); }
    }
  }
});

for (const order of ["D1", "D2"] as const) test("review: two pastes at R2:2 keep one Pat and Cup's owner in " + order, () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "A" }, { id: "R2", audioText: "Target" }] });
  const runtime = clipboardRuntime(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  const where = caretAt(beatPos("R2", 2));
  const firstPaste = "structure_1_00770031005f0031005f006f005f0031_beat_0", secondPaste = "structure_2_00770032005f0031005f006f005f0031_beat_0";
  const secondTail = "structure_2_00770032005f0031005f006f005f0030_beat_0";
  try {
    for (const handle of [h.a, h.b]) registerSharedOperationFamilies(handle, { cells: runtime.cells });
    const data = wire([{ id: "old", audioText: tagHtml }], { source: { docId: "d11111111111111111111111111111111", title: "Source" },
      people: [{ id: "P", name: "Pat" }], productionTags: [{ id: "t_old", cat: "prop", name: "Cup", owner: "P" }] });
    for (const [handle, harness, name, writer] of [[h.a, a, "Alice", "1"], [h.b, b, "Bob", "2"]] as const) {
      const ports = writerFlowCommands(runtime.ports, { author: sharedAuthorPort({ handle: () => handle, name: () => name }), writer: () => writer, handle: () => handle });
      const prepared = ports.commands.prepare("paste", doc => pasteSharedFlowClipboard(doc, where, data, ports.flow, runtime.rich.inertBody, runtime.load) ?? null, { ...stamps, editor: { name: () => name } }, where);
      assert.equal(harness.session.run(prepared.command).kind, "applied");
      assert.deepEqual(harness.executed.map(entry => entry.operations.map(op => op.kind)), [["record-create", "record-create", "split", "segment-create", "scalar", "scalar", "scalar"]]);
    }
    h.queue.deliverFrom(order === "D1" ? "A" : "B", "dup"); h.queue.flush("rev");
    const late = createMonitoredSharedDocument(); assert.equal(applySharedUpdate(late, encodeSharedState(h.a)).ok, true);
    const c = sharedHarness(adapterReplica(late));
    const expected = expectedDocument([expectedRow("R1", "A"), expectedRow("R2", "Ta", { ...changed, updatedBy: "Bob" }), expectedRow(firstPaste, tagHtml, changed),
      expectedRow(pasted, "", changed), expectedRow(secondPaste, tagHtml, { ...changed, updatedBy: "Bob" }), expectedRow(secondTail, "rget", { ...changed, updatedBy: "Bob" })], {
      people: [{ id: "person_007000610074", name: "Pat" }], productionTags: [{ id: cup, cat: "prop", name: "Cup", owner: "person_007000610074", notes: "", status: "needed" }] });
    try {
      for (const harness of [a, b, c]) assert.deepEqual(harness.session.read(doc => doc), expected);
      assertReplicasAgree("owned Pat race", [{ order, replica: "A", output: a.session.read(doc => doc) }, { order, replica: "B", output: b.session.read(doc => doc) }, { order: "late-C", replica: "C", output: c.session.read(doc => doc) }]);
    } finally { c.session.dispose(); destroySharedDocument(late); }
  } finally { a.session.dispose(); b.session.dispose(); runtime.close(); h.close(); }
});
