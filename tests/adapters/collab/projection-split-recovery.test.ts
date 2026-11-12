import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { splitReplicas, splitOriginal, submitProjectionOperations, splitCommand } from "./projection-split-support.ts";
import { agree, operation, ref } from "./executor-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument, encodeSharedState, encodeSharedStateVector, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { readPureMergedProjection, literalMergedDocument, mergedProjectionSave } from "./projection-merged-support.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import type { SharedStoredMarkValue } from "../../../src/adapters/collab/stored-mark.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { sharedStructureSpans } from "../../../src/adapters/collab/structure-spans.ts";
import { readProjectionBlocks } from "../../../src/adapters/collab/projection-reader.ts";
import { readProjectionUnits } from "../../../src/adapters/collab/projection-text-reader.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";

function fragment(reason: string, owner: string | null, segment: string, from: number, to: number, html: string) {
  return { kind: "unprojectable-fragment", reason, owner, segment, field: "audioText", from, to, html };
}
const second = { ...splitOriginal("v"), id: "R2" };
const newRow = (audioText: string) => ({ id: "N", status: "shot", visualText: "", audioText, imageRef: null, lengthSeconds: 5 });
const scenarios = [
  { name: "missing beat", parts: [{ b: "N" }, "lost"], record: "missing", rows: [splitOriginal("a"), second],
    recovery: [fragment("missing-beat", "N", "b:R1", 2, 6, "lost")] },
  { name: "wrong-shape beat", parts: [{ b: "N" }, "lost"], record: "wrong", rows: [splitOriginal("a"), second],
    recovery: [fragment("wrong-shape-beat", "N", "b:R1", 2, 6, "lost")] },
  { name: "unowned inline beat", parts: [{ b: "N" }, "lost"], record: "unowned", rows: [splitOriginal("a"), second],
    recovery: [fragment("unowned-beat", "N", "b:R1", 2, 6, "lost")] },
  { name: "duplicate source boundary", parts: [{ b: "N" }, "b", { b: "R1" }, "c"], record: "valid", rows: [splitOriginal("a"), newRow("b"), second],
    recovery: [fragment("duplicate-boundary", "R1", "b:R1", 4, 5, "c")] },
  { name: "adjacent identical boundaries coalesce", parts: [{ b: "N" }, { b: "N" }, "t"], record: "valid", rows: [splitOriginal("a"), newRow("t"), second], recovery: [] },
  { name: "nonadjacent identical boundaries recover the later fragment", parts: [{ b: "N" }, "s", { b: "N" }, "t"], record: "valid", rows: [splitOriginal("a"), newRow("s"), second],
    recovery: [fragment("duplicate-boundary", "N", "b:R1", 4, 5, "t")] },
  { name: "foreign beat stays with its owner", parts: [{ b: "R2" }, "lost"], record: "foreign", rows: [splitOriginal("a"), second],
    recovery: [fragment("foreign-segment", "R2", "b:R1", 2, 6, "lost")] },
  { name: "second segment head cannot steal an imported beat", parts: [], record: "second-head", rows: [splitOriginal("a"), second],
    recovery: [fragment("foreign-segment", "R1", "S", 0, 4, "lost")] },
  { name: "valid stored segment beats the head fallback", parts: [], record: "explicit", rows: [second, splitOriginal("lost")],
    recovery: [fragment("foreign-segment", "R1", "b:R1", 0, 1, "a")] },
  { name: "nonexistent stored segment uses the first head", parts: [], record: "absent-segment", rows: [splitOriginal("a"), second],
    recovery: [fragment("foreign-segment", "R1", "S", 0, 4, "lost")] },
  { name: "stored segment without its beat uses the first head", parts: [], record: "wrong-segment", rows: [splitOriginal("a"), second],
    recovery: [fragment("foreign-segment", "R1", "S", 0, 4, "lost")] },
  { name: "invalid head recovers its anonymous leading text", head: null, parts: [{ b: "N" }, "b"], record: "valid", rows: [newRow("b"), second],
    recovery: [fragment("missing-boundary", null, "b:R1", 0, 1, "a")] },
  { name: "self prefix without an earlier fragment stays in recovery", parts: [{ b: "N", before: "N" }, "b"], record: "valid", rows: [splitOriginal("a"), second],
    recovery: [fragment("invalid-prefix", "N", "b:R1", 2, 3, "b")] },
  { name: "dangling prefix cannot steal a later valid fragment", parts: [{ b: "N", before: "X" }, "b", { b: "X" }, "c"], record: "valid", otherBeat: true,
    rows: [splitOriginal("a"), { ...newRow("c"), id: "X" }, second], recovery: [fragment("invalid-prefix", "X", "b:R1", 2, 3, "b")] },
  { name: "prefix followed by the source boundary recovers the later source text", parts: [{ b: "N", before: "R1" }, { b: "R1" }, "b"], record: "valid",
    rows: [newRow("a"), splitOriginal(""), second], recovery: [fragment("duplicate-boundary", "R1", "b:R1", 3, 4, "b")] },
  { name: "unreadable embed separates repeated boundaries", parts: [{ b: "N" }, { unreadable: true }, { b: "N" }, "t"], record: "valid",
    rows: [splitOriginal("a"), newRow(""), second], recovery: [fragment("duplicate-boundary", "N", "b:R1", 4, 5, "t")] },
  { name: "edit-after-damage handoff: adjacent head boundary projects ab", start: "", parts: [{ b: "R1" }, "ab"], record: "missing",
    rows: [splitOriginal("ab"), second], recovery: [] },
  { name: "stored order overrides map insertion order for head ownership", parts: [], record: "second-head", order: ["S", "b:R2", "b:R1"],
    rows: [splitOriginal("lost"), second], recovery: [fragment("foreign-segment", "R1", "b:R1", 0, 1, "a")] },
  { name: "recovery offsets count surrogate pairs as two UTF-16 units", start: "a😀", parts: [{ b: "N" }, "😀b"], record: "missing",
    rows: [splitOriginal("a😀"), second], recovery: [fragment("missing-beat", "N", "b:R1", 4, 7, "😀b")] }
];

