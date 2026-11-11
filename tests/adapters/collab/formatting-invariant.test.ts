import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { formattingLibraryControls } from "./formatting-controls.ts";
import { createLibraryControlDocument, createLibraryControlNativeDocument } from "./helpers.ts";

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
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const imports = node.importClause?.namedBindings;
        if (/src\/adapters\/collab\/(?:document|state)\.ts$/.test(node.moduleSpecifier.text)) {
          assert.ok(!imports || !ts.isNamespaceImport(imports), path);
          if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) assert.ok(!["createSharedDocument", "CollabDocumentState"].includes((item.propertyName ?? item.name).text), path);
        }
        if (node.moduleSpecifier.text === "yjs" && imports && ts.isNamedImports(imports)) {
          for (const item of imports.elements) assert.notEqual((item.propertyName ?? item.name).text, "Doc", path);
        }
      }
      if (ts.isNewExpression(node)) assert.ok(!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "Doc", path);
      ts.forEachChild(node, visit);
    };
    visit(source); inspected++;
  }
  assert.equal(inspected, files.length - 1);
  assert.ok(inspected >= 17);
});
