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

export function capabilityPortCallers(targets: readonly string[], probe?: { readonly path: string; readonly source: string }) {
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
  function point(node: ts.Node): string | null {
    const path = canonical(node.getSourceFile().fileName);
    const prefix = canonical(join(REPO, "src")) + "/";
    if (!path.startsWith(prefix)) return null;
    const file = path.slice(prefix.length);
    if (ts.isFunctionDeclaration(node) && node.name) return file + "#" + node.name.text;
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
      note(checker.getRootSymbols(symbol).flatMap(root => root.declarations ?? []));
      return checker.getTypeOfSymbolAtLocation(symbol, at);
    }
    function binding(pattern: ts.ObjectBindingPattern, from: ts.Type): void {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) continue;
        const name = literalName(element.propertyName ?? element.name);
        if (name === null) continue;
        const type = property(from, name, element) ?? checker.getTypeAtLocation(element.name);
        if (!checker.getPropertyOfType(checker.getNonNullableType(from), name)) note(checker.getSignaturesOfType(type, ts.SignatureKind.Call).flatMap(signature => signature.declaration ? [signature.declaration] : []));
        if (type && ts.isObjectBindingPattern(element.name)) binding(element.name, type);
      }
    }
    function assignment(pattern: ts.ObjectLiteralExpression, from: ts.Type): void {
      for (const element of pattern.properties) {
        if (!ts.isPropertyAssignment(element) && !ts.isShorthandPropertyAssignment(element)) continue;
        const name = literalName(element.name);
        if (name === null) continue;
        const type = property(from, name, element);
        if (type && ts.isPropertyAssignment(element) && ts.isObjectLiteralExpression(element.initializer)) assignment(element.initializer, type);
      }
    }
    const visit = (node: ts.Node): void => {
      const key = point(node);
      if (key) declared.add(key);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        const name = ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
        if (name !== null) property(type, name, node);
        if (name === "call" || name === "apply" || name === "bind") note(checker.getSignaturesOfType(type, ts.SignatureKind.Call).flatMap(signature => signature.declaration ? [signature.declaration] : []));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const signature = checker.getResolvedSignature(node);
        if (signature?.declaration) note([signature.declaration]);
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