function author(handle: Parameters<typeof collabState>[0], scenario: typeof scenarios[number]): void {
  transactSharedDocument(handle, "local-command", () => {
    const roots = collabState(handle).roots, first = roots.segments.get("b:R1"); assert.ok(first instanceof Y.Map);
    const text = first.get("text"); assert.ok(text instanceof Y.Text);
    if ("head" in scenario) first.set("head", scenario.head);
    if ("start" in scenario) { text.delete(0, text.length); if (scenario.start) text.insert(0, scenario.start); }
    for (const part of scenario.parts) { if (typeof part === "string") text.insert(text.length, part); else text.insertEmbed(text.length, part); }
    if (scenario.record === "wrong") roots.beats.set("N", { id: "N" });
    if (scenario.record === "valid" || scenario.record === "unowned") {
      const record = new Y.Map<unknown>(); roots.beats.set("N", record); record.set("id", "N"); record.set("status", "shot"); record.set("lengthSeconds", 5);
      if (scenario.record === "valid") record.set("segment", "b:R1");
    }
    if ("otherBeat" in scenario) {
      const record = new Y.Map<unknown>(); roots.beats.set("X", record); record.set("id", "X"); record.set("status", "shot");
      record.set("segment", "b:R1"); record.set("lengthSeconds", 5);
    }
    const secondBeat = roots.beats.get("R2"); assert.ok(secondBeat instanceof Y.Map);
    if (scenario.record === "foreign") secondBeat.set("segment", "b:R2");
    if (["second-head", "explicit", "absent-segment", "wrong-segment"].includes(scenario.record)) {
      const segment = new Y.Map<unknown>(); roots.segments.set("S", segment); segment.set("head", { b: "R1" });
      segment.set("text", new Y.Text("lost")); segment.set("markRecords", new Y.Map<unknown>()); roots.order.push(["S"]);
      const beat = roots.beats.get("R1"); assert.ok(beat instanceof Y.Map);
      if (scenario.record === "explicit") beat.set("segment", "S");
      if (scenario.record === "absent-segment") beat.set("segment", "absent");
      if (scenario.record === "wrong-segment") beat.set("segment", "b:R2");
    }
    if ("order" in scenario) {
      assert.deepEqual([...roots.segments.keys()], ["b:R1", "b:R2", "S"]);
      roots.order.delete(0, roots.order.length); roots.order.push(scenario.order);
      assert.deepEqual(roots.order.toArray(), ["S", "b:R2", "b:R1"]);
    }
  });
}
function check(run: ReturnType<typeof splitReplicas>, scenario: typeof scenarios[number], order: "D1" | "rev" | "dup"): void {
  run.queue.flush(order); const document = { ...literalMergedDocument(""), rows: scenario.rows };
  for (const handle of run.handles) {
    const actual = readPureMergedProjection(handle); assert.deepEqual(actual.view, { document, recovery: scenario.recovery }); assert.equal(actual.save, mergedProjectionSave(document));
  }
  agree(scenario.name, order, run.handles, handle => {
    const roots = collabState(handle).roots, prep = createSharedPreparation(handle);
    try {
      prep.view.resolveOwner("R1", "audioText");
      const expected = readProjectionBlocks(roots.order, roots.segments, roots.beats, container => readProjectionUnits(handle, container.get("text"), container.get("markRecords")))
        .filter(block => block.kind === "b" && !block.reason).map(block => ({ owner: block.id, segment: block.segment, from: block.from, to: block.to, values: block.units.map(unit => unit.value) }));
      const actual = roots.order.toArray().flatMap(segment => {
        const text = prep.view.text(["segments", segment, "text"]); if (!text) return [];
        return sharedStructureSpans(prep.view, segment, text.units).filter(span => span.field === "audioText")
          .map(span => ({ owner: span.owner, segment, from: span.from, to: span.to, values: span.positions.map(position => text.units[position]?.value) }));
      });
      assert.deepEqual(actual, expected);
      return readPureMergedProjection(handle);
    } finally { prep.close(); }
  });
}

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const native of [false, true]) for (const offset of [0, 1, 2])
  test(`edit-after-damage handoff: adjacent head boundary projects ab; type at ${offset}, ${native ? "native" : "flow"}, ${copies} copies ${order}`, () => {
    const run = splitReplicas(copies, { rows: [{ id: "R1", audioText: "" }, { id: "R2", audioText: "v" }] });
    try {
      const scenario = scenarios[16]; assert.ok(scenario); author(run.a, scenario); run.queue.flush(order);
      const right = native ? createSharedAnchor(run.b, "b:R1", offset ? offset + 1 : 0, "after") : flowBaseReference("R1", "audioText", offset); assert.ok(right);
      submitProjectionOperations(run.b, [{ kind: "text-insert", id: "damage-edit", by: "Writer", target: { owner: "R1", segment: "R1", field: "audioText" },
        at: { left: null, right, affinity: "before" }, content: [{ value: "!", marks: [] }] }]);
      const texts = ["!ab", "a!b", "ab!"], expected = texts[offset]; assert.ok(expected);
      check(run, { ...scenario, rows: [splitOriginal(expected), second] }, order);
      agree("paint after adjacent boundary", order, run.handles, handle => readSharedPaintedText(handle, { owner: ref("R1"), segment: ref("R1"), field: "audioText" })?.text, expected);
    } finally { run.close(); }
  });

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`recovered duplicate fragment retains formatting, tag, link, comment and atom: ${copies} copies ${order}`, () => {
  const scenario = scenarios[5]; assert.ok(scenario);
  const run = splitReplicas(copies, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "v" }] });
  try {
    author(run.a, scenario);
    transactSharedDocument(run.a, "local-command", () => {
      const segment = collabState(run.a).roots.segments.get("b:R1"); assert.ok(segment instanceof Y.Map);
      const text = segment.get("text"); assert.ok(text instanceof Y.Text); text.insertEmbed(text.length, { w: "Ada" });
    });
    const target = { owner: ref("R1"), segment: ref("b:R1"), field: "audioText" as const };
    const marks: readonly SharedStoredMarkValue[] = [{ kind: "b", value: true }, { kind: "comment", id: ref("c"), value: ref("C1") },
      { kind: "link", id: ref("l"), value: "https://example.test/" }, { kind: "tag", id: ref("t"), value: ref("t:prop:Box") }];
    // why: Recovery projection must retain imported marks even though native editing cannot target the recovered text.
    transactSharedDocument(run.a, "hydration", () => {
      marks.forEach((mark, index) => {
        const record = prepareSharedMarkRecord(run.a, target, "fragment" + index, 4, index === 3 ? 5 : 6, { type: "add", mark });
        assert.ok(record); assert.deepEqual(writeSharedMarkRecord(run.a, target, "fragment" + index, record), { ok: true });
      });
    });
    const html = '<span class="cmt-anchor" data-cmt="C1"><a href="https://example.test/" target="_blank" rel="noopener"><span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false"><strong>t</strong></span><strong><span class="who-anchor" data-who="Ada" contenteditable="false">@Ada</span></strong></a></span>';
    check(run, { ...scenario, recovery: [fragment("duplicate-boundary", "N", "b:R1", 4, 6, html)] }, order);
  } finally { run.close(); }
});
for (const scenario of scenarios) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const)
  test(`split boundary recovery: ${scenario.name}, ${copies} copies ${order}`, () => {
    const run = splitReplicas(copies, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "v" }] });
    try { const writer = run.handles[copies - 1]; assert.ok(writer); author(writer, scenario); check(run, scenario, order); } finally { run.close(); }
  });

