import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
test("Split legacy event and undo inventories require a new native route to be classified", () => {
  const editor = readFileSync(new URL("../bootstrap/wiring/editor.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("editor.ts", editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const keys = new Set(), references = [];
  function scope(node) {
    for (let at = node; at; at = at.parent) if (ts.isFunctionDeclaration(at)) return at.name?.text ?? "anonymous";
    return "module";
  }
  function visit(node) {
    const owner = scope(node);
    if ((owner === "onRootKeydown" || owner === "mountRowsEditingFeature") && ts.isBinaryExpression(node)
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "key" && ts.isStringLiteral(node.right)) keys.add(node.right.text);
    if (ts.isIdentifier(node) && node.text === "undoOwner"
      && !(ts.isImportSpecifier(node.parent) && !node.parent.propertyName)) {
      const parent = node.parent;
      const use = ts.isCallExpression(parent) && parent.expression === node ? "call"
        : ts.isVariableDeclaration(parent) && parent.name === node ? "binding" : "reference";
      references.push([owner, use]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual([...keys].sort(), ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]);
  const methods = [...editor.matchAll(/undoOwner\(\)\.(\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(methods, ["flush", "last", "redo", "undo", "last", "settleAfterApply", "compositionMark", "dropEmptySince", "last", "last", "last", "last"]);
  assert.deepEqual(references, [
    ["mountCellEditingFeature", "call"], ["mountCellEditingFeature", "call"],
    ["module", "call"], ["module", "call"], ["module", "call"],
    ["afterUndoApplied", "call"], ["mountCompositionFeature", "call"], ["mountCompositionFeature", "call"],
    ["insertIntoScriptCellNow", "call"], ["insertIntoScriptCellNow", "call"], ["insertIntoScriptCellNow", "call"],
    ["announceAttached", "call"], ["announceAttached", "binding"], ["announceAttached", "reference"], ["announceAttached", "reference"],
    ["onRootKeydown", "binding"], ["onRootKeydown", "reference"], ["onRootKeydown", "reference"]
  ]);
});
