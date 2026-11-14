import { test } from "node:test";
import assert from "node:assert/strict";
import * as flow from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange } from "../../../src/core/flow/flow.ts";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { writerFlowCommands } from "../../../src/bootstrap/wiring/ports/writer-flow.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { applySharedUpdate, encodeSharedState } from "../../../src/adapters/collab/document.ts";
import { replicas } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import { setVisualForRange } from "../../../src/core/flow/visual.ts";
import { replaceFlowMatches } from "../../../src/core/flow/find-replace.ts";
import { removeEmptyHeading } from "../../../src/core/flow/remove-empty-heading.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";

const stamps = { clock: { nowIso: () => "2026-11-13T12:00:00.000Z" }, editor: { name: () => "Alice" } };
const at = flow.caretAt(flow.beatPos("R1", 1));
const selected = { anchor: flow.beatPos("R1", 1), head: flow.beatPos("R1", 2) };
const insert = { kind: "text-insert", id: "w1_1:0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: null, right: '["flow-base","R1","audioText",1,1]', affinity: "before" }, content: [{ value: "Z", marks: [] }] };
const deletion = { kind: "text-delete", id: "w1_1:0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: ['["flow-base","R1","audioText",1,2]'] };
const stamp = { kind: "scalar", id: "w1_1_stamp_0:stamp", by: "Alice", target: { scope: "beat", record: "R1" }, field: "stamp", value: { at: "2026-11-13T12:00:00.000Z", by: "Alice" } };
const split = { kind: "split", id: "w1_1_o_0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" },
  at: { left: null, right: '["flow-base","R1","audioText",1,1]', affinity: "before" }, observed: ['["flow-base","R1","audioText",0,3]'], boundary: "new", beat: "new",
  fields: { visualText: "", imageRef: null, status: "todo" } };
const newStamp = { kind: "scalar", id: "w1_1_stamp_1:stamp", by: "Alice", target: { scope: "beat", record: "new" }, field: "stamp", value: { at: "2026-11-13T12:00:00.000Z", by: "Alice" } };
const createdBeat = "structure_1_00770031005f0031005f006f005f0030_beat_0";
const createdHeading = "structure_1_00770031005f0031005f006f005f0030_heading_0";

interface SharedFlowLiteral {
  readonly name: string;
  readonly run: (doc: FlowDoc, ports: FlowPorts) => FlowOutcome;
  readonly operations: readonly unknown[] | null;
  readonly text: readonly string[];
  readonly visuals?: readonly string[];
  readonly refused?: string;
  readonly stampRow?: number;
  readonly noStamp?: boolean;
  readonly source?: Record<string, unknown>;
  readonly names?: readonly string[];
  readonly selection?: FlowRange;
  readonly ids?: readonly string[];
  readonly stamped?: readonly number[];
  readonly paragraphs?: readonly number[];
  readonly sections?: readonly { readonly id: string; readonly name: string; readonly firstSceneId: string }[];
}

function literalDocument(literal: SharedFlowLiteral): Record<string, unknown> {
  const ids = literal.ids ?? ["R1", "R2"];
  const stamped = literal.stamped ?? (literal.refused || literal.noStamp ? [] : [literal.stampRow ?? 0]);
  return {
    schema: 2, title: "", docId: "d00000000000000000000000000000000",
    rows: literal.text.map((audioText, index) => ({
      id: ids[index], status: "todo", visualText: literal.visuals?.[index] ?? "", audioText, imageRef: null,
      updatedAt: stamped.includes(index) ? "2026-11-13T12:00:00.000Z" : "", updatedBy: stamped.includes(index) ? "Alice" : null,
      ...(literal.paragraphs?.includes(index) ? { paragraphStart: true } : {})
    })),
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0,
    ...(literal.sections ? { sections: literal.sections } : {})
  };
}

const cases: readonly SharedFlowLiteral[] = [
  { name: "type", run: (doc, ports) => flow.typeWithMarks(doc, at.head, "Z", {}, ports), operations: [insert, stamp], text: ["aZbc", "def"] },
  { name: "replace-selection", run: (doc, ports) => flow.replaceRange(doc, selected, [{ text: "Z", marks: {} }], ports),
    operations: [{ ...insert, at: { left: null, right: '["flow-base","R1","audioText",2,2]', affinity: "before" } }, { ...deletion, id: "w1_1:1" }, stamp], text: ["aZc", "def"] },
  { name: "identical replacement", run: (doc, ports) => flow.replaceRange(doc, selected, [{ text: "b", marks: {} }], ports),
    operations: [{ ...insert, at: { left: null, right: '["flow-base","R1","audioText",2,2]', affinity: "before" }, content: [{ value: "b", marks: [] }] },
      { ...deletion, id: "w1_1:1" }, stamp], text: ["abc", "def"] },
  { name: "cross-beat replacement", run: (doc, ports) => flow.replaceRange(doc, { anchor: flow.beatPos("R1", 1), head: flow.beatPos("R2", 2) }, [{ text: "Z", marks: {} }], ports), operations: [
    { ...insert, at: { left: '["flow-base","R1","audioText",0,0]', right: null, affinity: "after" } },
    { ...deletion, id: "w1_1:1", observed: ['["flow-base","R1","audioText",1,3]'] },
    { ...deletion, id: "w1_1:2", target: { owner: "R2", segment: "R2", field: "audioText" }, observed: ['["flow-base","R2","audioText",0,2]'] },
    stamp, { ...stamp, id: "w1_1_stamp_1:stamp", target: { scope: "beat", record: "R2" } }
  ], text: ["aZ", "f"], stamped: [0, 1] },
  { name: "delete-selection", run: (doc, ports) => flow.replaceRange(doc, selected, [], ports), operations: [deletion, stamp], text: ["ac", "def"] },
  { name: "backspace", run: (doc, ports) => flow.backspaceAt(doc, flow.beatPos("R2", 0), ports, { tick: "delete" }),
    operations: [{ ...deletion, observed: ['["flow-base","R1","audioText",2,3]'] }, stamp], text: ["ab", "def"] },
  { name: "delete", run: (doc, ports) => flow.deleteForwardAt(doc, flow.beatPos("R1", 3), ports), operations: [
    { ...deletion, target: { owner: "R2", segment: "R2", field: "audioText" }, observed: ['["flow-base","R2","audioText",0,1]'] },
    { ...stamp, target: { scope: "beat", record: "R2" } }
  ], text: ["abc", "ef"], stampRow: 1 },
  { name: "cut", run: (doc, ports) => flow.replaceRange(doc, selected, [], ports), operations: [deletion, stamp], text: ["ac", "def"] },
  { name: "paste", run: (doc, ports) => flow.pasteText(doc, at, ["Z"], ports), operations: [insert, stamp], text: ["aZbc", "def"] },
  { name: "paste with new records", run: (doc, ports) => {
    const edited = flow.pasteText(doc, at, ["Z"], ports); assert.ok(edited && "rows" in edited);
    return { ...edited, clipboard: { comments: [], people: [{ id: "person", name: "Crew" }], productionTags: [], brollShots: [] } };
  }, operations: null, text: ["abc", "def"], refused: "flow-clipboard-records-unavailable" },
  { name: "format", run: (doc, ports) => flow.setMarkAcross(doc, selected, "b", ports), operations: [
    { kind: "mark", id: "w1_1:0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: ['["flow-base","R1","audioText",1,2]'], mark: { kind: "b", value: true } }, stamp
  ], text: ["a<strong>b</strong>c", "def"] },
  { name: "line-break", run: (doc, ports) => flow.lineBreakAt(doc, at, ports), operations: [
    { ...insert, content: [{ value: "\n", marks: [] }] }, stamp
  ], text: ["a<br>bc", "def"] },
  { name: "writer-find-replace", run: (doc, ports) => replaceFlowMatches(doc, [{ kind: "narration", range: selected }], "Z", ports),
    operations: [{ ...insert, at: { left: null, right: '["flow-base","R1","audioText",2,2]', affinity: "before" } }, { ...deletion, id: "w1_1:1" }, stamp], text: ["aZc", "def"] },
  { name: "enter", run: (doc, ports) => flow.enterAt(doc, at, ports), operations: [split, stamp, newStamp], text: ["a", "bc", "def"], ids: ["R1", createdBeat, "R2"], stamped: [0, 1],
    selection: { anchor: { kind: "beat", rowId: "structure_1_00770031005f0031005f006f005f0030_beat_0", offset: 0 }, head: { kind: "beat", rowId: "structure_1_00770031005f0031005f006f005f0030_beat_0", offset: 0 } } },
  { name: "start-beat", run: (doc, ports) => flow.startBeat(doc, at.head, ports), operations: [split, stamp, newStamp], text: ["a", "bc", "def"], ids: ["R1", createdBeat, "R2"], stamped: [0, 1] },
  { name: "start-paragraph", run: (doc, ports) => flow.startParagraph(doc, at.head, ports), operations: [
    { ...split, fields: { ...split.fields, paragraphStart: true } }, stamp, newStamp
  ], text: ["a", "bc", "def"], ids: ["R1", createdBeat, "R2"], stamped: [0, 1], paragraphs: [1] },
  { name: "own-beat", run: (doc, ports) => flow.selectionToOwnBeat(doc, { anchor: flow.beatPos("R1", 1), head: flow.beatPos("R1", 3) }, ports),
    operations: [split, stamp, newStamp], text: ["a", "bc", "def"], ids: ["R1", createdBeat, "R2"], stamped: [0, 1] },
  { name: "join", run: (doc, ports) => flow.joinWithPrevious(doc, "R2", ports), operations: [
    { kind: "join", id: "w1_1_o_0", by: "Alice", from: "R2", into: "R1", glue: " " }, stamp
  ], text: ["abc def"], ids: ["R1"] },
  { name: "visual-selection", run: (doc, ports) => setVisualForRange(doc, at, "Z", ports), operations: [
    { kind: "text-insert", id: "w1_1:0", by: "Alice", target: { owner: "R1", segment: "R1", field: "visualText" }, at: { left: null, right: '["flow-base","R1","visualText",0,0]', affinity: "before" },
      content: [{ value: "Z", marks: [] }] }, stamp
  ], text: ["abc", "def"], visuals: ["Z", ""] },
  { name: "make-heading", source: { rows: [{ id: "R1", audioText: "# X<br>abc" }, { id: "R2", audioText: "def" }] },
    run: (doc, ports) => flow.finalizeHeading(doc, "R1", null, flow.caretAt(flow.beatPos("R1", 3)), ports), operations: [
      { kind: "heading-finalize", id: "w1_1_o_0", by: "Alice", target: { owner: "R1", segment: "R1", field: "audioText" }, heading: "new",
        prefix: ['["flow-base","R1","audioText",0,2]'], name: ['["flow-base","R1","audioText",2,3]'], separator: ['["flow-base","R1","audioText",3,4]'],
        tail: { left: null, right: '["flow-base","R1","audioText",4,4]', affinity: "before" }, retainedBeat: "R1", emptyBeat: null }, stamp
    ], text: ["abc", "def"], names: ["X"], sections: [{ id: createdHeading, name: "X", firstSceneId: "R1" }], selection: {
      anchor: { kind: "heading", sceneId: "structure_1_00770031005f0031005f006f005f0030_heading_0", offset: 1 },
      head: { kind: "heading", sceneId: "structure_1_00770031005f0031005f006f005f0030_heading_0", offset: 1 }
    } },
  { name: "enter-heading", source: { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] },
    run: (doc, ports) => flow.enterInHeading(doc, flow.headingPos("H1", 2), ports), operations: [
      { ...split, target: { owner: "H1", segment: "H1", field: "heading" }, at: { left: null, right: '["flow-base","H1","heading",2,2]', affinity: "before" }, observed: ['["flow-base","H1","heading",0,5]'] },
      { kind: "scalar", id: "w1_1:1", by: "Alice", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true },
      { kind: "scalar", id: "w1_1:2", by: "Alice", target: { scope: "heading", record: "H1" }, field: "firstSceneId", value: "new" },
      { ...stamp, target: { scope: "beat", record: "new" } }
    ], text: ["ene", "abc", "def"], names: ["Sc"], ids: [createdBeat, "R1", "R2"], paragraphs: [1], sections: [{ id: "H1", name: "Sc", firstSceneId: createdBeat }] },
  { name: "remove-empty-heading", source: { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }], sections: [{ id: "H1", name: "X", firstSceneId: "R1" }] },
    run: (doc, ports) => removeEmptyHeading(doc, "H1", null, "below", ports), operations: [
      { kind: "heading-remove", id: "w1_1_o_0", by: "Alice", heading: "H1", observed: ['["flow-base","H1","heading",0,1]'], newBeat: null, nextBeat: null },
      { kind: "scalar", id: "w1_1:1", by: "Alice", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true }
    ], text: ["abc", "def"], names: [], noStamp: true, paragraphs: [0] },
  { name: "move", run: (doc, ports) => flow.moveBeats(doc, ["R2"], flow.beatPos("R1", 0), ports), operations: [
    { kind: "segment-move", id: "w1_1:0", by: "Alice", segments: ["R2"], observedOrder: ["R1", "R2"], at: { left: null, right: "R1", affinity: "before" } },
    { kind: "scalar", id: "w1_1:1", by: "Alice", target: { scope: "beat", record: "R2" }, field: "paragraphStart", value: true },
    { kind: "scalar", id: "w1_1:2", by: "Alice", target: { scope: "beat", record: "R1" }, field: "paragraphStart", value: true }
  ], text: ["abc", "def"], refused: "move-in-shared-session" },
  { name: "rename-scene", source: { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] },
    run: doc => flow.renameHeading(doc, "H1", "New", 3), operations: null, text: ["abc", "def"], names: ["Scene"], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }], refused: "flow-operations-unavailable" },
  { name: "inline-markdown", source: { rows: [{ id: "R1", audioText: "**b**" }, { id: "R2", audioText: "def" }] }, run: (doc, ports) => {
    const converted = flow.inlineMarkdown(ports.cells(doc.rows[0]?.audioText), 5); assert.ok(converted);
    return { rows: doc.rows.map(row => row.id === "R1" ? { ...row, audioText: toHtml(converted.cell) } : row),
      sections: undefined, removedComments: [], selection: flow.caretAt(flow.beatPos("R1", converted.caret)) };
  }, operations: null, text: ["**b**", "def"], refused: "flow-operations-unavailable" }
];

