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
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer &&
          checker.getTypeAtLocation(node.initializer) === commonType) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && members.has(key.text)) accesses.push(key.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (accesses.length) found[relative(REPO, path).split("\\").join("/")] = accesses.sort();
  }
  return found;
}