test("seeded malformed boundaries cover each ruling across writers, delivery orders and encoded late joiners", t => {
  let seed = 0x14556b, checkpoints = 0, commands = 0;
  const covered = new Set<string>(), declaredLimits: readonly string[] = [];
  for (let sample = 0; sample < 24; sample++) for (const order of ["D1", "rev", "dup"] as const) for (const scenario of scenarios) {
    const run = splitReplicas(3, { rows: [{ id: "R1", audioText: "a" }, { id: "R2", audioText: "v" }] });
    try {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const index = (seed >>> 16) % 3, writer = run.handles[index], typing = run.handles[(index + 1) % 3], scalar = run.handles[(index + 2) % 3];
      assert.ok(writer && typing && scalar); author(writer, scenario);
      submitProjectionOperations(typing, [{ kind: "text-insert", id: "peer", by: "Peer", target: { owner: "R2", segment: "b:R2", field: "audioText" },
        at: { left: null, right: flowBaseReference("R2", "audioText", 0), affinity: "before" }, content: [{ value: "X", marks: [] }] }]);
      submitProjectionOperations(scalar, [{ kind: "scalar", id: "peer-field", by: "Peer", target: { scope: "beat", record: "R2" }, field: "lengthSeconds", value: 8 }]);
      const rows = scenario.rows.map(row => row.id === "R2" ? { ...second, audioText: "Xv", lengthSeconds: 8 } : row);
      check(run, { ...scenario, rows }, order); commands += 3;
      covered.add(scenario.name); checkpoints++;
    } finally { run.close(); }
  }
  assert.equal(covered.size, 19); assert.equal(checkpoints, 1368); assert.equal(commands, 4104); assert.deepEqual(declaredLimits, []);
  t.diagnostic(JSON.stringify({ seeds: 24, cases: covered.size, commands, checkpoints, declaredLimits }));
});

