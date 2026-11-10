import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as flow from "../../../src/core/flow/flow.ts";
import { removeEmptyHeading } from "../../../src/core/flow/remove-empty-heading.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowPos, FlowRange, FlowRow } from "../../../src/core/flow/flow.ts";
import { createFlowLoadRuntime } from "./load.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { cellLength, projection } from "../../../src/core/text/runs.ts";
import { flowOperationCoverage } from "../collab/coverage-fixture.ts";
import { applyFlowOperations } from "./operation-applier.ts";
import { flowBaseReference, readFlowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { readOperation } from "../../../src/core/collab/read-operation.ts";

const rt = createFlowLoadRuntime(), cells = rt.ports.cells;
const sources = new Map<string, string>();
function source(file: string): string {
  if (!sources.has(file)) sources.set(file, readFileSync(new URL(file, import.meta.url), "utf8"));
  return sources.get(file) as string;
}
function generator(file: string, start: string, end: string, result: string, scope: Record<string, unknown>) {
  const input = source(file), a = input.indexOf(start), b = input.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "generator source boundaries: " + file);
  const output = ts.transpileModule(input.slice(a, b) + "\nreturn " + result, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return Function(...Object.keys(scope), output)(...Object.values(scope)) as unknown;
}
const fixture = generator("fuzz.test.ts", "function random(", "function applied(", "fixture", { cells, toHtml }) as
  (seed: number) => { doc: FlowDoc; pick: (limit: number) => number; ports: FlowPorts };
const offsets = generator("fuzz.test.ts", "function offsets(", 'test("seeded flow:', "offsets", { cells, projection }) as (row: FlowRow) => number[];
const reference = (seed: number) => generator("reference-fuzz.test.ts", "    let state = seed;", "    for (let operation", "{ doc, positions, pick }", {
  seed, cells, beatPos: flow.beatPos, headingPos: flow.headingPos,
  row: (id: string, audioText: string, visualText = "") => ({ id, audioText, visualText }),
  scene: (id: string, firstSceneId: string, name = "Title") => ({ id, firstSceneId, name }),
  marked: (word: string) => '<span class="cmt-anchor" data-cmt="quote">' + word + "</span>"
}) as { doc: FlowDoc; positions: FlowPos[]; pick: (limit: number) => number };

type StructuralCase = { name: string; seed: string; doc: FlowDoc; range: FlowRange; pos: FlowPos; tick?: "delete" | "join"; end?: number | null };
const names = ["enterAt", "startParagraph", "startBeat", "lineBreakAt", "backspaceAt", "deleteForwardAt", "joinWithPrevious", "enterInHeading", "finalizeHeading", "removeEmptyHeading"] as const;
function run(input: StructuralCase, ports: FlowPorts): FlowOutcome {
  const { name, doc, range, pos } = input, id = pos.kind === "beat" ? pos.rowId : pos.sceneId;
  switch (name) {
    case "enterAt": return flow.enterAt(doc, range, ports);
    case "startParagraph": return flow.startParagraph(doc, pos, ports);
    case "startBeat": return flow.startBeat(doc, pos, ports);
    case "lineBreakAt": return flow.lineBreakAt(doc, range, ports);
    case "backspaceAt": return flow.backspaceAt(doc, pos, ports, { tick: input.tick ?? "delete" });
    case "deleteForwardAt": return flow.deleteForwardAt(doc, pos, ports);
    case "joinWithPrevious": return flow.joinWithPrevious(doc, id, ports);
    case "enterInHeading": return flow.enterInHeading(doc, pos, ports);
    case "finalizeHeading": return flow.finalizeHeading(doc, id, input.end ?? null, range, ports);
    case "removeEmptyHeading": return removeEmptyHeading(doc, id, range, ["above", "below", "keep"][Number(input.seed.replace(/\D/g, "")) % 3] as "above", ports);
    default: throw new Error(name);
  }
}
function ports(record: boolean): FlowPorts {
  let next = 0;
  return { cells, hasVisual: rt.ports.hasVisual, newId: () => "minted" + ++next,
    ...(record ? { operations: { id: "command", by: "Writer" } } : {}) };
}
function check(input: StructuralCase): readonly string[] {
  const base = structuredClone(input.doc), before = structuredClone(base);
  const plain = run({ ...input, doc: base }, ports(false)), described = run({ ...input, doc: base }, ports(true));
  assert.deepEqual(base, before, "input mutation");
  if (!described || !("rows" in described)) { assert.deepEqual(described, plain); return []; }
  const { ops, ...withoutOps } = described;
  assert.ok(ops);
  assert.ok(!plain || !("ops" in plain), "off path has no operations field");
  assert.deepEqual(withoutOps, plain, "operation recording changes standalone result");
  assert.equal(new Set(ops.map(op => op.id)).size, ops.length, "operation ids must be distinct within a command");
  for (const op of ops) assert.ok(readOperation(JSON.parse(JSON.stringify(op)) as unknown), "invalid wire operation " + op.kind);
  const applied = applyFlowOperations(base, ops, cells);
  assert.deepEqual(base, before, "reference applier mutates the base");
  assert.deepEqual(applied, { rows: described.rows, sections: described.sections, removedComments: described.removedComments });
  return ops.map(op => op.kind);
}
function minimized(input: StructuralCase): StructuralCase {
  let current = structuredClone(input);
  const fails = (candidate: StructuralCase) => {
    const positions = [candidate.pos, candidate.range.anchor, candidate.range.head];
    if (!positions.every(pos => pos.kind === "beat" ? candidate.doc.rows.some(row => row.id === pos.rowId)
      : Array.isArray(candidate.doc.sections) && candidate.doc.sections.some((scene: { id: string }) => scene.id === pos.sceneId))) return false;
    try { check(candidate); return false; } catch { return true; }
  };
  for (const row of input.doc.rows) {
    const doc = { ...current.doc, rows: current.doc.rows.filter(item => item.id !== row.id),
      sections: Array.isArray(current.doc.sections) ? current.doc.sections.filter((scene: { firstSceneId: string }) => scene.firstSceneId !== row.id) : undefined };
    const next = { ...current, doc };
    if (doc.rows.length && fails(next)) current = next;
  }
  for (const comment of input.doc.comments) {
    const next = { ...current, doc: { ...current.doc, comments: current.doc.comments.filter(item => item.id !== comment.id) } };
    if (fails(next)) current = next;
  }
  return current;
}

test("structural flow operations reproduce exact rows, sections and comment removals over the retained generators", t => {
  const kinds = new Map(names.map(name => [name, new Set<string>()])), counts = new Map(names.map(name => [name, 0]));
  function exercise(doc: FlowDoc, positions: FlowPos[], range: FlowRange, seed: string): void {
    for (const name of names) for (const pos of positions) for (const tick of name === "backspaceAt" ? ["delete", "join"] as const : ["delete"] as const) {
      const input = { name, doc, pos, range: name === "enterAt" || name === "lineBreakAt" ? range : flow.caretAt(pos), seed, tick };
      try {
        for (const kind of check(input)) kinds.get(name)?.add(kind);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      } catch (cause) { throw new Error("seed=" + seed + " row=" + name + " minimized=" + JSON.stringify(minimized(input)), { cause }); }
    }
  }
  for (let seed = 1; seed <= 240; seed++) {
    const { doc, pick } = fixture(seed), a = pick(doc.rows.length), b = a + pick(doc.rows.length - a);
    const first = doc.rows[a] as FlowRow, last = doc.rows[b] as FlowRow, starts = offsets(first), from = starts[pick(starts.length)] as number;
    const ends = offsets(last).filter(offset => a !== b || offset >= from), to = ends[pick(ends.length)] as number;
    const range = pick(2) ? { anchor: flow.beatPos(first.id, from), head: flow.beatPos(last.id, to) } : { anchor: flow.beatPos(last.id, to), head: flow.beatPos(first.id, from) };
    exercise(doc, doc.rows.flatMap(row => [0, Math.floor(cellLength(cells(row.audioText)) / 2), cellLength(cells(row.audioText))].map(offset => flow.beatPos(row.id, offset))), range, "fuzz:" + seed);
  }
  for (let seed = 1; seed <= 300; seed++) {
    const { doc, positions, pick } = reference(seed);
    for (let operation = 0; operation < 6; operation++) {
      const range = { anchor: positions[pick(positions.length)] as FlowPos, head: positions[pick(positions.length)] as FlowPos };
      exercise(doc, operation ? [positions[operation % positions.length] as FlowPos] : positions, range, "reference:" + seed + ":" + operation);
    }
  }
  for (let seed = 1; seed <= 160; seed++) {
    const heading = ["# Title", "#  Title  \nTail", "# ", "# <strong>Title</strong>", '# <span class="cmt-anchor" data-cmt="c">Title</span>', "# " + "x".repeat(201), "# A😀B\nTail"][seed % 7] as string;
    const doc: FlowDoc = { rows: [{ id: "p", audioText: "Before" }, { id: "a", audioText: heading, paragraphStart: true, visualText: seed % 3 ? "" : "Visual" },
      ...(seed % 4 ? [{ id: "z", audioText: "After", ...(seed % 2 ? { paragraphStart: true } : {}) }] : [])],
      sections: seed % 5 ? undefined : [{ id: "s", name: "Old", firstSceneId: "a" }], comments: [] };
    exercise(doc, [flow.beatPos("a", 0), flow.headingPos("s", 0)], { anchor: flow.beatPos("a", 1), head: flow.beatPos("a", 4) }, "heading:" + seed);
    for (const end of [2, 4, 5, 8]) {
      const input = { name: "finalizeHeading", doc, pos: flow.beatPos("a", 0), range: flow.caretAt(flow.beatPos("a", end)), seed: "heading:" + seed, end };
      try { for (const kind of check(input)) kinds.get("finalizeHeading")?.add(kind); }
      catch (cause) { throw new Error("seed=" + seed + " row=finalizeHeading minimized=" + JSON.stringify(minimized(input)), { cause }); }
      counts.set("finalizeHeading", (counts.get("finalizeHeading") ?? 0) + 1);
    }
  }
  let typingSeed = 371;
  for (let i = 0; i < 160; i++) {
    typingSeed = (Math.imul(typingSeed, 1664525) + 1013904223) >>> 0;
    const generated = generator("typing-reference.test.ts", '    const text = "Narration"', "    const result = replaceRange", "{ rows, from, to }", { seed: typingSeed, beatPos: flow.beatPos }) as
      { rows: FlowRow[]; from: FlowPos; to: FlowPos };
    exercise({ rows: generated.rows, sections: [{ id: "s", name: "Scene", firstSceneId: "a" }], comments: [] }, [generated.from, generated.to],
      i % 2 ? { anchor: generated.to, head: generated.from } : { anchor: generated.from, head: generated.to }, "typing:" + typingSeed);
  }
  for (let seed = 1; seed <= 120; seed++) {
    const image = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
    const doc = generator("round-four-fuzz.test.ts", "    const mode = (seed - 1) % 6", "    const out = edited(joinWithPrevious", "doc", { seed, image, rt, covered: new Set<string>() }) as FlowDoc;
    const input = { name: "joinWithPrevious", doc, pos: flow.beatPos("b", 0), range: flow.caretAt(flow.beatPos("b", 0)), seed: "gallery:" + seed };
    try { check(input); } catch (cause) { throw new Error("seed=" + seed + " row=joinWithPrevious minimized=" + JSON.stringify(minimized(input)), { cause }); }
    counts.set("joinWithPrevious", (counts.get("joinWithPrevious") ?? 0) + 1);
  }
  for (const name of names) {
    const row = flowOperationCoverage.find(item => item[0] === name);
    assert.ok(row, name);
    assert.deepEqual([...kinds.get(name) ?? []].sort(), row[2].split(",").sort(), "coverage row " + name);
    t.diagnostic(name + ": " + counts.get(name) + " inputs, 0 mismatches; " + [...kinds.get(name) ?? []].sort().join(","));
  }
});

test("base references distinguish UTF-16 spans, repeated words, fields and hostile ids", () => {
  for (const owner of ["beat", '["flow-base",0]', "a\u0000b"]) {
    const ref = flowBaseReference(owner, "audioText", 1, 3);
    assert.deepEqual(readFlowBaseReference(ref), { owner, field: "audioText", from: 1, to: 3 });
    assert.notEqual(ref, flowBaseReference(owner, "heading", 1, 3));
    assert.notEqual(ref, flowBaseReference(owner, "audioText", 3, 5));
  }
});

test("heading and beat ids may coincide without mixing their base ranges", () => {
  const doc: FlowDoc = { rows: [{ id: "a", audioText: "Repeat repeat" }, { id: "b", audioText: "Tail" }],
    sections: [{ id: "a", name: "Scene name", firstSceneId: "a" }], comments: [] };
  const range = { anchor: flow.headingPos("a", 3), head: flow.beatPos("a", 4) };
  for (const name of ["enterAt", "lineBreakAt"]) check({ name, seed: "same-id", doc, pos: range.head, range });
});
