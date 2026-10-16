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
  "type K = Exclude<keyof ValidatedDocument, string | number>;",
  "declare const ports: MigratePorts;",
  'const raw: unknown = JSON.parse("{}");',
  "const doc = migrateRows(raw, ports);",
  "const shape = raw as DocumentShape;",
  "function copy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }",
  "function launder<T>(v: unknown): T { return v as T; }",
  "function pick<T>(seed: unknown, v: unknown): T { return (seed && v) as T; }",
  "const launderArrow = <T,>(v: unknown): T => v as T;",
  "function deferred<T>(v: unknown): T extends object ? T : never { return v as T extends object ? T : never; }",
  "function indexed<T extends { d: unknown }>(v: unknown): T[\"d\"] { return v as T[\"d\"]; }",
  "function is<T>(v: unknown): v is T { return !!v; }",
  "class Box<T> { get value(): T { return undefined as T; } }",
  "class Store<T> { private items = new Map<string, T>(); get(id: string): T | undefined { return this.items.get(id); } }",
  'function fail(): never { throw new Error("no"); }',
  "function run<T>(fn: () => T): T { return fn(); }",
  "function use(d: ValidatedDocument): ValidatedDocument { return d; }",
  "class Held1<T> { v: T; constructor(v: unknown) { this.v = v as T; } }",
  "function assertNever(x: never): never { throw new Error(String(x)); }",
  "class Keeper<T> { readonly items: T[]; constructor() { this.items = []; } }"
];

const ASSERTION = "a type assertion";
const PREDICATE = "a type predicate";
const CALL = "a generic call";
const BODILESS = "a function signature";
const DECLARED = "an ambient or";
const MEMBER = "an ambient member";
const NEVER_OUT = "a value of";

