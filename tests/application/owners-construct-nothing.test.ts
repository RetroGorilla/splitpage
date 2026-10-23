import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as operation from "../../src/application/session/operation.ts";
import * as transitionPorts from "../../src/application/transitions/ports.ts";
import * as transitions from "../../src/application/transitions/transitions.ts";
import * as recoveryPorts from "../../src/application/recovery/ports.ts";
import * as draftWriter from "../../src/application/recovery/draft-writer.ts";
import * as draftResume from "../../src/application/recovery/draft-resume.ts";
import * as conflictStash from "../../src/application/recovery/conflict-stash.ts";
import * as legacySnapshots from "../../src/application/recovery/legacy-snapshots.ts";
import * as saveCoordinator from "../../src/application/save/coordinator.ts";
import * as saveStatus from "../../src/application/save/status.ts";
import * as autoSave from "../../src/application/save/autosave.ts";
import * as saveDestinations from "../../src/application/save/destinations.ts";
import * as serverDestination from "../../src/application/save/server-destination.ts";
import * as fileConflict from "../../src/application/save/file-conflict.ts";
import * as documentSources from "../../src/application/transitions/sources.ts";
import * as stashedWork from "../../src/application/recovery/stashed-work.ts";
import * as rowDrag from "../../src/application/editing/row-drag.ts";
import * as cellEditing from "../../src/application/editing/cell-editing.ts";
import * as focusMemory from "../../src/application/editing/focus-memory.ts";
import * as paintGuard from "../../src/application/editing/paint-guard.ts";
import * as selection from "../../src/application/editing/selection.ts";
import * as deleteConfirm from "../../src/application/editing/delete-confirm.ts";
import * as productionSelection from "../../src/application/editing/production-selection.ts";
import * as mergeUndo from "../../src/application/session/merge-undo.ts";
import * as preferences from "../../src/application/preferences/preferences.ts";
import * as viewFlags from "../../src/application/preferences/view-flags.ts";
import * as panelWidths from "../../src/application/preferences/panel-widths.ts";
import * as documentLocation from "../../src/application/location/document-location.ts";
import * as serverStatus from "../../src/application/location/server-status.ts";
import * as projectFileServices from "../../src/application/formats/project-file-services.ts";
import * as documentMerge from "../../src/application/session/document-merge.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const OWNERS = [
  "src/application/session/operation.ts",
  "src/application/transitions",
  "src/application/recovery",
  "src/application/save",
  "src/application/editing/row-drag.ts",
  "src/application/editing/cell-editing.ts",
  "src/application/editing/focus-memory.ts",
  "src/application/editing/paint-guard.ts",
  "src/application/editing/selection.ts",
  "src/application/editing/delete-confirm.ts",
  "src/application/editing/production-selection.ts",
  "src/application/session/merge-undo.ts",
  "src/application/session/document-merge.ts",
  "src/application/preferences/preferences.ts",
  "src/application/preferences/view-flags.ts",
  "src/application/preferences/panel-widths.ts",
  "src/application/location",
  "src/application/formats"
];

function sourcesOf(path: string): string[] {
  const full = join(REPO, path);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap(function (entry) {
    const inner = join(path, entry.name);
    if (entry.isDirectory()) return sourcesOf(inner);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [join(REPO, inner)] : [];
  });
}

function inert(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(inert);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(function (p) { return ts.isPropertyAssignment(p) && inert(p.initializer); });
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const freezes = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" && callee.name.text === "freeze";
    return freezes && node.arguments.every(inert);
  }
  return false;
}

function topLevelWork(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
    if (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.every(function (d) { return d.initializer !== undefined && inert(d.initializer); })) continue;
    found.push(relative(REPO, file) + ": " + statement.getText().split("\n")[0]);
  }
  return found;
}

test("E12: the owners' modules do nothing when they are loaded: only types, functions and frozen constants", () => {
  const files = OWNERS.flatMap(sourcesOf);
  assert.ok(files.length >= 5, "found the owners' sources: " + files.join(", "));
  const work = files.flatMap(topLevelWork);
  assert.deepEqual(work, []);
});

test("E12: importing the owners constructs nothing: each export is a constructor function or frozen data", () => {
  const loaded: Record<string, Record<string, unknown>> = {
    operation: operation, transitionPorts: transitionPorts, transitions: transitions, recoveryPorts: recoveryPorts, draftWriter: draftWriter,
    draftResume: draftResume, conflictStash: conflictStash, legacySnapshots: legacySnapshots, stashedWork: stashedWork, documentSources: documentSources,
    saveCoordinator: saveCoordinator, saveStatus: saveStatus, autoSave: autoSave, saveDestinations: saveDestinations, serverDestination: serverDestination, fileConflict: fileConflict,
    rowDrag: rowDrag, cellEditing: cellEditing, focusMemory: focusMemory, paintGuard: paintGuard, selection: selection, deleteConfirm: deleteConfirm, productionSelection: productionSelection, mergeUndo: mergeUndo,
    preferences: preferences, viewFlags: viewFlags, panelWidths: panelWidths,
    documentLocation: documentLocation, serverStatus: serverStatus, projectFileServices: projectFileServices, documentMerge: documentMerge
  };
  for (const [module, exports] of Object.entries(loaded)) {
    for (const [name, value] of Object.entries(exports)) {
      const ok = typeof value === "function" || typeof value !== "object" || value === null || Object.isFrozen(value);
      assert.ok(ok, module + " exports " + name + ", which is neither a function nor frozen data");
    }
  }
  assert.equal(typeof transitions.createTransitions, "function");
  assert.equal(typeof operation.createOperations, "function");
  assert.equal(typeof draftWriter.createDraftWriter, "function");
  assert.equal(typeof draftResume.createDraftResume, "function");
  assert.equal(typeof conflictStash.createConflictStash, "function");
  assert.equal(typeof legacySnapshots.createLegacySnapshots, "function");
  assert.equal(typeof saveCoordinator.createSaveCoordinator, "function");
  assert.equal(typeof saveDestinations.createSaveDestinations, "function");
  assert.equal(typeof serverDestination.createServerDestination, "function");
  assert.equal(typeof documentSources.createDocumentSources, "function");
  assert.equal(typeof stashedWork.createStashedWork, "function");
  assert.equal(typeof cellEditing.createCellEditing, "function");
});
