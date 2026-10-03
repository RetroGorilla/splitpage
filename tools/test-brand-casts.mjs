import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_PRODUCER, brandForgeries } from "./brand-casts.mjs";
import { REPO } from "./source-scan.mjs";
import { compileFixtures } from "./ts-fixtures.mjs";

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
  "export const a9 = ambient;"
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

const producerText = readFileSync(join(REPO, BRAND_PRODUCER), "utf8");
const COPY = "src/core/migrate-copy.ts";
const both = compileFixtures({ [COPY]: producerText });
eq("the producer's copy type-checks where it sits", both.errorLines(COPY), []);
const producerCasts = brandForgeries(both.program, REPO, new Set([COPY]));
check("the producer's own casts are refused anywhere but the producer", producerCasts.length >= 2, JSON.stringify(producerCasts));
eq("the producer itself may cast to the brand", brandForgeries(both.program, REPO, new Set([BRAND_PRODUCER])), []);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