const FORGED = [
  ["raw as ValidatedDocument", ASSERTION],
  ["raw as Alias", ASSERTION],
  ["raw as unknown as ValidatedDocument", ASSERTION],
  ["shape as ValidatedDocument", ASSERTION],
  ["raw as ValidatedDocument | null", ASSERTION],
  ["raw as ValidatedDocument[]", ASSERTION],
  ["raw as readonly Alias[]", ASSERTION],
  ["raw as Holder", ASSERTION],
  ["raw as { nested: { deeper: Holder } }", ASSERTION],
  ["raw as MergedStates", ASSERTION],
  ["raw as Promise<ValidatedDocument>", ASSERTION],
  ["raw as Map<string, ValidatedDocument>", ASSERTION],
  ["raw as { [id: string]: ValidatedDocument }", ASSERTION],
  ["raw as () => ValidatedDocument", ASSERTION],
  ["raw as new () => ValidatedDocument", ASSERTION],
  ["raw as ReturnType<typeof migrateRows>", ASSERTION],
  ["raw as TagState & ValidatedDocument", ASSERTION],
  ["raw as typeof doc", ASSERTION],
  ["JSON.parse(JSON.stringify(doc)) as typeof doc", ASSERTION],
  ["raw as never", ASSERTION],
  ["{ ...shape, [Symbol() as unknown as K]: true as const }", ASSERTION],
  ["launder<ValidatedDocument>(raw)", CALL],
  ["launder<never>(raw)", CALL],
  ["launderArrow<ValidatedDocument>(raw)", CALL],
  ["deferred<ValidatedDocument>(raw)", CALL],
  ["indexed<{ d: ValidatedDocument }>(raw)", CALL],
  ["is<ValidatedDocument>(raw)", CALL],
  ["use(({ v: raw } as { v: never }).v)", NEVER_OUT],
  ["use(([raw] as [never])[0])", NEVER_OUT],
  ["use(((() => raw) as () => never)())", NEVER_OUT],
  ["async () => use(await (raw as Promise<never>))", ASSERTION],
  ["Array.from(raw as never[]).map(use)", ASSERTION],
  ["raw as never[] | null", ASSERTION]
].map(([e, what], i) => [`export const f${i} = ${e};`, what]).concat([
  ["export const inferred: ValidatedDocument = launder(raw);", CALL],
  ["export function isDoc(x: unknown): x is ValidatedDocument { return !!x; }", PREDICATE],
  ["export function isNever(x: unknown): x is never { return !!x; }", PREDICATE],
  ["export function isV(d: ValidatedDocument | DocumentShape): d is ValidatedDocument { return !!d; }", PREDICATE],
  ["export function assertV(d: ValidatedDocument | DocumentShape): asserts d is ValidatedDocument { if (!d) throw new Error(\"no\"); }", PREDICATE],
  ["export function isV2(d: ValidatedDocument | string): d is ValidatedDocument { return typeof d !== \"string\"; }", PREDICATE],
  ["export function isAny(d: any): d is ValidatedDocument { return !!d; }", PREDICATE],
  ["export class Guard {\n  isDoc(): this is ValidatedDocument { return false; }\n}", PREDICATE, 1],
  ["export function assertDoc(x: unknown): asserts x is Alias { if (!x) throw new Error(\"no\"); }", PREDICATE],
  ["export function generic<T extends ValidatedDocument>(x: unknown): T { return x as T; }", ASSERTION],
  ["export function overload(x: unknown): ValidatedDocument;\nexport function overload(x: unknown): unknown { return x; }", BODILESS],
  ["declare function made(x: unknown): Holder;", BODILESS],
  ["declare const ambient: ValidatedDocument;", DECLARED],
  ["declare const k3: K;", DECLARED],
  ["export let definite!: ValidatedDocument;", DECLARED],
  ["export class Held { d!: ValidatedDocument; }", DECLARED],
  ["export class Declared { declare d: ValidatedDocument; }", DECLARED],
  ["declare global {\n  interface JSON { parse(text: string, tag: 1): ValidatedDocument; }\n}", MEMBER, 1],
  ["declare module \"../../src/core/migrate.ts\" {\n  interface DocumentOrigin { forge(): ValidatedDocument; }\n}", MEMBER, 1]
]);

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
  "export const a10: ValidatedDocument = doc;",
  "export const a11 = structuredClone(doc);",
  "export const a12 = [doc].filter(Boolean);",
  "export const a13 = [doc].map((d) => d);",
  "export const a14 = Object.assign(doc, {});",
  "export const a15 = new Map<string, ValidatedDocument>([[\"a\", doc]]);",
  "export const a16 = launder<string>(raw);",
  "export interface Port { read(): ValidatedDocument; }",
  "export const a17 = (): never => fail();",
  "export const a18 = ({}) as Record<string, never>;",
  "export const a19 = new Box<string>().value;",
  "export const a20 = new Map<string, ValidatedDocument>();",
  "export const a21 = new Set<ValidatedDocument>();",
  "export const a22 = new WeakMap<ValidatedDocument, number>();",
  "export class Registry { byId = new Map<string, ValidatedDocument>(); }",
  "export const a23: Set<ValidatedDocument> = new Set();",
  "export const a24: Map<string, ValidatedDocument> = new Map();",
  "export const a25 = new Promise<ValidatedDocument>((resolve) => resolve(migrateRows(raw, ports)));",
  "export const a26 = new Store<ValidatedDocument>();",
  "export const a27 = [doc, null].filter((d): d is ValidatedDocument => d !== null);",
  "export function present(d: ValidatedDocument | null): asserts d is ValidatedDocument { if (!d) throw new Error(\"no\"); }",
  "export const a28 = raw as Record<string, never>;",
  "export const a29 = raw as [];",
  "export const a30 = raw as { rows: [] };",
  "export const a31 = raw as { fail: () => never };",
  "export class Owner { doc: ValidatedDocument | null = null; }",
  "export const a32 = (): never => run(() => fail());",
  "export const a33 = new Keeper<ValidatedDocument>();",
  "export const a34 = Array.of<ValidatedDocument>();",
  "export function exhaust(k: \"a\"): string { if (k === \"a\") return \"a\"; return assertNever(k); }",
  "export const a35 = (): never => fail();",
  "export const a36 = [doc, undefined].filter((d): d is ValidatedDocument => d !== undefined);",
  "export const a37 = (d: ValidatedDocument | null | undefined): d is ValidatedDocument => !!d;",
  "export const a38 = raw as Store<never>;",
  "export function narrowed(o: { k: \"a\" | \"b\" }): string { if (o.k === \"a\") return \"a\"; if (o.k === \"b\") return \"b\"; return String(o.k); }",
  "export const a39 = ((() => \"x\") as () => string)();",
  "export class Built { doc: ValidatedDocument; constructor() { this.doc = migrateRows(raw, ports); } }"
];

const KNOWN_GAPS = [
  "export const g0 = new Box<ValidatedDocument>().value;",
  "export class DocBox extends Held1<ValidatedDocument> {}",
  "export const g4 = new DocBox(raw).v;",
  "export const g5: Held1<ValidatedDocument> = new Held1(raw);",
  "export const g2 = pick<ValidatedDocument>(doc, raw);",
  "export class Base { take(d: ValidatedDocument | string): void { void d; } }",
  "export class Derived extends Base { override take(d: ValidatedDocument): void { void d; } }",
  "export const g3 = (new Derived() as Base).take(\"x\");"
];

function fixture() {
  const lines = [...HEAD];
  const expected = [];
  FORGED.forEach(([code, what, offset]) => { expected.push([lines.length + 1 + (offset || 0), what]); lines.push(...code.split("\n")); });
  lines.push(...ALLOWED, ...KNOWN_GAPS);
  return { text: lines.join("\n") + "\n", expected };
}

const { text, expected } = fixture();
const { program, errorLines } = compileFixtures({ [FIXTURE]: text });
eq("the fixture itself type-checks, so only the rule can refuse it", errorLines(FIXTURE), []);

