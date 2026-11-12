import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = "src";
const STANDALONE = "StandaloneDocumentSession";

export type Counts = Record<string, number>;

function modulesUnder(path: string): string[] {
  return readdirSync(join(REPO, path), { withFileTypes: true }).flatMap(function (entry) {
    const inner = path + "/" + entry.name;
    if (entry.isDirectory()) return inner === SOURCE + "/test" ? [] : modulesUnder(inner);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [inner] : [];
  });
}

let parsed: readonly ts.SourceFile[] | null = null;

function sources(): readonly ts.SourceFile[] {
  parsed ??= modulesUnder(SOURCE).sort().map(function (path) {
    return ts.createSourceFile(path.slice(SOURCE.length + 1), readFileSync(join(REPO, path), "utf8"), ts.ScriptTarget.Latest, true);
  });
  return parsed;
}

function counted(matches: (node: ts.Node) => number): Counts {
  const found: Counts = {};
  for (const source of sources()) {
    let count = 0;
    const visit = function (node: ts.Node): void {
      count += matches(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (count) found[source.fileName] = count;
  }
  return found;
}

export function sourceModuleCount(): number {
  return sources().length;
}

export function under(counts: Counts, folder: string): Counts {
  return Object.fromEntries(Object.entries(counts).filter(function ([file]) { return file.startsWith(folder); }));
}

export function identifierMentions(name: string): Counts {
  return counted(function (node) { return ts.isIdentifier(node) && node.text === name ? 1 : 0; });
}

function namesStandalone(node: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === STANDALONE;
}

function literalMembers(node: ts.TypeNode): string[] {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(literalMembers);
  return ["*"];
}

function standaloneMembers(node: ts.Node): string[] | null {
  if (ts.isIndexedAccessTypeNode(node) && namesStandalone(node.objectType)) return literalMembers(node.indexType);
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && (node.typeName.text === "Pick" || node.typeName.text === "Omit")) {
    const [from, keys] = node.typeArguments ?? [];
    if (from && keys && namesStandalone(from)) return node.typeName.text === "Pick" ? literalMembers(keys) : ["*"];
  }
  return null;
}

export function standaloneTypeMentions(member: string): Counts {
  return counted(function (node) {
    const members = standaloneMembers(node);
    return members ? members.filter(function (m) { return m === member || m === "*"; }).length : 0;
  });
}

export function liveSessionMembers(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const source of sources()) {
    const members: string[] = [];
    const visit = function (node: ts.Node): void {
      if (ts.isPropertyAccessExpression(node) && ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "liveSession") members.push(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (members.length) found[source.fileName] = members.sort();
  }
  return found;
}

export function untypedStandaloneAccesses(probe?: string): Record<string, string[]> {
  const folder = join(REPO, "src/test");
  const roots = readdirSync(folder).filter((name) => name.endsWith(".mjs")).sort().map((name) => join(folder, name));
  const options: ts.CompilerOptions = {
    allowJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    skipLibCheck: true
  };
  const host = ts.createCompilerHost(options);
  const probePath = join(folder, "session-caller-probe.mjs");
  const read = host.readFile;
  if (probe !== undefined) {
    roots.push(probePath);
    host.readFile = (path) => path.split("\\").join("/") === probePath.split("\\").join("/") ? probe : read(path);
  }
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  const contract = program.getSourceFile(join(REPO, "src/application/session/document-session.ts"));
  if (!contract) throw new Error("Session contract was not loaded");
  const interfaces = contract.statements.filter(ts.isInterfaceDeclaration);
  const common = interfaces.find((node) => node.name.text === "CommonDocumentSession");
  const standalone = interfaces.find((node) => node.name.text === STANDALONE);
  if (!common || !standalone) throw new Error("Session interfaces were not loaded");
  const commonType = checker.getTypeAtLocation(common);
  const members = new Set(checker.getPropertiesOfType(checker.getTypeAtLocation(standalone)).map((member) => member.name));
  function literalName(node: ts.Node): string | null {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
    return null;
  }
  function nestedType(from: ts.Type, name: string, at: ts.Node): ts.Type | null {
    const property = checker.getPropertyOfType(from, name);
    return property ? checker.getTypeOfSymbolAtLocation(property, at) : null;
  }
  function binding(pattern: ts.ObjectBindingPattern, from: ts.Type, accesses: string[]): void {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;
      const name = literalName(element.propertyName ?? element.name);
      if (name === null) continue;
      if (from === commonType && members.has(name)) accesses.push(name);
      if (ts.isObjectBindingPattern(element.name)) {
        const type = nestedType(from, name, element);
        if (type) binding(element.name, type, accesses);
      }
    }
  }
  function assignment(pattern: ts.ObjectLiteralExpression, from: ts.Type, accesses: string[]): void {
    for (const property of pattern.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const name = literalName(property.name);
      if (name === null) continue;
      if (from === commonType && members.has(name)) accesses.push(name);
      if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
        const type = nestedType(from, name, property);
        if (type) assignment(property.initializer, type, accesses);
      }
    }
  }
  const found: Record<string, string[]> = {};
  for (const path of roots) {
    if (probe !== undefined && path !== probePath) continue;
    const source = program.getSourceFile(path);
    if (!source) throw new Error("Session caller was not loaded");
    const accesses: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const key = ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
        if (key && members.has(key) && checker.getTypeAtLocation(node.expression) === commonType) accesses.push(key);
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        binding(node.name, checker.getTypeAtLocation(node.initializer), accesses);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isObjectLiteralExpression(node.left)) {
        assignment(node.left, checker.getTypeAtLocation(node.right), accesses);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (accesses.length) found[relative(REPO, path).split("\\").join("/")] = accesses.sort();
  }
  return found;
}

