import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";
import { sharedCommandPermission } from "../../../src/core/collab/refusals.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";
import { builderOperationCoverage, flowOperationCoverage, sharedRefusalCoverage } from "./coverage-fixture.ts";
import { operationExamples } from "./operation-examples.ts";
import { beatPos, caretAt, moveBeats, selectionToOwnBeat } from "../../../src/core/flow/flow.ts";
import type { FlowPorts } from "../../../src/core/flow/flow.ts";

test("exported command builders and the bulk-row writer cannot escape the classified operation decision table", () => {
  const directory = new URL("../../../src/application/commands/", import.meta.url);
  const files = readdirSync(directory).filter(file => file.endsWith(".ts")).map(file => fileURLToPath(new URL(file, directory)));
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, allowJs: true, types: [] });
  const checker = program.getTypeChecker();
  const builders: string[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    assert.ok(source);
    const module = checker.getSymbolAtLocation(source);
    assert.ok(module);
    for (const exported of checker.getExportsOfModule(module)) {
      const type = checker.getTypeOfSymbolAtLocation(exported, source);
      const builds = type.getCallSignatures().some(signature => {
        const result = checker.getNonNullableType(checker.getReturnTypeOfSignature(signature));
        const wrapped = result.getProperty("command");
        return result.getProperty("plan") || wrapped && checker.getTypeOfSymbolAtLocation(wrapped, source).getProperty("plan");
      });
      if (builds || exported.name === "createBulkTagRows") builders.push(exported.name);
    }
  }
  assert.equal(builders.length, 53);
  assert.deepEqual(builders.sort(), builderOperationCoverage.map(row => row[0]).sort());
  for (const row of builderOperationCoverage) assert.ok(["serve", "serve pending composition", "refuse", "could not classify"].includes(row.shared), row[0]);
  assert.deepEqual(["field-record", "text-mark", "structure"].map(group => builderOperationCoverage.filter(row => row[1] === group).length), [26, 11, 16]);
});

test("Stage 0: 24 flow operations retain the 22 known, one surface-built and one lost-intent classes", () => {
  assert.equal(new Set(flowOperationCoverage.map(row => row[0])).size, 24);
  assert.deepEqual(["known", "known-unused", "surface", "lost"].map(group => flowOperationCoverage.filter(row => row[1] === group).length), [19, 3, 1, 1]);
  assert.deepEqual(flowOperationCoverage.filter(row => row[1] === "known-unused").map(row => row[0]), ["startBeat", "moveBeats", "replaceAll"]);
});

