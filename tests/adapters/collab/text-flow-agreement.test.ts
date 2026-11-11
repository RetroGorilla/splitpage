import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import * as flow from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowOutcome, FlowRow } from "../../../src/core/flow/flow.ts";
import { removeEmptyHeading } from "../../../src/core/flow/remove-empty-heading.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { cellLength, projection } from "../../../src/core/text/runs.ts";
import { flowOperationCoverage } from "../../core/collab/coverage-fixture.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { readFlowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { destroySharedDocument, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { sharedTextLocation } from "../../../src/adapters/collab/executor-text-plan.ts";
import { createSharedPreparation } from "../../../src/adapters/collab/prepare.ts";
import { readSharedMarkCharacters } from "../../../src/adapters/collab/mark-store.ts";
import { hasLoneSurrogate } from "../../../src/core/document/text-policy.ts";

type FlowTextAgreementCase = { readonly name: string; readonly seed: string; readonly doc: FlowDoc };
const headingLimit = "heading edits whose raw offset falls inside a surrogate pair: standalone keeps the half, shared clamps";
const headingLiterals = Object.freeze([
  { base: "😀B", deleted: "B", replaced: "\nB", inserted: "😀\nB" },
  { base: "A😀B", deleted: "AB", replaced: "A\nB", inserted: "A😀\nB" },
  { base: "AB😀B", deleted: "ABB", replaced: "AB\nB", inserted: "AB😀\nB" },
  { base: "word 😀B", deleted: "word B", replaced: "word \nB", inserted: "word 😀\nB" }
]);

test("text executor agrees with structural flow generators with exactly the declared heading limit", t => {
  const rt = createFlowLoadRuntime();
  let executed = 0, skippedStructure = 0, skippedRecords = 0, deferredText = 0, fields = 0, limitCases = 0;
  const supported = (op: SharedOperation) => op.kind === "text-insert" || op.kind === "text-delete";
  function inspect(input: FlowTextAgreementCase, outcome: FlowOutcome) {
    if (!outcome || !("rows" in outcome)) return { kinds: [], changed: false };
    const operations = outcome.ops ?? [], changing = !isDeepStrictEqual(outcome.rows, input.doc.rows)
      || !isDeepStrictEqual(outcome.sections, input.doc.sections) || outcome.removedComments.length > 0;
    const structural = operations.filter(op => !supported(op) && op.kind !== "scalar" && !op.kind.startsWith("record-") && op.kind !== "status" && op.kind !== "mark");
    skippedStructure += structural.length;
    skippedRecords += operations.filter(op => op.kind === "scalar" || op.kind.startsWith("record-") || op.kind === "status").length;
    const affected = (owner: string) => structural.some(op => op.kind === "join" ? op.from === owner || op.into === owner
      : op.kind === "remove" ? op.targets.some(target => target === owner) : op.kind === "heading-remove" ? op.heading === owner
      : "target" in op && "owner" in op.target && op.target.owner === owner);
    const textOps = operations.filter(op => supported(op) && "target" in op && "owner" in op.target && !affected(op.target.owner));
    deferredText += operations.filter(supported).length - textOps.length;
    if (!textOps.length) return { kinds: operations.map(op => op.kind), changed: changing };
    const handle = createMonitoredSharedDocument();
    try {
      hydrateSharedDocument(handle, validatedFixture({ ...input.doc })); registerSharedTextOperationHandlers(handle);
      const preparation = createSharedPreparation(handle);
      const available = textOps.filter(op => {
        if (!("target" in op) || !("field" in op.target)) return false;
        try { sharedTextLocation(preparation.view, op.target); return true; } catch { deferredText++; return false; }
      });
      preparation.close();
      assert.deepEqual(executeSharedOperations(handle, available, { base: readSharedRevision(handle) }), { ok: true }, `${input.name}/${input.seed}`);
      executed += available.length;
      const targets = new Map(available.flatMap(op => "target" in op && "field" in op.target ? [[JSON.stringify(op.target), op.target] as const] : []));
      for (const target of targets.values()) {
        const prep = createSharedPreparation(handle), located = sharedTextLocation(prep.view, target); prep.close();
        const characters = readSharedMarkCharacters(handle, located.target); assert.ok(characters);
        const actual = characters.map(char => char.value).join("");
        const section: { id: string; name: string } | undefined = (outcome.sections as { id: string; name: string }[] | undefined)?.find(candidate => candidate.id === target.owner);
        const row: FlowRow | undefined = outcome.rows.find(candidate => candidate.id === target.owner);
        const expected: string | undefined = target.field === "heading" ? section?.name : row ? projection(rt.cells(row[target.field])) : undefined;
        if (expected === undefined) { deferredText++; continue; }
        assert.ok(typeof expected === "string");
        if (actual !== expected && target.field === "heading") {
          const base = (input.doc.sections as { id: string; name: string }[] | undefined)?.find(section => section.id === target.owner)?.name;
          const literal = headingLiterals.find(item => item.base === base);
          const references = available.flatMap(op => op.kind === "text-delete" ? op.observed : op.kind === "text-insert" ? [op.at.left, op.at.right].filter((ref): ref is NonNullable<typeof ref> => ref !== null) : []);
          const cuts = (offset: number) => base !== undefined && /[\uD800-\uDBFF]/.test(base.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(base.charAt(offset));
          assert.ok(literal && hasLoneSurrogate(expected) && references.some(ref => { const span = readFlowBaseReference(ref); return span.owner === target.owner && (cuts(span.from) || cuts(span.to)); }), `${headingLimit}: unmatched ${input.name}/${input.seed}/${JSON.stringify({ base, actual, expected })}`);
          const deletes = available.some(op => op.kind === "text-delete"), inserts = available.some(op => op.kind === "text-insert");
          assert.equal(actual, inserts ? deletes ? literal.replaced : literal.inserted : literal.deleted, headingLimit);
          limitCases++;
        } else assert.equal(actual, expected, `${input.name}/${input.seed}/${target.field}`);
        fields++;
      }
    } finally { destroySharedDocument(handle); }
    return { kinds: operations.map(op => op.kind), changed: changing };
  }
  const url = new URL("../../core/flow/operations.test.ts", import.meta.url), source = readFileSync(url, "utf8");
  let driver = source.slice(source.indexOf("const rt ="), source.indexOf('\ntest("base references'));
  const first = driver.indexOf("function check("), last = driver.indexOf("function minimized(");
  assert.ok(first >= 0 && last > first);
  driver = driver.slice(0, first) + "function check(input) { return inspect(input, run(input, ports(true))); }\n" + driver.slice(last);
  driver = driver.replace("new URL(file, import.meta.url)", "new URL(file, sourceUrl)");
  driver = driver.replaceAll("export function ", "function ").replaceAll("export const ", "const ");
  const js = ts.transpileModule(driver, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const scope = { inspect, sourceUrl: url, createFlowLoadRuntime, flow, removeEmptyHeading, toHtml, cellLength, projection, flowOperationCoverage, assert, ts, readFileSync,
    test: (_name: string, run: (ctx: { diagnostic: (value: string) => void }) => void) => run({ diagnostic: () => {} }) };
  Function(...Object.keys(scope), js)(...Object.values(scope));
  assert.deepEqual({ executed, skippedStructure, skippedRecords, deferredText, fields, limitCases }, { executed: 32301, skippedStructure: 76986, skippedRecords: 19512, deferredText: 437, fields: 25206, limitCases: 33 });
  t.diagnostic(JSON.stringify({ executed, skippedStructure, skippedRecords, deferredText, fields, limits: [{ description: headingLimit, cases: limitCases }] }));
});
