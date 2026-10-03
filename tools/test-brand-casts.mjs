import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRAND_HOME, BRAND_PRODUCER, brandForgeries } from "./brand-casts.mjs";
import { REPO } from "./source-scan.mjs";
import { compileFixtures } from "./ts-fixtures.mjs";
import { typecheck } from "./typecheck.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " - " + detail : ""));
  console.log("  FAIL " + name + (detail ? " - " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const FIXTURE = "tests/__brand__/fixture.ts";

const HEAD = [
  'import type { DocumentShape, ValidatedDocument } from "../../src/core/document/validated.ts";',
  'import type { MergedStates } from "../../src/core/merge-states.ts";',
  'import { migrateRows } from "../../src/core/migrate.ts";',
  'import type { MigratePorts } from "../../src/core/migrate.ts";',
  'import type { TagState } from "../../src/core/production/tags.ts";',
  "type Alias = ValidatedDocument;",
  "type Holder = { doc: ValidatedDocument };",
  "declare const ports: MigratePorts;",
  'const raw: unknown = JSON.parse("{}");',
  "const doc = migrateRows(raw, ports);",
  "const shape = raw as DocumentShape;",
  "function copy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }"
];

const FORGED_EXPRESSIONS = [
  "raw as ValidatedDocument",
  "raw as Alias",
  "raw as unknown as ValidatedDocument",
  "shape as ValidatedDocument",
  "raw as ValidatedDocument | null",
  "raw as ValidatedDocument[]",
  "raw as readonly Alias[]",
  "raw as Holder",
  "raw as { nested: { deeper: Holder } }",
  "raw as MergedStates",
  "raw as Promise<ValidatedDocument>",
  "raw as Map<string, ValidatedDocument>",
  "raw as { [id: string]: ValidatedDocument }",
  "raw as () => ValidatedDocument",
  "raw as ReturnType<typeof migrateRows>",
  "raw as TagState & ValidatedDocument",
  "raw as typeof doc",
  "JSON.parse(JSON.stringify(doc)) as typeof doc"
];

const FORGED_DECLARATIONS = [
  "export function isDoc(x: unknown): x is ValidatedDocument { return !!x; }",
  "export function assertDoc(x: unknown): asserts x is Alias { if (!x) throw new Error(\"no\"); }",
  "export function generic<T extends ValidatedDocument>(x: unknown): T { return x as T; }",
  "export function overload(x: unknown): ValidatedDocument;\nexport function overload(x: unknown): unknown { return x; }",
  "declare const ambient: ValidatedDocument;",
  "declare function made(x: unknown): Holder;"
];

const ALLOWED = [
  "export const a0 = doc as ValidatedDocument;",
  "export const a1 = doc as TagState;",
  "export const a2 = raw as TagState;",
  "export const a3 = doc as Record<string, unknown>;",
  "export const a4 = raw as DocumentShape;",
  "export const a5 = copy(doc);",
  "export const a6 = [doc] as const;",
  "export function a7(x: unknown): ValidatedDocument { return migrateRows(x, ports); }",
  "export const a8 = (raw as { rows: unknown[] }).rows;",
  "export const a9 = ambient;",
  "export const a10: ValidatedDocument = doc;"
];

function fixture() {
  const lines = [...HEAD];
  const expected = [];
  FORGED_EXPRESSIONS.forEach((e, i) => { lines.push(`export const f${i} = ${e};`); expected.push(lines.length); });
  FORGED_DECLARATIONS.forEach((d) => { expected.push(lines.length + 1); lines.push(...d.split("\n")); });
  lines.push(...ALLOWED);
  return { text: lines.join("\n") + "\n", expected };
}

const { text, expected } = fixture();
const { program, errorLines } = compileFixtures({ [FIXTURE]: text });
eq("the fixture itself type-checks, so only the rule can refuse it", errorLines(FIXTURE), []);

const found = brandForgeries(program, REPO, new Set([FIXTURE]));
eq("every forging form is refused, on its own line, and nothing else is", found.map((f) => f.line), expected);
eq("each refusal names its form", found.map((f) => f.what.split(" ").slice(0, 3).join(" ")), [
  ...FORGED_EXPRESSIONS.map(() => "a type assertion"),
  "a type predicate", "a type predicate", "a type assertion", "a function signature", "an ambient declaration", "a function signature"
]);

const ANGLE = "tests/__brand__/angle.ts";
const angle = compileFixtures({ [ANGLE]: [HEAD[0], HEAD[8], "export const forged = <ValidatedDocument>raw;", ""].join("\n") });
eq("an angle-bracket assertion is refused too, though erasableSyntaxOnly already rejects its syntax",
  brandForgeries(angle.program, REPO, new Set([ANGLE])).map((f) => [f.line, f.what]), [[3, "a type assertion to the validated document brand"]]);

const producerText = readFileSync(join(REPO, BRAND_PRODUCER), "utf8");
const COPY = "src/core/migrate-copy.ts";
const both = compileFixtures({ [COPY]: producerText });
eq("the producer's copy type-checks where it sits", both.errorLines(COPY), []);
const producerCasts = brandForgeries(both.program, REPO, new Set([COPY]));
check("the producer's own casts are refused anywhere but the producer", producerCasts.length >= 2, JSON.stringify(producerCasts));
eq("the producer itself may cast to the brand", brandForgeries(both.program, REPO, new Set([BRAND_PRODUCER])), []);

const work = mkdtempSync(join(tmpdir(), "splitpage-brand-"));
try {
  const put = (path, body) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), body);
  };
  put("package.json", JSON.stringify({ type: "module" }));
  put("tsconfig.gate.json", JSON.stringify({
    compilerOptions: {
      target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
      allowImportingTsExtensions: true, verbatimModuleSyntax: true, lib: ["ES2023"], types: []
    },
    include: ["types/*.d.ts", "src/**/*.ts"]
  }));
  put("types/json.d.ts", readFileSync(join(REPO, "types/json.d.ts"), "utf8"));
  put(BRAND_HOME, readFileSync(join(REPO, BRAND_HOME), "utf8"));
  put(BRAND_PRODUCER, [
    'import type { ValidatedDocument } from "./document/validated.ts";',
    "export function migrateRows(raw: unknown): ValidatedDocument { return raw as ValidatedDocument; }",
    ""
  ].join("\n"));
  const clean = [
    'import type { ValidatedDocument } from "./core/document/validated.ts";',
    'import { migrateRows } from "./core/migrate.ts";',
    'export const doc: ValidatedDocument = migrateRows(JSON.parse("{}"));',
    ""
  ].join("\n");
  const files = ["types/json.d.ts", BRAND_HOME, BRAND_PRODUCER, "src/use.ts"];
  const gate = () => {
    const out = [];
    const status = typecheck({ repo: work, configs: ["tsconfig.gate.json"], files, print: () => {}, printError: (m) => out.push(m) });
    return { status, out };
  };
  put("src/use.ts", clean);
  const before = gate();
  eq("the gate passes a document that came from the producer", before, { status: 0, out: [] });
  put("src/use.ts", clean.replace("migrateRows(JSON.parse(\"{}\"))", "JSON.parse(\"{}\") as ValidatedDocument"));
  const planted = gate();
  eq("the gate fails on a planted cast to the brand, and names its file and line", planted, {
    status: 1,
    out: [`typecheck: src/use.ts:3: a type assertion to the validated document brand; only ${BRAND_PRODUCER} produces a validated document`]
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
