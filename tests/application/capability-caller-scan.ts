import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Counts } from "./session-caller-scan.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

function modules(path = ""): string[] {
  return readdirSync(join(REPO, "src", path), { withFileTypes: true }).flatMap(entry => {
    const inner = path ? path + "/" + entry.name : entry.name;
    if (entry.isDirectory()) return inner === "test" ? [] : modules(inner);
    return /\.(?:ts|js|mjs)$/.test(inner) && !/\.(?:test|d)\.(?:ts|js|mjs)$/.test(inner) ? [inner] : [];
  });
}

export function capabilityPortCallers(targets: readonly string[], probe?: { readonly path: string; readonly source: string }, mode: { readonly references?: boolean } = {}) {
  const paths = modules().sort();
  if (probe && !paths.includes(probe.path)) paths.push(probe.path);
  const absolute = (path: string): string => join(REPO, "src", path);
  const canonical = (path: string): string => path.split("\\").join("/");
  const options: ts.CompilerOptions = {
    allowJs: true, noEmit: true, strict: true, skipLibCheck: true, types: [], resolveJsonModule: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  if (probe) host.readFile = path => canonical(path) === canonical(absolute(probe.path)) ? probe.source : read(path);
  const program = ts.createProgram(paths.map(absolute), options, host);
  const checker = program.getTypeChecker();
  const wanted = new Set(targets);
  const declared = new Set<string>();
  const found: Record<string, Counts> = Object.fromEntries(targets.map(point => [point, {}]));
  function literalName(node: ts.Node): string | null {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
    return null;
  }
  function finiteKeys(type: ts.Type, seen = new Set<ts.Type>()): readonly string[] | null {
    if (type.isStringLiteral()) return [type.value];
    if (seen.has(type)) return null;
    seen.add(type);
    if (type.isUnion()) {
      const keys: string[] = [];
      for (const part of type.types) {
        const found = finiteKeys(part, new Set(seen));
        if (found === null) return null;
        keys.push(...found);
      }
      return [...new Set(keys)];
    }
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type ? finiteKeys(constraint, seen) : null;
  }
  function keys(from: ts.Type, expression: ts.Expression): readonly string[] {
    return finiteKeys(checker.getTypeAtLocation(expression)) ?? checker.getPropertiesOfType(checker.getNonNullableType(from)).map(symbol => symbol.name);
  }
  function bindingNames(from: ts.Type, name: ts.Node): readonly string[] {
    const literal = literalName(name);
    if (literal !== null) return [literal];
    return ts.isComputedPropertyName(name) ? keys(from, name.expression) : [];
  }
  function point(node: ts.Node): string | null {
    const path = canonical(node.getSourceFile().fileName);
    const prefix = canonical(join(REPO, "src")) + "/";
    if (!path.startsWith(prefix)) return null;
    const file = path.slice(prefix.length);
    if (ts.isFunctionDeclaration(node) && node.name) return file + "#" + node.name.text;
    if (mode.references && ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent)) return point(node.parent);
    if (mode.references && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer)
      && ts.isSourceFile(node.parent.parent.parent)) return file + "#" + node.name.text;
    if (ts.isFunctionTypeNode(node)) return point(node.parent);
    if (ts.isTypeAliasDeclaration(node)) return file + "#" + node.name.text;
    if (!ts.isPropertySignature(node) && !ts.isMethodSignature(node)) return null;
    let name = literalName(node.name);
    if (name === null) return null;
    let parent = node.parent;
    while (ts.isTypeLiteralNode(parent) && ts.isPropertySignature(parent.parent)) {
      const outer = parent.parent;
      const field = literalName(outer.name);
      if (field === null) return null;
      name = field + "." + name;
      parent = outer.parent;
    }
    return ts.isInterfaceDeclaration(parent) ? file + "#" + parent.name.text + "." + name : null;
  }
  for (const path of paths) {
    const source = program.getSourceFile(absolute(path));
    if (!source) throw new Error("Capability caller was not loaded: " + path);
    function note(nodes: readonly ts.Node[]): void {
      if (probe && path !== probe.path) return;
      for (const key of new Set(nodes.map(point))) {
        if (!key || !wanted.has(key)) continue;
        const callers = found[key];
        if (callers) callers[path] = (callers[path] ?? 0) + 1;
      }
    }
    function property(from: ts.Type, name: string, at: ts.Node): ts.Type | null {
      const symbol = checker.getPropertyOfType(checker.getNonNullableType(from), name);
      if (!symbol) return null;
      const type = checker.getTypeOfSymbolAtLocation(symbol, at);
      note([
        ...checker.getRootSymbols(symbol).flatMap(root => root.declarations ?? []),
        ...checker.getSignaturesOfType(type, ts.SignatureKind.Call).flatMap(signature => signature.declaration ? [signature.declaration] : [])
      ]);
      return type;
    }
    function binding(pattern: ts.ObjectBindingPattern, from: ts.Type): void {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) continue;
        for (const name of bindingNames(from, element.propertyName ?? element.name)) {
          const type = property(from, name, element) ?? checker.getTypeAtLocation(element.name);
          if (!checker.getPropertyOfType(checker.getNonNullableType(from), name)) note(checker.getSignaturesOfType(type, ts.SignatureKind.Call).flatMap(signature => signature.declaration ? [signature.declaration] : []));
          if (type && ts.isObjectBindingPattern(element.name)) binding(element.name, type);
        }
      }
    }
    function assignment(pattern: ts.ObjectLiteralExpression, from: ts.Type): void {
      for (const element of pattern.properties) {
        if (!ts.isPropertyAssignment(element) && !ts.isShorthandPropertyAssignment(element)) continue;
        for (const name of bindingNames(from, element.name)) {
          const type = property(from, name, element);
          if (type && ts.isPropertyAssignment(element) && ts.isObjectLiteralExpression(element.initializer)) assignment(element.initializer, type);
        }
      }
    }
    function transported(node: ts.Identifier): boolean {
      const parent = node.parent;
      if (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) && parent.name === node || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent)) return false;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
      if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
      return true;
    }
    const visit = (node: ts.Node): void => {
      const key = point(node);
      if (key) declared.add(key);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        const names = ts.isPropertyAccessExpression(node) ? [node.name.text] : keys(type, node.argumentExpression);
        for (const name of names) property(type, name, node);
        if (names.some(name => name === "call" || name === "apply" || name === "bind")) note(checker.getSignaturesOfType(type, ts.SignatureKind.Call).flatMap(signature => signature.declaration ? [signature.declaration] : []));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const signature = checker.getResolvedSignature(node);
        if (signature?.declaration) note([signature.declaration]);
      }
      if (mode.references && ts.isIdentifier(node) && transported(node)) {
        const named = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
        const symbol = named && named.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(named) : named;
        const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
        note((symbol?.declarations ?? []).filter(found => !called && ts.isFunctionDeclaration(found) || ts.isVariableDeclaration(found)));
      }
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isObjectBindingPattern(node.name)) binding(node.name, checker.getTypeAtLocation(node.initializer ?? node));
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) assignment(node.left, checker.getTypeAtLocation(node.right));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const target of targets) if (!declared.has(target)) throw new Error("Capability inventory names a missing declaration: " + target);
  return found;
}