export function typedStandaloneInventory(probes?: Readonly<Record<string, string>>) {
  function modules(path: string): string[] {
    return readdirSync(join(REPO, path), { withFileTypes: true }).flatMap(entry => {
      const inner = path + "/" + entry.name;
      if (entry.isDirectory()) return inner === SOURCE + "/test" ? [] : modules(inner);
      return /\.(?:ts|js|mjs)$/.test(entry.name) && !/\.(?:test|d)\.(?:ts|js|mjs)$/.test(entry.name) ? [inner] : [];
    });
  }
  const names = ["stamp", "amend", "noteEdit", "held"] as const;
  const declarations = [
    ["application/production/broll-records.ts", "RecordsReconcilerPorts", "held"],
    ["application/editing/undo/undo.ts", "UndoPorts", "held"],
    ["application/save/project-files.ts", "ProjectFilesPorts", "heldDocument"],
    ["application/session/session-merge-ports.ts", "SessionMergeSession", "held"]
  ] as const;
  const paths = probes ? Object.keys(probes).sort() : modules(SOURCE).sort().map(path => path.slice(SOURCE.length + 1));
  const absolute = (path: string): string => join(REPO, SOURCE, path);
  const canonical = (path: string): string => ts.sys.useCaseSensitiveFileNames ? path.split("\\").join("/") : path.split("\\").join("/").toLowerCase();
  const overrides = new Map(Object.entries(probes ?? {}).map(([path, source]) => [canonical(absolute(path)), source]));
  const options: ts.CompilerOptions = {
    allowJs: true, noEmit: true, strict: true, skipLibCheck: true, types: [], resolveJsonModule: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile;
  const exists = host.fileExists;
  host.readFile = path => overrides.get(canonical(path)) ?? read(path);
  host.fileExists = path => overrides.has(canonical(path)) || exists(path);
  const roots = [...new Set([...paths, "application/session/document-session.ts", ...declarations.map(([path]) => path)])];
  const program = ts.createProgram(roots.map(absolute), options, host);
  const checker = program.getTypeChecker();
  const contract = program.getSourceFile(absolute("application/session/document-session.ts"));
  const standalone = contract?.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === STANDALONE);
  if (!standalone) throw new Error("Standalone session contract was not loaded");
  const session = checker.getTypeAtLocation(standalone);
  const symbols = new Set(checker.getPropertiesOfType(session));
  const memberTypes = new Map([...symbols].map(symbol => [symbol.name, checker.getTypeOfSymbolAtLocation(symbol, standalone)]));
  const carriedTypes = new Set(memberTypes.values());
  const members: Record<string, Counts> = { stamp: {}, amend: {}, noteEdit: {}, held: {} };
  const typePositions: Counts = {};
  function matches(type: ts.Type, seen = new Set<ts.Type>()): readonly string[] {
    if (seen.has(type)) return [];
    seen.add(type);
    if (type.isUnionOrIntersection()) return [...new Set(type.types.flatMap(part => matches(part, seen)))];
    return names.filter(name => memberTypes.get(name) === type);
  }
  function carries(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type === session || carriedTypes.has(type)) return true;
    if (type.isUnionOrIntersection()) return type.types.some(part => carries(part, seen));
    return checker.getPropertiesOfType(type).some(symbol => checker.getRootSymbols(symbol).some(root => symbols.has(root)));
  }
  function literalName(node: ts.Node): string | null {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression.text;
    return null;
  }
  for (const path of paths) {
    const source = program.getSourceFile(absolute(path));
    if (!source) throw new Error("Typed session caller was not loaded: " + path);
    const count = (type: ts.Type): void => {
      for (const name of matches(type)) {
        const inventory = members[name];
        if (inventory) inventory[path] = (inventory[path] ?? 0) + 1;
      }
    };
    function property(from: ts.Type, name: string, at: ts.Node): ts.Type | null {
      const symbol = checker.getPropertyOfType(checker.getNonNullableType(from), name);
      if (!symbol) return null;
      const type = checker.getTypeOfSymbolAtLocation(symbol, at);
      count(type);
      return type;
    }
    function binding(pattern: ts.ObjectBindingPattern, from: ts.Type): void {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) continue;
        const name = literalName(element.propertyName ?? element.name);
        if (name === null) continue;
        const type = property(from, name, element) ?? checker.getTypeAtLocation(element.name);
        if (!checker.getPropertyOfType(checker.getNonNullableType(from), name)) count(type);
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
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const from = checker.getTypeAtLocation(node.expression);
        count(from);
        const name = ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
        if (name !== null) property(from, name, node);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) count(checker.getTypeAtLocation(node.expression));
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isObjectBindingPattern(node.name)) binding(node.name, checker.getTypeAtLocation(node.initializer ?? node));
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) assignment(node.left, checker.getTypeAtLocation(node.right));
      if (ts.isTypeNode(node) && carries(checker.getTypeFromTypeNode(node))) typePositions[path] = (typePositions[path] ?? 0) + 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const held = memberTypes.get("held");
  const portMemberTypes: Record<string, boolean> = {};
  for (const [path, owner, name] of declarations) {
    const source = program.getSourceFile(absolute(path));
    const declaration = source?.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === owner);
    const member = declaration?.members.find(node => ts.isPropertySignature(node) && literalName(node.name) === name);
    portMemberTypes[path + "#" + owner + "." + name] = !!member && ts.isPropertySignature(member) && !!member.type && checker.getTypeFromTypeNode(member.type) === held;
  }
  return { members, typePositions, portMemberTypes };
}
