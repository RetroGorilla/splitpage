import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { formattingLibraryControls } from "./formatting-controls.ts";
import { createLibraryControlDocument, createLibraryControlNativeDocument } from "./helpers.ts";

function checkConstructors(source: ts.SourceFile): void {
  const requires = new Set(["require"]), factories = new Set(["createRequire"]);
  const constructorModule = (name: string): boolean => {
    try { return /\/src\/adapters\/collab\/(?:document|state)\.ts$/.test(decodeURIComponent(new URL(name.replaceAll("\\", "/"), "file:///").pathname)); }
    catch { return false; }
  };
  const factory = (node: ts.Expression): boolean => ts.isIdentifier(node) ? factories.has(node.text) : ts.isPropertyAccessExpression(node) && node.name.text === "createRequire";
  const load = (node: ts.Expression): boolean => ts.isIdentifier(node) ? requires.has(node.text)
    : ts.isPropertyAccessExpression(node) ? node.name.text === "require" : ts.isCallExpression(node) && factory(node.expression);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const imports = node.importClause?.namedBindings;
      if (constructorModule(node.moduleSpecifier.text)) {
        assert.ok(!imports || !ts.isNamespaceImport(imports), source.fileName);
        if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) assert.ok(!["createSharedDocument", "CollabDocumentState"].includes((item.propertyName ?? item.name).text), source.fileName);
      }
      if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) {
        const name = (item.propertyName ?? item.name).text;
        if (node.moduleSpecifier.text === "yjs") assert.notEqual(name, "Doc", source.fileName);
        if (["module", "node:module"].includes(node.moduleSpecifier.text) && name === "createRequire") factories.add(item.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isCallExpression(node.initializer) && factory(node.initializer.expression) || ts.isIdentifier(node.initializer) && requires.has(node.initializer.text)) requires.add(node.name.text);
      if (ts.isIdentifier(node.initializer) && factories.has(node.initializer.text)) factories.add(node.name.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || load(node.expression))) {
      const name = node.arguments[0];
      assert.ok(name && ts.isStringLiteralLike(name), source.fileName + ": module loads must use a literal monitored module");
      assert.ok(!constructorModule(name.text) && name.text !== "yjs", source.fileName + ": dynamic raw constructors bypass the formatting monitor");
    }
    if (ts.isNewExpression(node)) assert.ok(!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "Doc", source.fileName);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

test("source-check negative control rejects the reviewer's dynamic constructor bypass and require variants", () => {
  const bypass = `
    const adapter = await import("../../../src/adapters/collab/document.ts");
    const handle = adapter.createSharedDocument();
    hydrateSharedDocument(handle, source);
    text.format(0, 1, { b: true });
  `;
  for (const code of [bypass,
    'const { CollabDocumentState } = await import("../../../src/adapters/collab/state.ts");',
    'require("../../../src/adapters/collab/document.ts");',
    'module.require("../../../src/adapters/collab/state.ts");',
    'import { createRequire as loader } from "node:module"; const load = loader(import.meta.url); load("../../../src/adapters/collab/document.ts");',
    'createRequire(import.meta.url)("../../../src/adapters/collab/state.ts");',
    'await import("../../../src/adapters/collab/%64ocument.ts");',
    'await import("../../../src/adapters/../adapters/collab/state.ts?copy=1");',
    'await import("yjs");', 'await import(modulePath);'
  ]) assert.throws(() => checkConstructors(ts.createSourceFile("unlisted.test.ts", code, ts.ScriptTarget.Latest, true)), /formatting monitor|literal monitored module/);
  assert.doesNotThrow(() => checkConstructors(ts.createSourceFile("monitored.test.ts", 'const helpers = await import("./helpers.ts"); helpers.createMonitoredSharedDocument();', ts.ScriptTarget.Latest, true)));
});

test("native formatting exemptions are exactly the reviewed library controls and monitor negative control", () => {
  assert.deepEqual(formattingLibraryControls, [
    "seeded formatting cleanup: 48 two-writer histories agree in every order and with a late joiner",
    "formatting cleanup literal: deleted italic abc cannot make the untouched suffix italic",
    "cleanup after a local command publishes a separate checked origin",
    "remote formatting cleanup has its own origin and releases the origin scope afterward",
    "T11: live deletes original commented bc, leaving ad unmarked (gc=true)",
    "T11: late joiner deletes original commented bc, leaving ad unmarked (gc=true)",
    "T11: reload deletes original commented bc, leaving ad unmarked (gc=true)",
    "T11: live deletes original commented bc, leaving ad unmarked (gc=false)",
    "T11: late joiner deletes original commented bc, leaving ad unmarked (gc=false)",
    "T11: reload deletes original commented bc, leaving ad unmarked (gc=false)",
    "monitor negative control rejects native formatting items"
  ]);
  assert.throws(() => createLibraryControlDocument(), /only in a named library control/);
  assert.throws(() => createLibraryControlNativeDocument(), /only in a named library control/);
});

test("every adapter test document is constructed through the formatting monitor or a named control", () => {
  const base = new URL("./", import.meta.url);
  const files = readdirSync(base, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name));
  let inspected = 0;
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name);
    if (path === fileURLToPath(new URL("./helpers.ts", import.meta.url))) continue;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    checkConstructors(source); inspected++;
  }
  assert.equal(inspected, files.length - 1);
  assert.ok(inspected >= 17);
});