const found = brandForgeries(program, REPO, new Set([FIXTURE]));
eq("every forging form is refused, on its own line, by the form it takes, and nothing else is",
  found.map((f) => [f.line, f.what.split(" ").slice(0, 3).join(" ")]),
  expected.map(([line, what]) => [line, what.split(" ").slice(0, 3).join(" ")]));

const ANGLE = "tests/__brand__/angle.ts";
const angle = compileFixtures({ [ANGLE]: [HEAD[0], HEAD[9], "export const forged = <ValidatedDocument>raw;", ""].join("\n") });
eq("an angle-bracket assertion is refused too, though erasableSyntaxOnly already rejects its syntax",
  brandForgeries(angle.program, REPO, new Set([ANGLE])).map((f) => [f.line, f.what]), [[3, "a type assertion to the validated document brand or to never"]]);

const producerText = readFileSync(join(REPO, BRAND_PRODUCER), "utf8");
const COPY = "src/core/migrate-copy.ts";
const both = compileFixtures({ [COPY]: producerText });
eq("the producer's copy type-checks where it sits", both.errorLines(COPY), []);
const producerCasts = brandForgeries(both.program, REPO, new Set([COPY]));
check("the producer's own casts are refused anywhere but the producer", producerCasts.length >= 2, JSON.stringify(producerCasts));
eq("the producer itself may cast to the brand", brandForgeries(both.program, REPO, new Set([BRAND_PRODUCER])), []);

const NAMESAKE = "tests/__brand__/migrate.ts";
const namesake = compileFixtures({ [NAMESAKE]: [HEAD[0], HEAD[9], "export const forged = raw as ValidatedDocument;", ""].join("\n") });
eq("another file named migrate.ts is no producer", brandForgeries(namesake.program, REPO, new Set([NAMESAKE])).map((f) => f.line), [3]);

const SCRIPT = "tests/__brand__/script.ts";
const script = compileFixtures({
  [SCRIPT]: [
    'interface JSON { parse(text: string, tag: 2): import("../../src/core/document/validated.ts").ValidatedDocument; }',
    'const parsed: unknown = JSON.parse("{}", 2);',
    ""
  ].join("\n")
});
eq("a .ts file with no import or export is still a module, so its JSON interface is local and changes nothing",
  [script.errorLines(SCRIPT), brandForgeries(script.program, REPO, new Set([SCRIPT]))], [[2], []]);

const work = mkdtempSync(join(tmpdir(), "splitpage-brand-"));
try {
  const put = (path, body) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), body);
  };
  const options = {
    target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
    allowImportingTsExtensions: true, verbatimModuleSyntax: true, lib: ["ES2023"], types: []
  };
  put("package.json", JSON.stringify({ type: "module" }));
  put("tsconfig.one.json", JSON.stringify({ compilerOptions: options, include: ["types/*.d.ts", "src/core/**/*.ts"] }));
  put("tsconfig.two.json", JSON.stringify({ compilerOptions: options, include: ["types/*.d.ts", "src/use/**/*.ts"] }));
  put("types/json.d.ts", readFileSync(join(REPO, "types/json.d.ts"), "utf8"));
  put(BRAND_HOME, readFileSync(join(REPO, BRAND_HOME), "utf8"));
  put(BRAND_PRODUCER, [
    'import type { ValidatedDocument } from "./document/validated.ts";',
    "export function migrateRows(raw: unknown): ValidatedDocument { return raw as ValidatedDocument; }",
    ""
  ].join("\n"));
  const clean = [
    'import type { ValidatedDocument } from "../core/document/validated.ts";',
    'import { migrateRows } from "../core/migrate.ts";',
    'export const doc: ValidatedDocument = migrateRows(JSON.parse("{}"));',
    ""
  ].join("\n");
  const files = ["types/json.d.ts", BRAND_HOME, BRAND_PRODUCER, "src/use/use.ts"];
  const gate = () => {
    const out = [];
    const status = typecheck({ repo: work, configs: ["tsconfig.one.json", "tsconfig.two.json"], files, print: () => {}, printError: (m) => out.push(m) });
    return { status, out };
  };
  put("src/use/use.ts", clean);
  eq("the gate passes a document that came from the producer", gate(), { status: 0, out: [] });
  put("src/use/use.ts", clean.replace("migrateRows(JSON.parse(\"{}\"))", "JSON.parse(\"{}\") as ValidatedDocument"));
  eq("the gate fails on a planted cast in its second config's files, and names the file and line once", gate(), {
    status: 1,
    out: [`typecheck: src/use/use.ts:3: a type assertion to the validated document brand or to never; only ${BRAND_PRODUCER} produces a validated document`]
  });
  put("src/use/use.ts", clean);
  put("types/forge.d.ts", 'interface JSON { parse(text: string, tag: 1): import("../src/core/document/validated.ts").ValidatedDocument; }\n');
  files.push("types/forge.d.ts");
  eq("a global declaration file both configs read is refused once", gate(), {
    status: 1,
    out: [`typecheck: types/forge.d.ts:1: an ambient member that yields the validated document brand; only ${BRAND_PRODUCER} produces a validated document`]
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
