import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
