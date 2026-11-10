import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { REPO } from "./source-scan.mjs";
import { COLLAB_ORACLE_COPIES } from "./collab-oracle-copies.mjs";
import { needsRootTests } from "./ci-changes.mjs";

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log("  ok   " + name); return; }
  const detail = `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  failures.push(`${name} — ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

const DECLARATION_KINDS = new Map([
  [ts.SyntaxKind.FunctionDeclaration, "function"],
  [ts.SyntaxKind.InterfaceDeclaration, "interface"],
  [ts.SyntaxKind.TypeAliasDeclaration, "type"],
  [ts.SyntaxKind.ClassDeclaration, "class"],
  [ts.SyntaxKind.EnumDeclaration, "enum"]
]);

function declarationsOf(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map();
  const aliases = {};
  const problems = [];
  const exported = (node) => (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) problems.push(`${path}: re-export from ${statement.moduleSpecifier.getText(source)}`);
      for (const element of statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : []) {
        aliases[element.name.text] = (element.propertyName ?? element.name).text;
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
      for (const declaration of statement.declarationList.declarations) {
        declarations.set(declaration.name.getText(source), { kind: keyword, exported: exported(statement), text: `${keyword} ${declaration.getText(source)}` });
      }
      continue;
    }
    const kind = DECLARATION_KINDS.get(statement.kind);
    if (kind && statement.name) {
      declarations.set(statement.name.text, { kind, exported: exported(statement), text: statement.getText(source).replace(/^export\s+/, "") });
      continue;
    }
    problems.push(`${path}: unexpected statement ${statement.getText(source).slice(0, 60)}`);
  }
  return { declarations, aliases, problems };
}

function compareCopy(pair, originalText, copyText) {
  const original = declarationsOf(originalText, pair.original);
  const copy = declarationsOf(copyText, pair.copy);
  const problems = [...copy.problems];
  if (!pair.only) problems.push(...original.problems);
  for (const name of pair.omitted) {
    if (original.declarations.get(name)?.kind !== "function") problems.push(`${pair.original}: omitted ${name} is not a function there`);
  }
  const expected = pair.only ?? [...original.declarations.keys()].filter((name) => !pair.omitted.includes(name));
  for (const name of expected) {
    const wanted = original.declarations.get(name);
    const got = copy.declarations.get(name);
    if (!wanted) problems.push(`${pair.original}: no declaration ${name}`);
    else if (!got) problems.push(`${pair.copy}: missing ${name}`);
    else if (got.text !== wanted.text) problems.push(`${pair.copy}: ${name} differs from the original`);
  }
  for (const name of copy.declarations.keys()) if (!expected.includes(name)) problems.push(`${pair.copy}: ${name} is not in the original`);
  const wantedExports = [...expected.filter((name) => original.declarations.get(name)?.exported), ...Object.keys(pair.aliases)].sort();
  const gotExports = [...[...copy.declarations].filter(([, d]) => d.exported).map(([name]) => name), ...Object.keys(copy.aliases)].sort();
  if (JSON.stringify(gotExports) !== JSON.stringify(wantedExports)) problems.push(`${pair.copy}: exports ${JSON.stringify(gotExports)}, expected ${JSON.stringify(wantedExports)}`);
  for (const [alias, local] of Object.entries(pair.aliases)) {
    if (copy.aliases[alias] !== local) problems.push(`${pair.copy}: ${alias} does not export ${local}`);
  }
  return problems;
}

function filesUnder(folder) {
  return readdirSync(join(REPO, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(REPO, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .sort();
}

console.log("\ncollaboration oracle copies:\n");

for (const pair of COLLAB_ORACLE_COPIES) {
  const problems = compareCopy(pair, readFileSync(join(REPO, pair.original), "utf8"), readFileSync(join(REPO, pair.copy), "utf8"));
  eq(`${pair.copy} declares the data of ${pair.original} byte for byte`, problems, []);
}
eq("every file under tests/collab/oracles is a pinned copy", filesUnder("tests/collab/oracles"), COLLAB_ORACLE_COPIES.map((pair) => pair.copy).sort());
for (const pair of COLLAB_ORACLE_COPIES) eq(`a change to ${pair.original} alone runs the root tests`, needsRootTests([pair.original]), true);

console.log("\nthe comparison's own controls:\n");

const control = { copy: "tests/c.ts", original: "prototypes/o.ts", omitted: ["check"], only: null, aliases: { listed: "local" } };
const original = 'import assert from "node:assert";\nexport type Pair = readonly [number, number];\nconst local = [1, 2];\nexport const data: Pair = [1, 2];\nexport function check(): void { assert.ok(data); }\n';
const copy = 'import type { X } from "./x.ts";\nexport type Pair = readonly [number, number];\nconst local = [1, 2];\nexport const data: Pair = [1, 2];\nexport { local as listed };\n';
eq("a faithful copy passes", compareCopy(control, original, copy), []);
eq("an edited literal fails", compareCopy(control, original, copy.replace("const local = [1, 2]", "const local = [1, 3]")), ["tests/c.ts: local differs from the original"]);
eq("reformatting a literal fails", compareCopy(control, original, copy.replace("export const data: Pair = [1, 2]", "export const data: Pair = [1,2]")), ["tests/c.ts: data differs from the original"]);
eq("a missing declaration fails", compareCopy(control, original, copy.replace("export const data: Pair = [1, 2];\n", "")), ["tests/c.ts: missing data", 'tests/c.ts: exports ["Pair","listed"], expected ["Pair","data","listed"]']);
eq("an added declaration fails", compareCopy(control, original, copy + "export const extra = 1;\n"), ["tests/c.ts: extra is not in the original", 'tests/c.ts: exports ["Pair","data","extra","listed"], expected ["Pair","data","listed"]']);
eq("a dropped export fails", compareCopy(control, original, copy.replace("export const data", "const data")), ['tests/c.ts: exports ["Pair","listed"], expected ["Pair","data","listed"]']);
eq("omitting data instead of a function fails", compareCopy({ ...control, omitted: ["data"] }, original, copy).includes("prototypes/o.ts: omitted data is not a function there"), true);
eq("a re-export fails", compareCopy(control, original, copy + 'export { data as again } from "./o.ts";\n').some((p) => p.includes("re-export")), true);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
