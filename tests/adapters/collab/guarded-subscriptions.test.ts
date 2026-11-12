import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

function modulesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const inner = join(path, entry.name);
    return entry.isDirectory() ? modulesUnder(inner) : /\.[cm]?[jt]s$/.test(entry.name) ? [inner] : [];
  });
}

test("library subscriptions stay inside the shared adapter and every callback is guarded", () => {
  const files = modulesUnder(join(REPO, "src"));
  const program = ts.createProgram(files, {
    allowJs: true, noEmit: true, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext
  });
  const checker = program.getTypeChecker(), violations: string[] = [], found: string[] = [];

  function libraryType(type: ts.Type, visited = new Set<ts.Type>()): boolean {
    if (visited.has(type)) return false;
    visited.add(type);
    const symbol = type.getSymbol();
    if (symbol && ["Doc", "AbstractType"].includes(symbol.name) && symbol.declarations?.some(declaration =>
      declaration.getSourceFile().fileName.replaceAll("\\", "/").includes("/node_modules/yjs/"))) return true;
    if (type.isUnionOrIntersection() && type.types.some(member => libraryType(member, visited))) return true;
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint && constraint !== type && libraryType(constraint, visited)) return true;
    if (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      const target = (type as ts.TypeReference).target;
      if (target !== type && libraryType(target, visited)) return true;
    }
    return !!(type.flags & ts.TypeFlags.Object) && !!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)
      && checker.getBaseTypes(type as ts.InterfaceType).some(base => libraryType(base, visited));
  }

  function guarded(callback: ts.Expression | undefined): boolean {
    if (!callback) return false;
    if (ts.isIdentifier(callback)) {
      const declaration = checker.getSymbolAtLocation(callback)?.valueDeclaration;
      return !!declaration && ts.isVariableDeclaration(declaration) && guarded(declaration.initializer);
    }
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
    const body = callback.body;
    return ts.isCallExpression(body) && ts.isIdentifier(body.expression) && body.expression.text === "guardSharedCallback";
  }

  for (const file of files) {
    const source = program.getSourceFile(file);
    assert.ok(source);
    const name = relative(REPO, file).replaceAll("\\", "/");
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["on", "once", "observe", "observeDeep"].includes(node.expression.name.text)
        && libraryType(checker.getTypeAtLocation(node.expression.expression))) {
        found.push(name);
        const callback = node.arguments[node.expression.name.text.startsWith("observe") ? 0 : 1];
        if (!name.startsWith("src/adapters/collab/") || !guarded(callback)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${name}:${line}: ${node.expression.getText()}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
  assert.deepEqual([...new Set(found)].sort(), [
    "src/adapters/collab/document.ts", "src/adapters/collab/state.ts", "src/adapters/collab/structure-order.ts"
  ]);
  assert.equal(found.length, 6);
});
