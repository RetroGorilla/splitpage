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
  const exports = new Map();
  const refusals = [];
  const problems = [];
  const modifiers = (node) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).map((m) => m.kind);
  const exportName = (name, local, statement) => {
    if (exports.has(name)) refusals.push(`${path}: ${name} is exported twice`);
    exports.set(name, local);
    if (modifiers(statement).includes(ts.SyntaxKind.DefaultKeyword)) refusals.push(`${path}: unsupported export form: export default`);
  };
  for (const statement of source.statements) {
    const exported = modifiers(statement).includes(ts.SyntaxKind.ExportKeyword);
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) refusals.push(`${path}: unsupported export form: re-export from ${statement.moduleSpecifier.getText(source)}`);
      else if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) refusals.push(`${path}: unsupported export form: ${statement.getText(source)}`);
      else for (const element of statement.exportClause.elements) exportName(element.name.text, (element.propertyName ?? element.name).text, statement);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      refusals.push(`${path}: unsupported export form: ${statement.isExportEquals ? "export =" : "export default"}`);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        declarations.set(name, { kind: keyword, text: `${keyword} ${declaration.getText(source)}` });
        if (exported) exportName(name, name, statement);
      }
      continue;
    }
    const kind = DECLARATION_KINDS.get(statement.kind);
    if (kind && statement.name) {
      declarations.set(statement.name.text, { kind, text: statement.getText(source).replace(/^export\s+/, "") });
      if (exported) exportName(statement.name.text, statement.name.text, statement);
      else if (modifiers(statement).includes(ts.SyntaxKind.DefaultKeyword)) refusals.push(`${path}: unsupported export form: export default`);
      continue;
    }
    if (exported) refusals.push(`${path}: unsupported export form: ${statement.getText(source).slice(0, 60)}`);
    else problems.push(`${path}: unexpected statement ${statement.getText(source).slice(0, 60)}`);
  }
  return { declarations, exports, refusals, problems };
}

function compareCopy(pair, originalText, copyText) {
  const original = declarationsOf(originalText, pair.original);
  const copy = declarationsOf(copyText, pair.copy);
  const problems = [...original.refusals, ...copy.refusals, ...copy.problems];
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
  const wantedExports = new Map();
  for (const [name, local] of original.exports) {
    if (expected.includes(local)) wantedExports.set(name, local);
    else if (!pair.only && !pair.omitted.includes(local)) problems.push(`${pair.original}: exports ${name} as ${local}, which is not a copied declaration`);
  }
  for (const [alias, local] of Object.entries(pair.aliases)) {
    if (wantedExports.has(alias)) problems.push(`${pair.original}: listed alias ${alias} is already exported there`);
    wantedExports.set(alias, local);
  }
  const listed = (exports) => JSON.stringify([...exports].map(([name, local]) => (name === local ? name : `${name}=${local}`)).sort());
  if (listed(copy.exports) !== listed(wantedExports)) problems.push(`${pair.copy}: exports ${listed(copy.exports)}, expected ${listed(wantedExports)}`);
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
eq("a missing declaration fails", compareCopy(control, original, copy.replace("export const data: Pair = [1, 2];\n", "")), ["tests/c.ts: missing data", 'tests/c.ts: exports ["Pair","listed=local"], expected ["Pair","data","listed=local"]']);
eq("an added declaration fails", compareCopy(control, original, copy + "export const extra = 1;\n"), ["tests/c.ts: extra is not in the original", 'tests/c.ts: exports ["Pair","data","extra","listed=local"], expected ["Pair","data","listed=local"]']);
eq("a dropped export fails", compareCopy(control, original, copy.replace("export const data", "const data")), ['tests/c.ts: exports ["Pair","listed=local"], expected ["Pair","data","listed=local"]']);
eq("omitting data instead of a function fails", compareCopy({ ...control, omitted: ["data"] }, original, copy).includes("prototypes/o.ts: omitted data is not a function there"), true);
eq("an alias added to the original fails", compareCopy(control, original + "export { data as extraOracle };\n", copy), ['tests/c.ts: exports ["Pair","data","listed=local"], expected ["Pair","data","extraOracle=data","listed=local"]']);
eq("an alias added to the copy fails", compareCopy(control, original, copy + "export { data as extraOracle };\n"), ['tests/c.ts: exports ["Pair","data","extraOracle=data","listed=local"], expected ["Pair","data","listed=local"]']);
eq("the same alias on both sides passes", compareCopy(control, original + "export { data as extraOracle };\n", copy + "export { data as extraOracle };\n"), []);
eq("an alias pointing at another declaration fails", compareCopy(control, original, copy.replace("export { local as listed }", "export { data as listed }")), ['tests/c.ts: exports ["Pair","data","listed=data"], expected ["Pair","data","listed=local"]']);
eq("an original export of something not copied fails", compareCopy(control, original + 'export { assert as checked };\n', copy), ["prototypes/o.ts: exports checked as assert, which is not a copied declaration"]);
eq("a name exported twice fails", compareCopy(control, original, copy + "export { data };\n"), ["tests/c.ts: data is exported twice"]);
eq("a type-only alias list counts as an export", compareCopy(control, original + "export type { Pair as Couple };\n", copy).at(-1), 'tests/c.ts: exports ["Pair","data","listed=local"], expected ["Couple=Pair","Pair","data","listed=local"]');
const refused = [
  ["export default expression", "export default data;\n", "unsupported export form: export default"],
  ["export default declaration", "export default function made(): number { return 1; }\n", "unsupported export form: export default"],
  ["export =", "export = data;\n", "unsupported export form: export ="],
  ["export * from", 'export * from "./o.ts";\n', 'unsupported export form: re-export from "./o.ts"'],
  ["export * as namespace from", 'export * as all from "./o.ts";\n', 'unsupported export form: re-export from "./o.ts"'],
  ["named re-export", 'export { data as again } from "./o.ts";\n', 'unsupported export form: re-export from "./o.ts"'],
  ["exported import alias", 'export import fs = require("node:fs");\n', "unsupported export form: export import fs"],
  ["exported namespace", "export namespace Space { export const x = 1; }\n", "unsupported export form: export namespace Space"]
];
for (const [form, line, message] of refused) {
  for (const [side, path, originalText, copyText] of [["original", "prototypes/o.ts", original + line, copy], ["copy", "tests/c.ts", original, copy + line]]) {
    eq(`${form} on the ${side} side is refused`, compareCopy(control, originalText, copyText).some((p) => p.startsWith(`${path}: ${message}`)), true);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
