import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const APPLICATION = "src/application";

function modulesUnder(path: string): string[] {
  return readdirSync(join(REPO, path), { withFileTypes: true }).flatMap(function (entry) {
    const inner = path + "/" + entry.name;
    if (entry.isDirectory()) return modulesUnder(inner);
    return /\.(?:ts|js)$/.test(entry.name) && !/\.test\.(?:ts|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [inner] : [];
  });
}

function unwrapped(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) || ts.isTypeAssertionExpression(inner)) inner = inner.expression;
  return inner;
}

function frozenArgument(node: ts.Expression): ts.Expression | null {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return null;
  const callee = node.expression;
  const freezes = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" && callee.name.text === "freeze";
  return freezes ? node.arguments[0] ?? null : null;
}

function primitive(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(node) && node.text === "undefined") return true;
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand);
}

function staticClass(node: ts.ClassDeclaration): boolean {
  if (ts.getDecorators(node)?.length) return false;
  const heritage = (node.heritageClauses ?? []).every(function (clause) {
    return clause.types.every(function (type) { return ts.isIdentifier(type.expression) && !type.typeArguments; });
  });
  return heritage && node.members.every(function (member) {
    if (ts.isClassStaticBlockDeclaration(member) || ts.getDecorators(member as ts.HasDecorators)?.length) return false;
    if (member.name && ts.isComputedPropertyName(member.name)) return false;
    const isStatic = ts.getModifiers(member as ts.HasModifiers)?.some(function (m) { return m.kind === ts.SyntaxKind.StaticKeyword; });
    return !(ts.isPropertyDeclaration(member) && isStatic && member.initializer);
  });
}

function moduleLoadWork(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const frozenHere = new Set<string>();
  const value = function (node: ts.Expression): boolean {
    const inner = unwrapped(node);
    if (primitive(inner)) return true;
    if (ts.isRegularExpressionLiteral(inner)) return !/[gy]/.test(inner.text.slice(inner.text.lastIndexOf("/") + 1));
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return true;
    const argument = frozenArgument(inner);
    return argument !== null && frozenData(unwrapped(argument));
  };
  const spreadsFrozen = function (node: ts.Expression): boolean {
    return ts.isIdentifier(node) && frozenHere.has(node.text);
  };
  const frozenData = function (node: ts.Expression): boolean {
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every(function (e) { return ts.isSpreadElement(e) ? spreadsFrozen(e.expression) : value(e); });
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every(function (p) {
        if (ts.isSpreadAssignment(p)) return spreadsFrozen(p.expression);
        return ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && value(p.initializer);
      });
    }
    return false;
  };
  const found: string[] = [];
  for (const statement of source.statements) {
    let allowed = false;
    if (ts.isImportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) || ts.isExportDeclaration(statement)) allowed = true;
    else if (ts.isClassDeclaration(statement)) allowed = staticClass(statement);
    else if (ts.isVariableStatement(statement)) {
      const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const exported = ts.getModifiers(statement)?.some(function (m) { return m.kind === ts.SyntaxKind.ExportKeyword; }) ?? false;
      allowed = statement.declarationList.declarations.every(function (d) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) return false;
        if (!constant) return !exported && d.initializer.kind === ts.SyntaxKind.NullKeyword;
        if (!value(d.initializer)) return false;
        if (frozenArgument(unwrapped(d.initializer)) !== null) frozenHere.add(d.name.text);
        return true;
      });
    }
    if (!allowed) {
      const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
      found.push(path + ":" + line + ": " + statement.getText(source).split("\n")[0]);
    }
  }
  return found;
}

const MODULES = modulesUnder(APPLICATION).sort();

test("E12: the application scan finds every module under src/application", () => {
  assert.ok(MODULES.length > 0, "found no modules under " + APPLICATION);
  for (const path of MODULES) assert.ok(path.startsWith(APPLICATION + "/") && !/\.test\./.test(path), path);
});