test("entry refuses duplicate, missing/wrong-record fields and foreign-owner boundary authoring", () => {
  const run = splitReplicas(2, { rows: [{ id: "R1", audioText: "abcd" }, { id: "R2", audioText: "v" }] });
  try {
    const good = splitCommand(2), cases = [
      { name: "duplicate or adjacent repeat of an existing beat", commands: [{ ...good, beat: "R1" }], reason: "existing-identity" },
      { name: "duplicate alias in one list", commands: [good, { ...splitCommand(1), id: "again" }], reason: "existing-identity" },
      { name: "omit or replace the native beat identity", commands: [{ ...good, fields: { id: "wrong" } }], reason: "unsupported-beat-field" },
      { name: "override native segment ownership", commands: [{ ...good, fields: { segment: "b:R2" } }], reason: "unsupported-beat-field" },
      { name: "name a beat another segment owns", commands: [{ ...good, beat: "R2" }], reason: "existing-identity" },
      { name: "use a foreign source owner", commands: [{ ...good, target: { owner: "R2", segment: "b:R1", field: "audioText" } }], reason: "mismatched-target" }
    ];
    for (const scenario of cases) {
      const bytes = encodeSharedState(run.a), vector = encodeSharedStateVector(run.a), revision = readSharedRevision(run.a);
      const result = executeSharedOperations(run.a, scenario.commands.map(operation), { base: revision });
      assert.ok(!result.ok, scenario.name); assert.equal(result.reason, scenario.reason, scenario.name);
      assert.deepEqual(encodeSharedState(run.a), bytes); assert.deepEqual(encodeSharedStateVector(run.a), vector); assert.equal(readSharedRevision(run.a), revision);
    }
    submitProjectionOperations(run.a, [good]);
    const record = collabState(run.a).roots.beats.get("structure_1_006300750074_beat_0"); assert.ok(record instanceof Y.Map);
    assert.equal(record.get("id"), "structure_1_006300750074_beat_0"); assert.equal(record.get("segment"), "b:R1");
  } finally { run.close(); }
});
