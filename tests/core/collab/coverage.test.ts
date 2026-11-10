import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { sharedCommandPermission } from "../../../src/core/collab/refusals.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";
import { builderOperationCoverage, flowOperationCoverage, sharedRefusalCoverage } from "./coverage-fixture.ts";
import { operationExamples } from "./operation-examples.ts";

test("Stage 0: exported command builders cannot escape the literal 49-builder operation decision table", () => {
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
      if (builds) builders.push(exported.name);
    }
  }
  assert.equal(builders.length, 49);
  assert.deepEqual(builders.sort(), builderOperationCoverage.map(row => row[0]).sort());
  assert.deepEqual(["field-record", "text-mark", "structure"].map(group => builderOperationCoverage.filter(row => row[1] === group).length), [26, 10, 13]);
});

test("Stage 0: 24 flow operations retain the 22 known, one surface-built and one lost-intent classes", () => {
  assert.equal(new Set(flowOperationCoverage.map(row => row[0])).size, 24);
  assert.deepEqual(["known", "known-unused", "surface", "lost"].map(group => flowOperationCoverage.filter(row => row[1] === group).length), [19, 3, 1, 1]);
  assert.deepEqual(flowOperationCoverage.filter(row => row[1] === "known-unused").map(row => row[0]), ["startBeat", "moveBeats", "replaceAll"]);
});

test("the new core modules define only types and functions when loaded", () => {
  const directory = new URL("../../../src/core/collab/", import.meta.url);
  for (const file of readdirSync(directory)) {
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
  assert.deepEqual(builderOperationCoverage.filter(row => row[2] === "whole-field today, needs package 9").map(row => row[0]),
    ["titleCommand", "renameSceneCommand", "cellTextCommand"]);
});

test("MOVE rows: the pure policy refuses partial moves and cross-scene structural paste", () => {
  const first = readSharedContentRef("H1"), second = readSharedContentRef("H2");
  assert.ok(first && second);
  const cases = [
    [{ kind: "edit" }, "allowed"],
    [{ kind: "move", extent: "whole-segment" }, "allowed"],
    [{ kind: "move", extent: "part-segment" }, "partial-segment-move"],
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
  assert.deepEqual([...refused].sort(), ["cross-scene-structural-paste", "partial-segment-move"]);
  assert.deepEqual(sharedRefusalCoverage.map(row => row.refusal).sort(), [...refused].sort());
});