test("E12: the load check accepts only types, functions, plain classes, frozen constants and empty started slots", () => {
  const accepted = [
    "import { a } from \"./a.ts\";\nimport type { B } from \"./b.ts\";\nexport type { B };\nexport { a };",
    "export interface Shape { readonly a: number }\nexport type Kind = \"a\" | \"b\";",
    "export function make(): number { return 1; }",
    "export const read = (): number => 1;\nconst write = function (): void {};",
    "export class Refused extends TypeError {\n  readonly code = \"refused\";\n  method(): void {}\n}",
    "class Plain {}",
    "const NAME = \"x\";\nconst COUNT = -1;\nconst ON = true;\nconst NONE = null;\nconst NOTHING = undefined;",
    "const SPACE_END = /\\s$/;\nconst KEY = /^f[1-9]$/i;",
    "const FIELDS = Object.freeze([\"a\", \"b\"]) as readonly string[];\nconst LIMIT = (5 satisfies number);",
    "const LIST = Object.freeze([\"a\", Object.freeze({ b: 1 })]);",
    "const BASE = Object.freeze({ a: false, list: Object.freeze([]) });\nexport const MORE = Object.freeze({ ...BASE, a: true });",
    "let started: { stop(): void } | null = null;"
  ];
  for (const text of accepted) assert.deepEqual(moduleLoadWork("x.ts", text), [], text);
  const refused: [string, string][] = [
    ["mutable default", "let mode = \"position\";"],
    ["mutable false default", "let open = false;"],
    ["uninitialized binding", "let declined: Record<string, boolean>;"],
    ["exported slot", "export let started: object | null = null;"],
    ["var", "var count = 0;"],
    ["call", "const changes = changeSet({ docFields: [\"title\"] });"],
    ["owner constructed at load", "export const view = createView({ read: () => null });"],
    ["new", "const MODIFIERS = new Set([\"mod\"]);"],
    ["new regex", "const NBSP = new RegExp(\"a\", \"g\");"],
    ["global regex literal", "const ALL = /a/g;"],
    ["sticky regex literal", "const AT = /a/y;"],
    ["statement", "FIELDS.forEach(function (f) { SKIP[f] = true; });"],
    ["unfrozen array", "const LIST = [\"a\", \"b\"];"],
    ["unfrozen array under as const", "const LIST = [\"a\", \"b\"] as const;"],
    ["unfrozen object", "const STATS = { writes: 0 };"],
    ["unfrozen nested array", "const SHAPE = Object.freeze({ list: [\"a\"] });"],
    ["imported alias", "export const DERIVES = CELL_TEXT_DERIVES;"],
    ["spread of an import", "const ALL = Object.freeze({ ...NO_CHANGES, whole: true });"],
    ["freeze of a call", "const CACHE = Object.freeze(build());"],
    ["computed key", "const KEYED = Object.freeze({ [name]: 1 });"],
    ["class with a computed heritage", "class Wrapped extends mixin(Base) {}"],
    ["class with a static initializer", "class Counter { static count = start(); }"],
    ["class with a static block", "class Setup { static { run(); } }"],
    ["destructured binding", "const { a } = Object.freeze({ a: 1 });"],
    ["enum", "enum Mode { A, B }"],
    ["export default expression", "export default createThing();"]
  ];
  for (const [name, text] of refused) assert.equal(moduleLoadWork("x.ts", text).length, 1, name + ": " + text);
});

test("E12: the application's modules do nothing when they are loaded: only types, functions and frozen constants", () => {
  const work = MODULES.flatMap(function (path) { return moduleLoadWork(path, readFileSync(join(REPO, path), "utf8")); });
  assert.deepEqual(work, []);
});

type ExportKind = "function" | "primitive" | "frozen" | "mutable";

const POOL = 4;
const BATCH = 10;

const LOAD_SCRIPT = "const kinds = (value) => typeof value === \"function\" ? \"function\" : typeof value !== \"object\" || value === null ? \"primitive\" : Object.isFrozen(value) ? \"frozen\" : \"mutable\";\n" +
  "const result = {};\n" +
  "for (const url of process.argv.slice(2)) {\n" +
  "  const exports = await import(url);\n" +
  "  result[url] = Object.fromEntries(Object.entries(exports).map(([name, value]) => [name, kinds(value)]));\n" +
  "}\n" +
  "process.stdout.write(JSON.stringify(result));\n";

const waiting: (() => void)[] = [];
let running = 0;

