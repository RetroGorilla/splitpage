import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recordProjectionReplicas, submitRecords, checkRecordProjection, plainRow } from "./projection-record-support.ts";
import { literalMergedDocument } from "./projection-merged-support.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { ref } from "./executor-support.ts";
import * as Y from "yjs";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const cases = [{ owner: "R2", field: "visualText" }, { owner: "R2", field: "audioText" }, { owner: "R1", field: "audioText" }] as const;
function marker(id: string) { return '<span class="broll-key" data-broll-id="' + id + '" contenteditable="false">B-roll:</span>'; }
function shot(id: string, name = "coast") { return { id, name, desc: "", status: "shot", reshoot: false, notes: "", owner: "", audioRef: "", location: "", props: [], origin: "list" }; }
function source(copies: number, scenario: typeof cases[number], collision: boolean) {
  return { rows: [{ id: "R1", audioText: "", visualText: marker("S1") + " coast" }, { id: "R2", audioText: "" }, ...(copies === 3 ? [{ id: "R3", audioText: "" }] : [])],
    comments: [{ id: "C1", rowId: scenario.owner, field: scenario.field, anchorId: "C1", quotedText: "coast", author: "Ada", body: "Typed comment" }],
    brollShots: [shot("S1"), ...(collision ? [shot("broll_00530031_2_0", "Reserved")] : [])] };
}
function expected(copies: number, scenario: typeof cases[number], collision: boolean, italic = false) {
  const wrap = italic ? "em" : "strong";
  const marked = (id: string) => '<span class="cmt-anchor" data-cmt="C1"><a href="https://example.test/" target="_blank" rel="noopener"><' + wrap + '>' + marker(id) + '</' + wrap + '></a></span> coast';
  const rows = [{ ...plainRow("R1", ""), status: "ready", visualText: marker("S1") + " coast", lengthSeconds: 5 }, plainRow("R2", ""), ...(copies === 3 ? [plainRow("R3", "")] : [])];
  const second = rows.find(row => row.id === scenario.owner); assert.ok(second); second[scenario.field] = marked(collision ? "broll_00530031_2_0_" : "broll_00530031_2_0");
  if (copies === 3) { const third = rows[2]; assert.ok(third); third[scenario.field] = marked("broll_00530031_3_0"); }
  return { ...literalMergedDocument(""), rows,
    comments: [{ id: "C1", rowId: scenario.owner, field: scenario.field, anchorId: "C1", quotedText: "coast", author: "Ada", body: "Typed comment", resolved: false,
      resolvedBy: null, resolvedAt: null, assignee: "", updatedAt: null, kind: "anchor", replies: [] }],
    brollShots: [shot("S1"), ...(collision ? [shot("broll_00530031_2_0", "Reserved")] : [])] };
}
function author(run: ReturnType<typeof recordProjectionReplicas>, scenario: typeof cases[number], generated = false, italic = false) {
  const kinds: string[] = [], submit = (handle: Parameters<typeof submitRecords>[0], commands: readonly { readonly kind: string; readonly [key: string]: unknown }[]) => { submitRecords(handle, commands); kinds.push(...commands.map(command => command.kind)); };
  submit(run.a, [{ kind: "scalar", id: "duration", by: "Writer", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 5 },
    { kind: "status", id: "ready", by: "Writer", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] }]);
  for (const [index, handle] of run.handles.entries()) {
    if (!index) continue;
    const owner = index === 1 ? scenario.owner : "R3", field = scenario.field, target = { owner: ref(owner), segment: ref(field === "visualText" ? owner : "b:" + owner), field };
    submit(handle, [{ kind: "text-insert", id: "key", by: "Writer", target,
      at: { left: null, right: flowBaseReference(owner, field, 0), affinity: "before" }, content: [
        { value: { atom: "broll", id: "S1", text: "B-roll:" }, marks: [...(generated ? [] : [{ kind: "b", value: true }]), { kind: "comment", id: "C1", value: true }, { kind: "link", id: "https://example.test/", value: "https://example.test/" }] },
        { value: generated ? " coastX" : " coast", marks: [] }
      ] }]);
    if (generated) {
      const mark = captureSharedTextRange(handle, target, 0, 1), deleted = captureSharedTextRange(handle, target, 7, 8); assert.ok(mark && deleted);
      submit(handle, [{ kind: "mark", id: "format", by: "Writer", target, observed: [mark], mark: { kind: italic ? "i" : "b", value: true } },
        { kind: "text-delete", id: "erase", by: "Writer", target, observed: [deleted] }]);
    }
  }
  return kinds;
}
for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const scenario of cases) for (const collision of [false, true])
  test(`duplicate b-roll keeps the first marker, derives later safe ids and creates no shot records: ${copies} ${order} ${scenario.owner}/${scenario.field} collision=${collision}`, () => {
    const run = recordProjectionReplicas(copies, source(copies, scenario, collision));
    try { author(run, scenario); checkRecordProjection(run, order, expected(copies, scenario, collision)); } finally { run.close(); }
  });