test("the new core modules define only types and functions when loaded", () => {
  const directory = new URL("../../../src/core/collab/", import.meta.url);
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = relative(fileURLToPath(directory), join(entry.parentPath, entry.name)).replaceAll("\\", "/");
    const source = ts.createSourceFile(file, readFileSync(new URL(file, directory), "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) assert.ok(ts.isImportDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement), `${file}: module-load work`);
  }
});

test("coverage decisions name only defined operations, the two refusals or the package 9 whole-field handoff", () => {
  const decisions = new Set<string>([...operationExamples.map(example => example.operation.kind), ...sharedRefusalCoverage.map(row => row.refusal),
    "whole-field today, needs package 9"]);
  for (const row of [...builderOperationCoverage, ...flowOperationCoverage]) {
    for (const branch of row[2].split(" | ")) {
      if (branch === "whole-field today, needs package 9") continue;
      for (const decision of branch.split(",")) assert.ok(decisions.has(decision), `${row[0]}: ${decision}`);
    }
  }
  assert.deepEqual(builderOperationCoverage.filter(row => row[2].split(" | ").includes("whole-field today, needs package 9")).map(row => row[0]),
    ["titleCommand", "renameSceneCommand", "cellTextCommand"]);
});

test("the 27 text/structure builders and 24 flow rows record their audited branches", () => {
  const builders = builderOperationCoverage.filter(row => row[1] === "text-mark" || row[1] === "structure");
  assert.equal(builders.length, 27);
  for (const row of builders) {
    assert.equal(row.length, 4, row[0]);
    if (row.length === 4) assert.ok(row[3].length > 0 && row[3].every(branch => branch[0].length > 0), row[0]);
  }
  for (const row of flowOperationCoverage) assert.ok(row[3].length > 0 && row[3].every(branch => branch[0].length > 0), row[0]);
  const paste = builderOperationCoverage.find(row => row[0] === "pasteBeatsCommand");
  assert.ok(paste);
  for (const kind of ["remove", "heading-create"]) assert.ok(paste[2].split(/[|,]/).map(value => value.trim()).includes(kind));
});

test("each audited row declares exactly the union of its literal branch requirements", context => {
  let rows = 0, branches = 0;
  for (const row of [...builderOperationCoverage, ...flowOperationCoverage]) {
    if (row.length !== 4) continue;
    const required = new Set<string>();
    for (const [branch, kinds] of row[3]) {
      assert.ok(branch.length > 0, row[0]);
      for (const kind of kinds) required.add(kind);
      branches++;
    }
    const declared = row[2].split(" | ").flatMap(part => part === "whole-field today, needs package 9" ? [part] : part.split(","));
    assert.deepEqual(declared.sort(), [...required].sort(), row[0]);
    rows++;
  }
  assert.equal(rows, 51);
  assert.equal(flowOperationCoverage.find(row => row[0] === "typeWithMarks")?.[2], "text-insert");
  assert.equal(flowOperationCoverage.find(row => row[0] === "replaceAll")?.[2], "text-insert,text-delete,heading-remove,scalar");
  context.diagnostic(`${rows} rows equal the union of ${branches} literal branch requirements`);
});

function branchPorts(): FlowPorts {
  let made = 0;
  return { cells: html => html ? [{ text: html, marks: {} }] : [], newId: () => `new${++made}`, hasVisual: row => !!row.visualText };
}

test("moving a whole source into a destination's middle requires the destination split", () => {
  const doc = { rows: [{ id: "a", audioText: "One" }, { id: "b", audioText: "Two" }, { id: "c", audioText: "Three" }, { id: "d", audioText: "Four" }], comments: [] };
  const result = moveBeats(doc, ["b"], beatPos("d", 2), branchPorts());
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => [row.id, row.audioText]), [["a", "One"], ["c", "Three"], ["d", "Fo"], ["b", "Two"], ["new1", "ur"]]);
  const coverage = flowOperationCoverage.find(row => row[0] === "moveBeats");
  assert.ok(coverage);
  for (const kind of ["segment-move", "split"]) assert.ok(coverage[2].split(/[|,]/).map(value => value.trim()).includes(kind));
});

test("prefix isolation keeps the original identity and visual on the suffix", () => {
  const doc = { rows: [{ id: "R1", audioText: "abcd", visualText: "v" }], comments: [] };
  const range = { anchor: beatPos("R1", 0), head: beatPos("R1", 2) };
  const result = selectionToOwnBeat(doc, range, branchPorts());
  assert.ok(result && "rows" in result);
  assert.deepEqual(result.rows.map(row => [row.id, row.audioText, row.visualText]), [["new1", "ab", ""], ["R1", "cd", "v"]]);
  const coverage = flowOperationCoverage.find(row => row[0] === "selectionToOwnBeat");
  assert.ok(coverage?.[2].split(",").includes("split-before"));
  assert.deepEqual(selectionToOwnBeat(doc, caretAt(beatPos("R1", 0)), branchPorts()), null);
});

test("MOVE rows: the pure policy refuses every move and cross-scene structural paste", () => {
  const first = readSharedContentRef("H1"), second = readSharedContentRef("H2");
  assert.ok(first && second);
  const cases = [
    [{ kind: "edit" }, "allowed"],
    [{ kind: "move", extent: "whole-segment" }, "move-in-shared-session"],
    [{ kind: "move", extent: "part-segment" }, "move-in-shared-session"],
    [{ kind: "structural-cut-paste", sourceScenes: [first], destinationScene: second }, "cross-scene-structural-paste"],
    [{ kind: "structural-cut-paste", sourceScenes: [first, second], destinationScene: first }, "cross-scene-structural-paste"],
    [{ kind: "structural-cut-paste", sourceScenes: [null], destinationScene: first }, "cross-scene-structural-paste"],
    [{ kind: "structural-cut-paste", sourceScenes: [first], destinationScene: first }, "allowed"],
    [{ kind: "structural-cut-paste", sourceScenes: [null], destinationScene: null }, "allowed"]
  ] as const;
  const refused = new Set<string>();
  for (const [intent, expected] of cases) {
    const before = structuredClone(intent);
    const permission = sharedCommandPermission(intent);
    assert.equal(permission, expected);
    assert.deepEqual(intent, before);
    if (permission !== "allowed") refused.add(permission);
  }
  assert.deepEqual([...refused].sort(), ["cross-scene-structural-paste", "move-in-shared-session"]);
  assert.deepEqual(sharedRefusalCoverage.map(row => row.refusal).sort(), [...refused].sort());
});