async function inPool<T>(task: () => Promise<T>): Promise<T> {
  while (running >= POOL) await new Promise<void>(function (resolve) { waiting.push(resolve); });
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function allSettledOrThrow<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find(function (s): s is PromiseRejectedResult { return s.status === "rejected"; });
  if (failed) throw failed.reason;
  return settled.map(function (s) { return (s as PromiseFulfilledResult<T>).value; });
}

async function loadBatch(script: string, paths: readonly string[]): Promise<Record<string, Record<string, ExportKind>>> {
  const urls = paths.map(function (path) { return pathToFileURL(join(REPO, path)).href; });
  const out = await inPool(function () { return execFileAsync(process.execPath, [script, ...urls], { cwd: REPO, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); });
  const byUrl = JSON.parse(out.stdout) as Record<string, Record<string, ExportKind>>;
  return Object.fromEntries(paths.map(function (path, i) { return [path, byUrl[urls[i] as string] as Record<string, ExportKind>]; }));
}

async function loadBatchNamingFailure(script: string, paths: readonly string[]): Promise<Record<string, Record<string, ExportKind>>> {
  try {
    return await loadBatch(script, paths);
  } catch (error) {
    if (paths.length > 1) {
      await allSettledOrThrow(paths.map(function (path) { return loadBatchNamingFailure(script, [path]); }));
      throw new Error(paths.join(", ") + " load alone but fail together:\n" + String((error as { stderr?: string }).stderr ?? error).split("\n").slice(0, 12).join("\n"), { cause: error });
    }
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    throw new Error(paths[0] + " fails when it is loaded on its own:\n" + stderr.split("\n").slice(0, 12).join("\n"), { cause: error });
  }
}

async function exportKinds(paths: readonly string[]): Promise<Record<string, Record<string, ExportKind>>> {
  const folder = mkdtempSync(join(tmpdir(), "owners-load-"));
  try {
    const script = join(folder, "load.mjs");
    writeFileSync(script, LOAD_SCRIPT);
    const batches: string[][] = [];
    for (let i = 0; i < paths.length; i += BATCH) batches.push(paths.slice(i, i + BATCH));
    const loaded = await allSettledOrThrow(batches.map(function (batch) { return loadBatchNamingFailure(script, batch); }));
    return Object.assign({}, ...loaded) as Record<string, Record<string, ExportKind>>;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("E12: importing the application's modules constructs nothing: each export is a function, a primitive or frozen data", async () => {
  const loaded = await exportKinds(MODULES);
  assert.deepEqual(Object.keys(loaded).sort(), MODULES);
  for (const [path, exports] of Object.entries(loaded)) {
    for (const [name, kind] of Object.entries(exports)) {
      assert.notEqual(kind, "mutable", path + " exports " + name + ", which is neither a function nor frozen data");
    }
  }
  const constructors: [string, string][] = [
    ["transitions/transitions.ts", "createTransitions"],
    ["session/operation.ts", "createOperations"],
    ["recovery/draft-resume.ts", "createDraftResume"],
    ["recovery/conflict-stash.ts", "createConflictStash"],
    ["recovery/legacy-snapshots.ts", "createLegacySnapshots"],
    ["save/coordinator.ts", "createSaveCoordinator"],
    ["save/destinations.ts", "createSaveDestinations"],
    ["transitions/sources.ts", "createDocumentSources"],
    ["recovery/stashed-work.ts", "createStashedWork"],
    ["editing/cell-editing.ts", "createCellEditing"],
    ["shot-hiding.ts", "createShotHiding"],
    ["prompter-state.ts", "createPrompterState"],
    ["tag-panel-state.ts", "createTagPanelState"],
    ["comment-sort.ts", "createCommentSorting"],
    ["find-options.ts", "createFindOptions"],
    ["import-mode.ts", "createImportMode"],
    ["broll-anchoring.ts", "createBrollAnchoring"],
    ["commands/bulk-tags.ts", "createBulkTagRows"],
    ["preferences/broll-view.ts", "createBrollView"]
  ];
  for (const [path, name] of constructors) assert.equal(loaded[APPLICATION + "/" + path]?.[name], "function", path + " " + name);
});