test("seeded duplicate keys retain typed words, marks and shot records across every reading copy", t => {
  let random = 0x6b54, checkpoints = 0, commands = 0;
  const kinds = new Set<string>(), declaredLimits: readonly string[] = [];
  for (let seed = 0; seed < 24; seed++) for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const scenario of cases) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0; const collision = !!(random & 1), italic = !!(random & 2);
    const run = recordProjectionReplicas(copies, source(copies, scenario, collision));
    try {
      const history = author(run, scenario, true, italic); history.forEach(kind => kinds.add(kind)); commands += history.length;
      checkRecordProjection(run, order, expected(copies, scenario, collision, italic)); checkpoints++;
    } finally { run.close(); }
  }
  assert.deepEqual([...kinds].sort(), ["mark", "scalar", "status", "text-delete", "text-insert"]);
  assert.equal(checkpoints, 432); assert.equal(commands, 2808); assert.deepEqual(declaredLimits, []);
  t.diagnostic(JSON.stringify({ seeds: 24, checkpoints, commands, kinds: [...kinds].sort(), declaredLimits }));
});

test("b-roll corpus audit: 0 of 291 reference documents have duplicate key ids", () => {
  const fixtures = (JSON.parse(readFileSync(new URL("../../collab/fixtures/projection-reference.json", import.meta.url), "utf8")) as {
    fixtures: { name: string; document: { rows: Record<string, unknown>[] } }[] }).fixtures;
  const duplicates: string[] = []; assert.equal(fixtures.length, 291);
  const cells = createFlowLoadRuntime().cells;
  for (const fixture of fixtures) {
    const seen = new Set<string>();
    for (const row of fixture.document.rows) for (const field of ["visualText", "audioText"]) for (const run of cells(String(row[field] ?? ""))) if (run.atom === "broll") {
      if (seen.has(run.id)) duplicates.push(fixture.name + "/" + String(row.id) + "/" + field); seen.add(run.id);
    }
  }
  assert.deepEqual(duplicates, []);
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`removed keys do not claim a visible b-roll identity: ${copies} ${order}`, () => {
  const original = marker("S1") + " coast", run = recordProjectionReplicas(copies, {
    rows: [{ id: "R1", audioText: "", visualText: original }, { id: "R2", audioText: "" }], brollShots: [shot("S1")] });
  try {
    submitRecords(run.b, [{ kind: "text-insert", id: "key", by: "Writer", target: { owner: "R2", segment: "R2", field: "visualText" },
      at: { left: null, right: flowBaseReference("R2", "visualText", 0), affinity: "before" },
      content: [{ value: { atom: "broll", id: "S1", text: "B-roll:" }, marks: [] }, { value: " coast", marks: [] }] }]);
    transactSharedDocument(run.a, "local-command", () => {
      const beat = collabState(run.a).roots.beats.get("R1"); assert.ok(beat instanceof Y.Map);
      const removals = beat.get("removals"); assert.ok(removals instanceof Y.Map); removals.set("removed", true);
    });
    checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: [{ ...plainRow("R2", ""), visualText: original }], brollShots: [shot("S1")] },
      [{ kind: "removed-beat", row: { ...plainRow("R1", ""), visualText: original }, members: ["R1"] }]);
  } finally { run.close(); }
});