for (const literal of cases) test(`shared flow command literal: ${literal.name}`, () => {
  const h = replicas(2, literal.source ?? { rows: [{ id: "R1", audioText: "abc" }, { id: "R2", audioText: "def" }] });
  const a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    registerSharedOperationFamilies(h.a, { cells: createFlowLoadRuntime().cells });
    const ports = writerFlowCommands({ cells: createFlowLoadRuntime().cells, newId: () => "new", hasVisual: () => false },
      { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1" });
    const prepared = ports.commands.prepare(literal.name, doc => literal.run(doc, ports.flow), stamps, at);
    const before = encodeSharedState(h.a);
    const outcome = a.session.run(prepared.command);
    assert.deepEqual(literal.refused ? outcome : outcome.kind, literal.refused ? { kind: "rejected", reason: literal.refused } : "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), literal.operations === null ? [] : [literal.operations]);
    if (literal.refused) assert.deepEqual(encodeSharedState(h.a), before);
    if (literal.selection) {
      const result = prepared.result(); assert.ok(result && "selection" in result);
      assert.deepEqual(result.selection, literal.selection);
      assert.deepEqual(a.undo.at(-1)?.selection?.after, literal.selection);
    }
    assert.equal(applySharedUpdate(h.b, encodeSharedState(h.a)).ok, true);
    assert.equal(applySharedUpdate(h.c, encodeSharedState(h.a)).ok, true);
    const late = sharedHarness(adapterReplica(h.c));
    try {
      assertReplicasAgree(literal.name, [
        { order: "D1", replica: "A", output: a.session.read(doc => doc) },
        { order: "D1", replica: "B", output: b.session.read(doc => doc) },
        { order: "late-C", replica: "C", output: late.session.read(doc => doc) }
      ]);
    } finally { late.session.dispose(); }
    for (const session of [a.session, b.session]) session.read(doc => {
      assert.ok(doc);
      assert.deepEqual(doc, literalDocument(literal));
      assert.deepEqual(doc.rows.map(row => row.audioText), literal.text);
      if (literal.names) assert.deepEqual((doc.sections as { name: string }[] | undefined)?.map(scene => scene.name) ?? [], literal.names);
      if (literal.refused) return;
      if (literal.name === "start-paragraph") assert.equal(doc.rows[1]?.paragraphStart, true);
      const row = doc.rows[literal.stampRow ?? 0];
      assert.deepEqual([row?.updatedAt, row?.updatedBy], literal.noStamp ? ["", null] : ["2026-11-13T12:00:00.000Z", "Alice"]);
    });
  } finally { a.session.dispose(); b.session.dispose(); h.close(); }
});

test("shared flow refuses a missing operation form without applying a standalone plan", () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc" }] }), a = sharedHarness(adapterReplica(h.a));
  try {
    const command = flowCommand("missing-form", doc => flow.replaceRange(doc, selected, [], createFlowLoadRuntime().ports),
      { ...stamps, operations: { id: "command", by: "Alice" }, beatStamp: () => { throw new Error("No stamp on refusal"); } });
    assert.deepEqual(a.session.run(command), { kind: "rejected", reason: "flow-operations-unavailable" });
    assert.deepEqual(a.executed, []);
    assert.equal(a.session.read(doc => doc?.rows[0]?.audioText), "abc");
  } finally { a.session.dispose(); h.close(); }
});

test("Writer command ports give no operations request when the author answers null", () => {
  const source = createFlowLoadRuntime().ports;
  const ports = writerFlowCommands(source, { author: { next: () => null }, writer: () => { throw new Error("No writer read in standalone"); } });
  const doc: FlowDoc = { rows: [{ id: "R1", audioText: "abc" }], comments: [] };
  const prepared = ports.commands.prepare("standalone", current => {
    assert.equal(ports.flow.operations, undefined);
    const result = flow.replaceRange(current, selected, [], ports.flow);
    assert.ok(result && "rows" in result && !("ops" in result));
    return result;
  }, stamps);
  const plan = prepared.command.plan(createFlowLoadRuntime().load(doc), createSessionCapabilities("standalone", {
    edit: () => ({ allowed: true }), comment: () => ({ allowed: true })
  }));
  assert.ok(plan && !("refused" in plan));
  assert.equal(plan.shared, undefined);
  assert.equal(ports.flow.operations, undefined);
});

test("shared flow with a missing text handler refuses the whole command as unhandled-kind", () => {
  const h = replicas(2, { rows: [{ id: "R1", audioText: "abc" }] }), a = sharedHarness(adapterReplica(h.a));
  try {
    const before = encodeSharedState(h.a);
    const ports = writerFlowCommands(createFlowLoadRuntime().ports, { author: sharedAuthorPort({ handle: () => h.a, name: () => "Alice" }), writer: () => "1" });
    assert.deepEqual(a.session.run(ports.commands.prepare("type", doc => flow.typeWithMarks(doc, at.head, "Z", {}, ports.flow), stamps).command),
      { kind: "rejected", reason: "unhandled-kind" });
    assert.deepEqual(a.executed.map(entry => entry.operations), [[insert, stamp]]);
    assert.deepEqual(encodeSharedState(h.a), before);
    assert.equal(a.session.read(doc => doc?.rows[0]?.audioText), "abc");
  } finally { a.session.dispose(); h.close(); }
});
