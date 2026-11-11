import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import * as flow from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowRow } from "../../../src/core/flow/flow.ts";
import { setVisualForRange } from "../../../src/core/flow/visual.ts";
import { replaceFlowMatches } from "../../../src/core/flow/find-replace.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import type * as FlowOperationGenerators from "../../core/flow/operations.test.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { projection, cellLength, tagStack } from "../../../src/core/text/runs.ts";
import type { Marks, RunInput } from "../../../src/core/text/runs.ts";
import { explode } from "../../../src/core/text/edits.ts";
import { findInCell } from "../../../src/core/text/search.ts";
import { hasLoneSurrogate } from "../../../src/core/document/text-policy.ts";
import { flowOperationCoverage } from "../../core/collab/coverage-fixture.ts";
import type { SharedOperation, SharedTextAddress } from "../../../src/core/collab/operations.ts";
import { readFlowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { sharedTextLocation } from "../../../src/adapters/collab/executor-text-plan.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";

type FlowCoveredTextOperation = Extract<SharedOperation, { kind: "text-insert" | "text-delete" | "mark" }>;
const headingLimit = "heading edits whose raw offset falls inside a surrogate pair: standalone keeps the half, shared clamps";
const headingCases = Object.freeze([{ base: "😀B", prefix: "" }, { base: "A😀B", prefix: "A" }, { base: "AB😀B", prefix: "AB" }, { base: "word 😀B", prefix: "word " }]);

function expectedHeading(base: string, expected: string, operations: readonly FlowCoveredTextOperation[], owner: string): string {
  const literal = headingCases.find(item => item.base === base); assert.ok(literal && hasLoneSurrogate(expected), headingLimit);
  const references = operations.flatMap(op => op.kind === "text-insert" ? [op.at.left, op.at.right].filter((value): value is NonNullable<typeof value> => value !== null) : op.observed);
  const inside = literal.prefix.length + 1;
  assert.ok(references.map(readFlowBaseReference).some(span => span.owner === owner && span.field === "heading" && (span.from === inside || span.to === inside)), headingLimit);
  const deletion = operations.some(op => op.kind === "text-delete" && op.observed.map(readFlowBaseReference).some(span => span.owner === owner && span.from < span.to && span.from < inside + 1 && span.to > inside - 1));
  if (deletion) return expected.replace(/\p{Cs}/gu, "");
  assert.ok(expected.startsWith(literal.prefix + "\ud83d") && expected.endsWith("\ude00B"), headingLimit);
  return literal.prefix + "😀" + expected.slice(literal.prefix.length + 1, -2) + "B";
}

test("text and mark operations agree with range-flow generators and only the declared heading limit", t => {
  const rt = createFlowLoadRuntime();
  let executedText = 0, executedMarks = 0, skippedStructure = 0, skippedRecords = 0, deferredText = 0, fields = 0, unavailableFields = 0, limits = 0;
  const supported = (op: SharedOperation): op is FlowCoveredTextOperation => op.kind === "text-insert" || op.kind === "text-delete" || op.kind === "mark";
  const key = (kind: string, id: string | null, value: string | boolean) => JSON.stringify([kind, id, value]);
  function expectedMarks(marks: Marks): string[] {
    return [...Object.entries(marks).filter(([, value]) => value === true).map(([kind]) => key(kind, null, true)),
      ...(marks.cmt ?? []).map(id => key("comment", id, true)), ...tagStack(marks).map(id => key("tag", id, id)), ...(marks.href ? [key("link", marks.href, marks.href)] : [])].sort();
  }
  function inspect(input: { name: string; seed: string; doc: FlowDoc }, outcome: FlowOutcome) {
    if (!outcome || !("rows" in outcome)) return { kinds: [], changed: false };
    const operations = outcome.ops ?? [], changed = !isDeepStrictEqual(input.doc.rows, outcome.rows) || !isDeepStrictEqual(input.doc.sections, outcome.sections) || outcome.removedComments.length > 0;
    const structural = operations.filter(op => !supported(op) && op.kind !== "scalar" && op.kind !== "status" && !op.kind.startsWith("record-"));
    skippedStructure += structural.length; skippedRecords += operations.length - structural.length - operations.filter(supported).length;
    const blocked = (target: SharedTextAddress) => operations.some(op => {
      if (op.kind === "scalar") return op.target.record === target.owner && op.field === target.field;
      if (supported(op)) return false;
      if (op.kind === "join") return op.from === target.owner || op.into === target.owner;
      if (op.kind === "remove") return op.targets.includes(target.owner);
      if (op.kind === "heading-remove" || op.kind === "heading-create") return op.heading === target.owner;
      if (op.kind === "segment-create") return op.beat === target.owner;
      return "target" in op && "owner" in op.target && op.target.owner === target.owner;
    });
    const selected = operations.filter(supported).filter(op => !blocked(op.target)); deferredText += operations.filter(supported).length - selected.length;
    if (!selected.length) return { kinds: operations.map(op => op.kind), changed };
    const handle = createMonitoredSharedDocument();
    try {
      // why: The flow reads sanitized cells; the fixture migration fake otherwise preserves invalid raw tag categories.
      hydrateSharedDocument(handle, validatedFixture({ ...input.doc, rows: input.doc.rows.map(row => ({ ...row,
        audioText: toHtml(rt.cells(row.audioText)), visualText: toHtml(rt.cells(row.visualText)) })) })); registerSharedTextOperationHandlers(handle);
      const prep = createSharedPreparation(handle), available = selected.filter(op => { try { sharedTextLocation(prep.view, op.target); return true; } catch { deferredText++; return false; } }); prep.close();
      assert.deepEqual(executeSharedOperations(handle, available, { base: readSharedRevision(handle) }), { ok: true }, `${input.name}/${input.seed}/${JSON.stringify(available)}`);
      executedMarks += available.filter(op => op.kind === "mark").length; executedText += available.filter(op => op.kind !== "mark").length;
      const targets = new Map<string, SharedTextAddress>(available.map(op => [JSON.stringify(op.target), op.target]));
      for (const target of targets.values()) {
        const preparation = createSharedPreparation(handle), located = sharedTextLocation(preparation.view, target), facade = preparation.view.text(located.path); assert.ok(facade); preparation.close();
        const actual = readSharedMarkCharacters(handle, located.target); assert.ok(actual);
        const row: FlowRow | undefined = outcome.rows.find(candidate => candidate.id === target.owner);
        const section: { id: string; name: string } | undefined = (outcome.sections as { id: string; name: string }[] | undefined)?.find(candidate => candidate.id === target.owner);
        const expected: string | undefined = target.field === "heading" ? section?.name : row ? projection(rt.cells(row[target.field])) : undefined;
        if (expected === undefined) { unavailableFields++; continue; }
        const text = actual.map(char => char.value).join("");
        if (text !== expected && target.field === "heading") {
          const base = (input.doc.sections as { id: string; name: string }[] | undefined)?.find(candidate => candidate.id === target.owner)?.name; assert.ok(base !== undefined);
          assert.equal(text, expectedHeading(base, expected, available, target.owner), `${headingLimit}: ${input.name}/${input.seed}`); limits++;
        } else assert.equal(text, expected, `${input.name}/${input.seed}/${target.field}`);
        if (target.field === "heading") assert.ok(actual.every(char => char.marks.length === 0));
        else if (row) {
          const wanted: { value: string; marks: string[] }[] = explode(rt.cells(row[target.field])).map(char => ({ value: char.atom ? "\ufffc" : char.ch, marks: expectedMarks(char.atom ? char.atom.marks : char.marks) }));
          const runs: RunInput[] = [];
          let previous = "";
          actual.forEach((char, index) => {
            const marks: Marks = {}, tags: string[] = [], comments: string[] = [], links: string[] = [];
            for (const group of char.marks) {
              if (group.kind === "tag") tags.push(...group.values.map(String));
              else if (group.kind === "comment") comments.push(...group.values.map(String));
              else if (group.kind === "link") links.push(...group.values.map(String));
              else marks[group.kind] = true;
            }
            if (tags[0]) { marks.tag = tags[0]; if (tags.length > 1) marks.innerTags = tags.slice(1); }
            if (comments.length) marks.cmt = comments;
            const href = links[0]; if (href !== undefined) { assert.equal(new Set(links).size, 1); marks.href = href; }
            const value = facade.units[index]?.value, serialized = JSON.stringify(marks), last = runs.at(-1);
            if (typeof value === "string" && last && !last.atom && previous === serialized) last.text = String(last.text) + value;
            else if (typeof value === "string") runs.push({ text: value, marks });
            else {
              const atom = value as Record<string, unknown>;
              if ("w" in atom) runs.push({ atom: "who", name: atom.w, marks });
              else if ("k" in atom) runs.push({ atom: "broll", id: atom.k, text: atom.label ?? "B-ROLL", marks });
              else if ("img" in atom) runs.push({ atom: "image", ref: atom.img, marks });
              else { assert.ok("video" in atom); runs.push({ atom: "video", href: atom.video, host: atom.host, marks }); }
            }
            previous = serialized;
          });
          // why: Flow rows are read through the app sanitizer, which also removes cues outranked by tags or directions.
          const got = explode(rt.cells(toHtml(runs))).map(char => ({ value: char.atom ? "\ufffc" : char.ch, marks: expectedMarks(char.atom ? char.atom.marks : char.marks) }));
          assert.deepEqual(got, wanted, `${input.name}/${input.seed}/${target.field}: marks`);
        }
        fields++;
      }
    } finally { destroySharedDocument(handle); }
    return { kinds: operations.map(op => op.kind), changed };
  }
  const baseUrl = new URL("../../core/flow/operations.test.ts", import.meta.url), base = readFileSync(baseUrl, "utf8");
  const compile = (input: string) => ts.transpileModule(input.replaceAll("export function ", "function ").replaceAll("export const ", "const ").replace("new URL(file, import.meta.url)", "new URL(file, sourceUrl)"), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const scope = { createFlowLoadRuntime, flow, toHtml, projection, cellLength, assert, ts, readFileSync, sourceUrl: baseUrl };
  const generators = Function(...Object.keys(scope), compile(base.slice(base.indexOf("const rt ="), base.indexOf("type StructuralCase")) + "\nreturn {fixture,offsets,reference,generator};"))(...Object.values(scope)) as Pick<typeof FlowOperationGenerators, "fixture" | "offsets" | "reference" | "generator">;
  let driver = readFileSync(new URL("../../core/flow/range-operations.test.ts", import.meta.url), "utf8"); driver = driver.slice(driver.indexOf("const rt ="));
  const first = driver.indexOf("function checkRange("), last = driver.indexOf("function reducedRange("); assert.ok(first >= 0 && last > first);
  driver = driver.slice(0, first) + "function checkRange(input) { return inspect(input, runRange(input, ports(true))); }\n" + driver.slice(last);
  const inputs = { ...generators, inspect, createFlowLoadRuntime, flow, setVisualForRange, replaceFlowMatches, toHtml, cellLength, findInCell, flowOperationCoverage, assert,
    test: (_name: string, run: (ctx: { diagnostic: (value: string) => void }) => void) => run({ diagnostic: () => {} }) };
  Function(...Object.keys(inputs), compile(driver))(...Object.values(inputs));
  assert.deepEqual({ executedText, executedMarks, skippedStructure, skippedRecords, deferredText, fields, unavailableFields, limits },
    { executedText: 18508, executedMarks: 2887, skippedStructure: 25179, skippedRecords: 15685, deferredText: 9697, fields: 15509, unavailableFields: 0, limits: 98 });
  t.diagnostic(JSON.stringify({ executedText, executedMarks, skippedStructure, skippedRecords, deferredText, fields, unavailableFields, limits: [{ description: headingLimit, cases: limits }] }));
});
