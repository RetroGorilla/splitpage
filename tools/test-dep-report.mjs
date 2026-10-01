import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  layerOf, layerAllows, analyzeScript, buildGraph, findViolations, migratedCycles, compareBaseline, metrics, run
} from "./dep-report.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TOOLS);
const CLI_FILES = ["dep-report.mjs", "source-scan.mjs", "main-module.mjs"];

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function graph(files) {
  return buildGraph(Object.entries(files).map(([path, text]) => ({ path, text })));
}

function writeFiles(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

console.log("\nlayers:\n");

eq("src/core/document is its own layer", layerOf("src/core/document/ids.ts"), "core/document");
eq("an unlisted core folder is core", layerOf("src/core/timing/x.ts"), "core");
eq("a feature folder is named", layerOf("src/features/rows/view.ts"), "features/rows");
eq("numbered modules are legacy-js", layerOf("src/js/21-events.js"), "legacy-js");
eq("src/test is tests", layerOf("src/test/undo.test.mjs"), "tests");
eq("an unknown src folder is src-unknown, not other", layerOf("src/util/helper.js"), "src-unknown");
eq("a file directly under src is src-unknown", layerOf("src/entry.js"), "src-unknown");
eq("a root script is still other", layerOf("build.mjs"), "other");
check("core may not import an unknown src folder", !layerAllows("core/document", "src-unknown"));
check("a feature may not import an unknown src folder", !layerAllows("features/rows", "src-unknown"));
eq("a .test.ts beside source is tests", layerOf("src/core/text/runs.test.ts"), "tests");
check("core/text may import core/document", layerAllows("core/text", "core/document"));
check("core/document may not import core/text", !layerAllows("core/document", "core/text"));
check("core may not import application", !layerAllows("core/text", "application"));
check("application may not import adapters", !layerAllows("application", "adapters"));
check("application may not import legacy-js", !layerAllows("application", "legacy-js"));
check("a feature may not import another feature", !layerAllows("features/rows", "features/find"));
check("a feature may import application", layerAllows("features/rows", "application"));
check("legacy may import legacy-js", layerAllows("legacy", "legacy-js"));
check("bootstrap may import anything", layerAllows("bootstrap", "features/rows") && layerAllows("bootstrap", "adapters"));
check("production code may not import tests", !layerAllows("legacy-js", "tests") && !layerAllows("server", "tests"));
check("tools may import tests", layerAllows("tools", "tests"));

console.log("\nanalyzeScript():\n");

{
  const a = analyzeScript("src/core/text/a.ts", [
    'import { x } from "./b.ts";',
    'import type { T } from "./c.ts";',
    'import { type U } from "./u.ts";',
    'export { y } from "./d.ts";',
    'export type { Z } from "./e.ts";',
    'const s = "import(\'./not-a-module.js\')";',
    'const r = /require\\("nope"\\)/;',
    "let q: import(\"./f.ts\").Q;",
    "const later = import(\"./g.ts\");",
    "const computed = import(\"./\" + name);"
  ].join("\n"));
  const bySpec = Object.fromEntries(a.imports.map((i) => [i.spec, i]));
  eq("static import is found", bySpec["./b.ts"]?.typeOnly, false);
  eq("import type is type-only", bySpec["./c.ts"]?.typeOnly, true);
  eq("an inline type specifier still loads the module", bySpec["./u.ts"]?.typeOnly, false);
  eq("re-export is found", bySpec["./d.ts"]?.kind, "re-export");
  eq("export type is type-only", bySpec["./e.ts"]?.typeOnly, true);
  eq("import() in a type position is type-only", bySpec["./f.ts"]?.typeOnly, true);
  eq("literal dynamic import is resolved", bySpec["./g.ts"]?.kind, "dynamic-import");
  check("a specifier inside a string is not an import", !bySpec["./not-a-module.js"]);
  check("a require inside a regex is not an import", !bySpec["nope"]);
  eq("a computed dynamic import is recorded as unresolved", a.unresolved.map((u) => u.kind), ["dynamic-import"]);
}

{
  const a = analyzeScript("shared/p.js", '"use strict";\nvar b = require("./b.js");\nvar c = require(path.join(root, "c.js"));\nmodule.exports = { b, c };\n');
  eq("a literal require is an edge", a.imports.map((i) => [i.spec, i.kind]), [["./b.js", "require"]]);
  eq("a computed require is unresolved", a.unresolved.length, 1);
  eq("CommonJS module/require are not platform globals", a.globals, []);
}

{
  const a = analyzeScript("src/js/x.js", 'function require(n) { return n; }\nrequire("./y.js");\n');
  eq("a locally defined require is not a load", a.imports.length, 0);
}

{
  const a = analyzeScript("src/core/document/g.ts", [
    "const document = { title: 1 };",
    "export const t = document.title;",
    "export const w = window.innerWidth;",
    "export const o = { location: 1 }.location;",
    "export function f(fetch: number) { return fetch; }",
    "export const n = Date.now() + setTimeout.length;"
  ].join("\n"));
  eq("only free platform identifiers, the clock among them, are reported", a.globals.map((g) => g.name).sort(), ["Date", "setTimeout", "window"]);
}

console.log("\nscope-aware globals:\n");

function freeGlobals(path, lines) {
  return analyzeScript(path, lines.join("\n")).globals.map((g) => `${g.name}:${g.line}`).sort();
}

const scopeCases = [
  ["a parameter in one function does not hide the global in its sibling", "src/core/document/x.ts", [
    "function local(fetch: unknown) { return fetch; }",
    'export function remote() { return fetch("/x"); }'
  ], ["fetch:2"]],
  ["a local in an outer function covers its inner function, not the rest of the file", "src/core/document/x.ts", [
    "function outer() {",
    "  const window = 1;",
    "  function inner() {",
    "    return window;",
    "  }",
    "  return inner;",
    "}",
    "export const w = () => window.name;"
  ], ["window:8"]],
  ["a catch parameter covers only its catch block", "src/core/document/x.ts", [
    "try { run(); } catch (fetch) { void fetch; }",
    "try { run(); } catch ({ location }) { void location; }",
    "export const f = [fetch, location];"
  ], ["fetch:3", "location:3"]],
  ["block and loop bindings stay in their block", "src/core/document/x.ts", [
    "{ const setTimeout = 1; void setTimeout; }",
    "if (ok) { let history = 2; void history; }",
    "for (const URL of list) void URL;",
    'export const n = [setTimeout, history, new URL("x")];'
  ], ["URL:4", "history:4", "setTimeout:4"]],
  ["var and function declarations are hoisted to their function only", "src/core/document/x.ts", [
    "export function f() {",
    "  if (ok) { var location = 1; }",
    "  return [location, crypto()];",
    "  function crypto() { return 2; }",
    "}",
    "export const g = [location, crypto];"
  ], ["crypto:6", "location:6"]],
  ["a function declared in a block does not leak out of a module's block", "src/core/document/x.ts", [
    "{ function Blob() { return 1; } void new Blob(); }",
    "export const b = new Blob([]);"
  ], ["Blob:2"]],
  ["a module-level binding declared later still covers earlier functions", "src/core/document/x.ts", [
    "export function f() { return document.title; }",
    'const document = { title: "" };'
  ], []],
  ["destructured bindings and parameters are local", "src/core/document/x.ts", [
    "const { fetch, a: { document }, ...location } = source;",
    "const [crypto, [performance]] = pair;",
    "function g({ window }: { window: number }, [navigator]: number[] = []) { return [window, navigator]; }",
    "export const used = [fetch, document, location, crypto, performance, g, localStorage];"
  ], ["localStorage:4"]],
  ["property, method and label names are not references; a shorthand property is", "src/core/document/x.ts", [
    "const o = { fetch: 1, window() { return 1; }, get document() { return 2; }, set location(v: number) { void v; } };",
    "class C { navigator = 1; history() { return this.navigator; } static indexedDB = 2; }",
    "export const r = [o.fetch, o.window, C, { performance }, globalThis.fetch];",
    "crypto: for (;;) { break crypto; }"
  ], ["globalThis:3", "performance:3"]],
  ["function and class expression names are local to the expression", "src/core/document/x.ts", [
    "const f = function fetch(): unknown { return fetch; };",
    "const K = class Worker { make() { return new Worker(); } };",
    "export const r = [f, K, fetch, Worker];"
  ], ["Worker:3", "fetch:3"]],
  ["an ambient declare is not a local binding", "src/core/document/x.ts", [
    "declare const window: { name: string };",
    "export const n = window.name;"
  ], ["window:2"]],
  ["an imported name is local to the whole module", "src/core/document/x.ts", [
    'import { fetch } from "./http.ts";',
    'export const g = () => fetch("/x");'
  ], []],
  ["a default parameter value is a reference", "src/core/document/x.ts", [
    "export function f(a = setTimeout, b: number = 1) { return [a, b]; }"
  ], ["setTimeout:1"]],
  ["a parameter default does not see a var declared in the body", "src/core/document/x.ts", [
    "export function f(a = fetch) {",
    "  var fetch = 1;",
    "  return [a, fetch];",
    "}"
  ], ["fetch:1"]],
  ["a type parameter does not hide a global value", "src/core/document/x.ts", [
    'export function f<URL>(u: URL) { return [u, new URL("x")]; }'
  ], ["URL:1"]],
  ["a type alias or an interface does not hide a global value", "src/core/document/x.ts", [
    "type fetch = number;",
    "interface Worker { id: number }",
    'export const r = [fetch("/x"), new Worker("w.js")];'
  ], ["Worker:3", "fetch:3"]],
  ["an import type does not hide a global value", "src/core/document/x.ts", [
    'import type { crypto } from "./types.ts";',
    "export const id = crypto.randomUUID();"
  ], ["crypto:2"]],
  ["a local value does not hide a global type", "src/core/document/x.ts", [
    "const URL = 1;",
    "export let u: URL | undefined = undefined;",
    "export const n = URL;"
  ], ["URL:2"]],
  ["a class is both a type and a value", "src/core/document/x.ts", [
    "class Blob { size = 0; }",
    "export const b: Blob = new Blob();"
  ], []],
  ["typeof reaches an import type", "src/core/document/x.ts", [
    'import type { fetch } from "./http.ts";',
    "export type F = typeof fetch;"
  ], []]
];

for (const [name, path, lines, expected] of scopeCases) eq(name, freeGlobals(path, lines), expected);

console.log("\nthe clock and random numbers:\n");

const clockCases = [
  ["Date.now reads the clock", ["export const t = Date.now();"], ["Date:1"]],
  ["so does Date.now reached by a string key", ['export const t = Date["now"]();'], ["Date:1"]],
  ["new Date() with no argument reads the clock", ["export const d = new Date();"], ["Date:1"]],
  ["so does new Date without parentheses", ["export const d = new Date;"], ["Date:1"]],
  ["so does new Date over a spread that may be empty", ["export const d = (parts: number[]) => new Date(...parts);"], ["Date:1"]],
  ["Date() called without new is the time as text", ["export const s = Date();"], ["Date:1"]],
  ["Date as a value can reach the clock", ["const Clock = Date;", "export const t = Clock.now();"], ["Date:1"]],
  ["so can Date passed to a function", ["export const t = read(Date);"], ["Date:1"]],
  ["a wrapper does not hide Date.now", ["export const t = (Date as DateConstructor).now();"], ["Date:1"]],
  ["any other member of Date is reported", ["export const p = Date.prototype;"], ["Date:1"]],
  ["Date through globalThis is globalThis", ["export const t = globalThis.Date.now();"], ["globalThis:1"]],
  ["Math.random draws a random number", ["export const r = Math.random();"], ["Math.random:1"]],
  ["so does Math.random reached by a string key", ['export const r = Math["random"]();'], ["Math.random:1"]],
  ["a computed member of Math may be random", ["export const r = (k: string) => (Math as never)[k];"], ["Math.random:1"]],
  ["Math as a value can reach Math.random", ["const M = Math;", "export const r = M.random();"], ["Math.random:1"]],
  ["Date.parse and Date.UTC read no clock", ['export const t = [Date.parse("2026-09-30T00:00:00Z"), Date.UTC(2026, 8, 30)];'], []],
  ["new Date with an argument reads no clock", ["export const iso = (ms: number) => [new Date(ms).toISOString(), new Date(2026, 8, 30)];"], []],
  ["instanceof Date reads no clock", ["export const isDate = (v: unknown) => v instanceof Date;"], []],
  ["Date as a type is not a value", ["export let d: Date | null = null;", "export type C = typeof Date;"], []],
  ["the other members of Math are pure", ["export const n = Math.max(1, Math.floor(2.5), Math.PI, Math.imul(3, 4));"], []],
  ["a local Date or Math is not the global", [
    "export function f(Date: { now(): number }) { return Date.now(); }",
    "const Math = { random: () => 4 };",
    "export const r = Math.random();"
  ], []]
];

for (const [name, lines, expected] of clockCases) eq(name, freeGlobals("src/core/document/x.ts", lines), expected);

{
  const rules = findViolations(graph({
    "src/core/document/c.ts": "export const at = Date.now();\n",
    "src/core/text/r.ts": "export const n = Math.random();\n",
    "shared/h.js": '"use strict";\nmodule.exports = { at: () => new Date().toISOString(), parse: (s) => Date.parse(s) };\n',
    "shared/p.js": '"use strict";\nmodule.exports = { iso: (ms) => new Date(ms).toISOString() };\n',
    "src/contracts/k.ts": "export const k = Math.random();\n",
    "src/application/a.ts": "export const a = Date.now();\n",
    "src/js/legacy.js": "export const t = Date.now() + Math.random();\n",
    "src/adapters/identity/i.ts": "export const i = Date.now() + Math.random();\n"
  })).filter((v) => v.rule === "platform-global").map((v) => `${v.source} ${v.target}`);
  eq("core, shared, contracts and application may not read the clock or draw random numbers; legacy and adapters may", rules, [
    "shared/h.js global:Date",
    "src/application/a.ts global:Date",
    "src/contracts/k.ts global:Math.random",
    "src/core/document/c.ts global:Date",
    "src/core/text/r.ts global:Math.random"
  ]);
}

{
  const a = analyzeScript("shared/loader.js", [
    '"use strict";',
    'function viaParam(require) { return require("./a.js"); }',
    '{ const require = makeRequire(); require("./b.js"); }',
    'const c = require("./c.js");',
    "module.exports = { viaParam, c };"
  ].join("\n"));
  eq("a require parameter or block binding is not a load; the free require beside it is", a.imports.map((i) => i.spec), ["./c.js"]);
}

console.log("\nS importers and writers:\n");

const STATE_FILE = { "src/js/_state.js": "export const S = { state: undefined, dirty: false, editSeq: 0 };\n" };

function stateFindings(files) {
  return findViolations(graph({ ...STATE_FILE, ...files }))
    .filter((v) => v.rule === "state-import" || v.rule === "state-write")
    .map((v) => `${v.rule} ${v.source} ${v.target}`);
}

function writesOf(text) {
  return stateFindings({ "src/js/w.js": text }).filter((f) => f.startsWith("state-write ")).map((f) => f.split(" ")[2]);
}

eq("a named import of S is a state-import", stateFindings({ "src/js/a.js": 'import { S } from "./_state.js";\nexport const r = S.state;\n' }), ["state-import src/js/a.js global:S"]);
eq("an aliased import of S is a state-import", stateFindings({ "src/js/a.js": 'import { S as T } from "./_state.js";\nexport const r = T.dirty;\n' }), ["state-import src/js/a.js global:S"]);
eq("a namespace import of the state module is a state-import", stateFindings({ "src/js/a.js": 'import * as G from "./_state.js";\nexport const r = G.S.dirty;\n' }), ["state-import src/js/a.js global:S"]);
eq("a literal dynamic import of the state module is a state-import", stateFindings({ "src/js/a.js": 'export const p = import("./_state.js").then((m) => m.S);\n' }), ["state-import src/js/a.js global:S"]);
eq("a side-effect import binds nothing", stateFindings({ "src/js/a.js": 'import "./_state.js";\n' }), []);
eq("a module in an unknown src folder is production and its folder is reported", findViolations(graph({
  ...STATE_FILE,
  "src/util/helper.js": 'import { S } from "../js/_state.js";\nS.state = null;\n',
  "src/entry.js": 'import { S } from "./js/_state.js";\nS.dirty = true;\n'
})).map((v) => `${v.rule} ${v.source} ${v.target}`), [
  "state-import src/entry.js global:S",
  "state-import src/util/helper.js global:S",
  "state-write src/entry.js global:S.dirty",
  "state-write src/util/helper.js global:S.state",
  "unknown-layer src/entry.js src/",
  "unknown-layer src/util/helper.js src/util/"
]);
eq("tests and tools are not production importers", stateFindings({
  "src/test/a.test.mjs": 'import { S } from "../js/_state.js";\nS.state = null;\n',
  "tools/demo.mjs": 'import { S } from "../src/js/_state.js";\nS.dirty = 1;\n'
}), []);

const MUTATORS = ["push", "pop", "splice", "shift", "unshift", "sort", "reverse", "fill", "copyWithin"];

const writeCases = [
  ["a direct S.state assignment", "S.state = null;", ["global:S.state"]],
  ["element access with a literal key", 'S["state"] = {};', ["global:S.state"]],
  ["element access with a computed key", "S[key] = 1;", ["global:S[?]"]],
  ["compound assignment", "S.editSeq += 1;", ["global:S.editSeq"]],
  ["logical assignment", "S.dirty ??= true;", ["global:S.dirty"]],
  ["postfix increment", "S.editSeq++;", ["global:S.editSeq"]],
  ["prefix decrement", "--S.editSeq;", ["global:S.editSeq"]],
  ["delete", "delete S.state;", ["global:S.state"]],
  ["a parenthesised target", "(S.dirty) = true;", ["global:S.dirty"]],
  ["an array destructuring target", "[S.dirty] = [true];", ["global:S.dirty"]],
  ["an object destructuring target", "({ d: S.dirty } = o);", ["global:S.dirty"]],
  ["a for-of target", "for (S.dirty of [1]) void 0;", ["global:S.dirty"]],
  ["a nested assignment", "S.state.rows = [];", ["global:S.state.*"]],
  ["a nested length reset", "S.state.rows.length = 0;", ["global:S.state.*"]],
  ["a nested element write", 'S.state.rows[0].text = "x";', ["global:S.state.*"]],
  ["a nested delete", "delete S.state.rows[0];", ["global:S.state.*"]],
  ["Object.assign into a member", "Object.assign(S.state, patch);", ["global:S.state.*"]],
  ["Object.assign into S itself", "Object.assign(S, patch);", ["global:S.*"]],
  ["Reflect.set on S itself", 'Reflect.set(S, "dirty", true);', ["global:S.*"]],
  ["an optional-chain mutating call", "S.state?.rows?.push(1);", ["global:S.state.*"]],
  ...MUTATORS.map((m) => [`a ${m}() call`, `S.state.rows.${m}(x);`, ["global:S.state.*"]]),
  ["writes through a const alias", "const st = S.state;\nst.rows.length = 0;", ["global:S.state.*"]],
  ["writes through a var alias of S", "var s = S;\ns.dirty = true;", ["global:S.dirty"]],
  ["writes through a destructured alias", "const { state } = S;\nstate.rows.pop();", ["global:S.state.*"]],
  ["writes through an alias of an alias", "const st = S.state;\nconst rows = st.rows;\nrows.splice(0);", ["global:S.state.*"]],
  ["writes through an alias from a function declared before it", "function later() { st.x = 1; }\nconst st = S.state;\nlater();", ["global:S.state.*"]],
  ["writes through an iteration callback parameter", "S.state.rows.forEach(function (r) { r.done = true; });", ["global:S.state.*"]],
  ["writes through a reduce element parameter", "S.state.rows.reduce(function (acc, r) { r.seen = 1; return acc; }, 0);", ["global:S.state.*"]],
  ["writes through a for-of binding", "for (const row of S.state.rows) row.done = true;", ["global:S.state.*"]],
  ["a reduce accumulator", "S.state.rows.reduce(function (acc, r) { acc.push(r.id); return acc; }, []);", []],
  ["a reassigned callback parameter", "S.state.rows.forEach((r) => { r = { ...r }; r.done = true; });", []],
  ["reads", "const n = S.state.rows.length;\nconst copy = S.state.rows.slice().sort();\nif (S.dirty) void [n, copy];", []],
  ["a non-mutating method call", "S.state.rows.map(String);", []],
  ["mutating a copy", "const rows = S.state.rows.filter(Boolean);\nrows.push(1);", []],
  ["a reassigned let", "let st = S.state;\nst = {};\nst.rows = [];", []],
  ["a parameter named S", "export function f(S) { S.state = 1; }", []],
  ["a block-scoped S", "{ const S = { state: 1 }; S.state = 2; }", []],
  ["a local that shadows an alias", "const st = S.state;\nexport function g() { const st = {}; st.x = 1; }", []],
  ["an alias in a sibling function", "export function a() { const st = S.state; return st; }\nexport function b(st) { st.rows = []; }", []]
];

for (const [name, body, expected] of writeCases) {
  eq(`${expected.length ? "write" : "not a write"}: ${name}`, writesOf('import { S } from "./_state.js";\n' + body + "\n"), expected);
}

eq("write: through a namespace import", writesOf('import * as G from "./_state.js";\nG.S.state = {};\nG["S"].dirty = true;\n'), ["global:S.dirty", "global:S.state"]);
eq("write: through an aliased import with element access", writesOf('import { S as T } from "./_state.js";\nT["state"] = {};\n'), ["global:S.state"]);
eq("write: through a destructured dynamic import", writesOf('const { S } = await import("./_state.js");\nS.dirty = true;\n'), ["global:S.dirty"]);
eq("write: through a destructured require", writesOf('const { S } = require("./_state.js");\nS.dirty = true;\n'), ["global:S.dirty"]);
eq("a require that is a parameter loads nothing", stateFindings({ "src/js/a.js": 'export function f(require) { const { S } = require("./_state.js"); S.dirty = 1; }\n' }), []);
eq("an import type of S is still a state-import", stateFindings({ "src/js/t.ts": 'import type { S } from "./_state.js";\nexport type T = typeof S;\n' }), ["state-import src/js/t.ts global:S"]);

eq("each write target is described by what it does", findViolations(graph({
  ...STATE_FILE,
  "src/js/w.js": 'import { S } from "./_state.js";\nS.dirty = true;\nS.state.rows = [];\nObject.assign(S, patch);\nS[key] = 1;\n'
})).filter((v) => v.rule === "state-write").map((v) => `${v.target} ${v.detail}`), [
  "global:S.* changes members of S in place",
  "global:S.dirty replaces S.dirty",
  "global:S.state.* changes S.state in place",
  "global:S[?] replaces S[?]"
]);

eq("known false positive: an exported snapshot of a primitive member makes a bridge", stateFindings({
  "src/js/flag.js": 'import { S } from "./_state.js";\nexport const wasDirty = S.dirty;\n',
  "src/js/use.js": 'import { wasDirty } from "./flag.js";\nexport const w = wasDirty;\n'
}), ["state-import src/js/flag.js global:S", "state-import src/js/use.js global:S"]);

eq("export type { S } from is a bridge, as import type { S } is an importer", stateFindings({
  "src/js/types.ts": 'export type { S } from "./_state.js";\n'
}), ["state-import src/js/types.ts global:S"]);

{
  const chain = { "src/js/n1.js": 'export * as n1 from "./_state.js";\n' };
  for (let i = 2; i <= 7; i++) chain[`src/js/n${i}.js`] = `export * as n${i} from "./n${i - 1}.js";\n`;
  const found = findViolations(graph({ ...STATE_FILE, ...chain })).map((v) => `${v.rule} ${v.source}`);
  eq("a re-export chain longer than the report follows is reported where it stops", found.filter((f) => f.startsWith("state-bridge-limit")), ["state-bridge-limit src/js/n6.js"]);
  eq("and every bridge before it is still an importer", found.filter((f) => f.startsWith("state-import")).length, 5);
  const loop = findViolations(graph({ ...STATE_FILE, "src/js/loop.js": 'export { S } from "./_state.js";\nexport * as again from "./loop.js";\n' })).map((v) => `${v.rule} ${v.source}`);
  check("a module that re-exports itself under a new name stops and is reported", loop.includes("state-bridge-limit src/js/loop.js"), loop.join("\n"));
}

eq("export default S is a bridge", stateFindings({
  "src/js/d.js": 'import { S } from "./_state.js";\nexport default S;\n',
  "src/js/use.js": 'import St from "./d.js";\nSt.dirty = 1;\n'
}), [
  "state-import src/js/d.js global:S",
  "state-import src/js/use.js global:S",
  "state-write src/js/use.js global:S.dirty"
]);

eq("a re-export bridge is an importer, and so is its consumer", stateFindings({
  "src/js/bridge.js": 'export { S } from "./_state.js";\n',
  "src/js/use.js": 'import { S } from "./bridge.js";\nS.state = null;\n'
}), [
  "state-import src/js/bridge.js global:S",
  "state-import src/js/use.js global:S",
  "state-write src/js/use.js global:S.state"
]);

eq("a local re-export under another name is a bridge", stateFindings({
  "src/js/bridge.js": 'import { S } from "./_state.js";\nexport { S as State };\n',
  "src/js/use.js": 'import { State } from "./bridge.js";\nState.dirty = true;\n'
}), [
  "state-import src/js/bridge.js global:S",
  "state-import src/js/use.js global:S",
  "state-write src/js/use.js global:S.dirty"
]);

eq("export * and export * as are bridges", stateFindings({
  "src/js/star.js": 'export * from "./_state.js";\n',
  "src/js/ns.js": 'export * as all from "./_state.js";\n',
  "src/js/use.js": 'import { S } from "./star.js";\nimport { all } from "./ns.js";\nS.dirty = 1;\nall.S.state = null;\n'
}), [
  "state-import src/js/ns.js global:S",
  "state-import src/js/star.js global:S",
  "state-import src/js/use.js global:S",
  "state-write src/js/use.js global:S.dirty",
  "state-write src/js/use.js global:S.state"
]);

eq("an exported alias of an S member is a bridge its consumers write through", stateFindings({
  "src/js/facade.js": 'import { S } from "./_state.js";\nexport const live = S.state;\n',
  "src/js/use.js": 'import { live } from "./facade.js";\nlive.rows = [];\n'
}), [
  "state-import src/js/facade.js global:S",
  "state-import src/js/use.js global:S",
  "state-write src/js/use.js global:S.state.*"
]);

{
  const found = findViolations(graph({
    ...STATE_FILE,
    "src/legacy/state.ts": 'export { S } from "../js/_state.js";\n',
    "src/features/rows/view.ts": 'import { S } from "../../legacy/state.ts";\nexport const v = (): unknown => S.state;\n'
  })).map((v) => `${v.rule} ${v.source} ${v.target}`);
  check("a legacy re-export of S is a state-import", found.includes("state-import src/legacy/state.ts global:S"), found.join("\n"));
  check("a feature importing that bridge breaks the layer rule", found.includes("layer src/features/rows/view.ts src/legacy/state.ts"), found.join("\n"));
  check("and is itself a state-import", found.includes("state-import src/features/rows/view.ts global:S"), found.join("\n"));
}

console.log("\nmetrics():\n");

eq("metrics() reports the informational numbers", metrics(graph({
  ...STATE_FILE,
  "src/js/a.js": 'import { S } from "./_state.js";\nimport "./b.js";\nS.state = {};\nS.dirty = true;\nexport function n() { return S.editSeq; }\n',
  "src/js/b.js": 'import { S } from "./_state.js";\nimport "./a.js";\nS.state.rows.push(1);\n',
  "src/js/bridge.js": 'export { S } from "./_state.js";\n',
  "src/test/a.test.mjs": 'import "../js/a.js";\n'
})), {
  frontendModules: 4,
  largestFrontendRuntimeCycle: 2,
  frontendRuntimeCycles: 1,
  runtimeCycleEdges: 2,
  stateImporters: ["src/js/a.js", "src/js/b.js", "src/js/bridge.js"],
  stateBridges: ["src/js/bridge.js"],
  stateAssigners: ["src/js/a.js"],
  stateFieldWriters: [{ path: "src/js/a.js", writes: 2, reads: 1 }],
  stateWriters: [
    { path: "src/js/a.js", targets: ["global:S.dirty", "global:S.state"] },
    { path: "src/js/b.js", targets: ["global:S.state.*"] }
  ],
  migratedModules: 0
});

console.log("\ncycle edges:\n");

function cycleEdges(files) {
  return findViolations(graph(files)).filter((v) => v.rule === "cycle-edge").map((v) => `${v.source} -> ${v.target}`);
}

eq("both edges of a two-module legacy cycle", cycleEdges({ "src/js/l1.js": 'import "./l2.js";\n', "src/js/l2.js": 'import "./l1.js";\n' }), ["src/js/l1.js -> src/js/l2.js", "src/js/l2.js -> src/js/l1.js"]);
eq("an edge into a cycle is not part of it", cycleEdges({ "src/js/a.js": 'import "./b.js";\n', "src/js/b.js": 'import "./c.js";\n', "src/js/c.js": 'import "./b.js";\n' }), ["src/js/b.js -> src/js/c.js", "src/js/c.js -> src/js/b.js"]);
eq("a self-import", cycleEdges({ "src/js/s.js": 'import "./s.js";\n' }), ["src/js/s.js -> src/js/s.js"]);
eq("a literal dynamic import closes a runtime cycle", cycleEdges({ "src/js/d1.js": 'import "./d2.js";\n', "src/js/d2.js": 'export const load = () => import("./d1.js");\n' }), ["src/js/d1.js -> src/js/d2.js", "src/js/d2.js -> src/js/d1.js"]);
eq("type-only references do not make a runtime cycle", cycleEdges({
  "server/a.ts": 'import type { B } from "./b.ts";\nexport type A = B;\n',
  "server/b.ts": 'import type { A } from "./a.ts";\nexport type B = A;\n'
}), []);

console.log("\nviolations and baseline:\n");

{
  const g = graph({
    "src/core/document/a.ts": 'import { b } from "../../js/b.js";\nimport fs from "node:fs";\nexport const a = window;\n',
    "src/js/b.js": "export const b = 1;\n",
    "src/features/rows/v.ts": 'import { f } from "../find/f.ts";\nexport const v = f;\n',
    "src/features/find/f.ts": "export const f = 1;\n",
    "src/application/s.ts": 'import { m } from "./missing.ts";\nexport const s = m;\n'
  });
  const rules = findViolations(g).map((v) => `${v.rule} ${v.source} ${v.target}`);
  check("core importing legacy is a layer violation", rules.includes("layer src/core/document/a.ts src/js/b.js"), rules.join("\n"));
  check("core importing a builtin is a platform-import violation", rules.includes("platform-import src/core/document/a.ts builtin:fs"), rules.join("\n"));
  check("core using window is a platform-global violation", rules.includes("platform-global src/core/document/a.ts global:window"), rules.join("\n"));
  check("feature to feature is a layer violation", rules.includes("layer src/features/rows/v.ts src/features/find/f.ts"), rules.join("\n"));
  check("an unresolvable relative import is reported", rules.includes("missing-module src/application/s.ts src/application/missing.ts"), rules.join("\n"));
}

eq("violations sort by code point, field by field, not by locale", findViolations(graph({
  "src/core/document/t.ts": "export const t = [clearTimeout, TextDecoder, URL, setTimeout, AbortController];\n"
})).map((v) => v.target), ["global:AbortController", "global:TextDecoder", "global:URL", "global:clearTimeout", "global:setTimeout"]);

{
  const before = findViolations(graph({ "src/core/document/a.ts": 'import { x } from "../../js/x.js";\n', "src/js/x.js": "", "src/js/y.js": "" }));
  const after = findViolations(graph({ "src/core/document/a.ts": 'import { y } from "../../js/y.js";\n', "src/js/x.js": "", "src/js/y.js": "" }));
  eq("the swap keeps the violation count equal", after.length, before.length);
  const { added, resolved } = compareBaseline(after, { exceptions: before });
  eq("a new forbidden edge fails even when the count does not grow", added.map((v) => v.target), ["src/js/y.js"]);
  eq("the replaced exception is reported as resolved", resolved.map((v) => v.target), ["src/js/x.js"]);
}

{
  const g = graph({
    "src/core/document/a.ts": 'import type { B } from "./b.ts";\nexport type A = B;\n',
    "src/core/document/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\nexport type B = number;\n',
    "src/js/l1.js": 'import "./l2.js";\n',
    "src/js/l2.js": 'import "./l1.js";\n'
  });
  const cycles = migratedCycles(g);
  eq("a type-only cycle in core is caught by the type-inclusive graph", cycles.map((c) => c.graph), ["with-types"]);
  check("a legacy-only cycle is not a migrated cycle", cycles.every((c) => !c.modules.includes("src/js/l1.js")));
}

{
  const g = graph({
    "src/bootstrap/root.ts": 'import "../js/boot.js";\n',
    "src/js/boot.js": 'import "./mid.js";\n',
    "src/js/mid.js": 'import "../bootstrap/root.ts";\n'
  });
  const cycles = migratedCycles(g);
  check("a cycle through legacy modules involving migrated code is caught", cycles.some((c) => c.graph === "runtime" && c.modules.length === 3), JSON.stringify(cycles));
}

console.log("\nrun() over a repository:\n");

const work = mkdtempSync(join(tmpdir(), "splitpage-dep-report-"));

function repoWith(files) {
  const repo = mkdtempSync(join(work, "repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFiles(repo, files);
  return repo;
}

function runIn(repo, mode) {
  const out = [];
  const err = [];
  const code = run({ repo, baselinePath: join(repo, "baseline.json"), mode, print: (l) => out.push(l), printError: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

try {
  const repo = repoWith({
    "shared/p.js": '"use strict";\nmodule.exports = new URL("https://x.test");\n',
    "src/js/a.js": 'import "../../shared/p.js";\n'
  });
  eq("init records the existing exception", runIn(repo, "init").code, 0);
  const baseline = JSON.parse(readFileSync(join(repo, "baseline.json"), "utf8"));
  eq("the baseline names source, target and rule", baseline.exceptions, [{ rule: "platform-global", source: "shared/p.js", target: "global:URL" }]);
  eq("a clean check exits 0", runIn(repo, "check").code, 0);
  eq("init refuses to overwrite a baseline", runIn(repo, "init").code, 2);

  writeFileSync(join(repo, "shared/p.js"), '"use strict";\nmodule.exports = fetch;\n');
  const swapped = runIn(repo, "check");
  eq("swapping one exception for another fails", swapped.code, 1);
  check("the new edge is named", swapped.err.includes("new platform-global: shared/p.js:2 -> global:fetch"), swapped.err);
  eq("prune will not accept a new exception", runIn(repo, "prune").code, 1);

  writeFileSync(join(repo, "shared/p.js"), '"use strict";\nmodule.exports = 1;\n');
  const resolved = runIn(repo, "check");
  eq("a resolved exception left in the baseline fails", resolved.code, 1);
  check("it says to prune", resolved.err.includes("--prune"), resolved.err);
  eq("prune removes it", runIn(repo, "prune").code, 0);
  eq("the pruned baseline is empty", JSON.parse(readFileSync(join(repo, "baseline.json"), "utf8")).exceptions, []);
  eq("and the check passes again", runIn(repo, "check").code, 0);

  mkdirSync(join(repo, "src/core/document"), { recursive: true });
  writeFileSync(join(repo, "src/core/document/a.ts"), 'import "./b.ts";\n');
  writeFileSync(join(repo, "src/core/document/b.ts"), 'import "./a.ts";\n');
  const cyclic = runIn(repo, "check");
  eq("a cycle in core fails the check", cyclic.code, 1);
  check("the cycle is named", cyclic.err.includes("cycle (runtime)"), cyclic.err);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("\nthe CLI against a temporary git repository:\n");

const cacheDir = join(ROOT, ".cache");
mkdirSync(cacheDir, { recursive: true });
const cliWork = mkdtempSync(join(cacheDir, "dep-report-test-"));

const LEGACY = {
  "src/js/_state.js": "export const S = { state: undefined, dirty: false };\n",
  "src/js/a.js": 'import { S } from "./_state.js";\nimport { b } from "./b.js";\nexport function a() { return S.state ? b() : 0; }\n',
  "src/js/b.js": 'import { S } from "./_state.js";\nimport { f } from "./f.js";\nexport function b() { S.state = { rows: [] }; return f(); }\n',
  "src/js/f.js": 'import { a } from "./a.js";\nexport function f() { return a; }\n',
  "src/js/c.js": "export const c = 1;\n"
};

function cli(repo, ...args) {
  const r = spawnSync(process.execPath, ["tools/dep-report.mjs", ...args], { cwd: repo, encoding: "utf8" });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function cliRepo(files) {
  const repo = mkdtempSync(join(cliWork, "repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "tools"));
  for (const f of CLI_FILES) copyFileSync(join(TOOLS, f), join(repo, "tools", f));
  writeFiles(repo, files);
  return repo;
}

function attempt(repo, files) {
  const saved = Object.fromEntries(Object.keys(files).map((p) => [p, existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : null]));
  writeFiles(repo, files);
  const r = cli(repo);
  for (const [p, text] of Object.entries(saved)) {
    if (text === null) rmSync(join(repo, p));
    else writeFileSync(join(repo, p), text);
  }
  return r;
}

function lines(r, prefix) {
  return r.err.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l.startsWith(prefix)).map((l) => l.replace(/ \(.*\)$/, "")).sort();
}

try {
  const repo = cliRepo(LEGACY);
  const init = cli(repo, "--init");
  eq("--init on the legacy fixture exits 0", init.code, 0);
  const recorded = JSON.parse(readFileSync(join(repo, "tools/dep-baseline.json"), "utf8")).exceptions.map((e) => `${e.rule} ${e.source} ${e.target}`);
  eq("the baseline records the legacy debt exactly", recorded, [
    "cycle-edge src/js/a.js src/js/b.js",
    "cycle-edge src/js/b.js src/js/f.js",
    "cycle-edge src/js/f.js src/js/a.js",
    "state-import src/js/a.js global:S",
    "state-import src/js/b.js global:S",
    "state-write src/js/b.js global:S.state"
  ]);
  eq("the unchanged fixture passes", cli(repo).code, 0);

  const swap = attempt(repo, {
    "src/js/a.js": 'import { b } from "./b.js";\nexport function a() { return b(); }\n',
    "src/js/c.js": 'import { S } from "./_state.js";\nexport const c = S.dirty;\n'
  });
  eq("a new S importer fails even when another importer goes in the same change", swap.code, 1);
  eq("the new importer is named", lines(swap, "new state-"), ["new state-import: src/js/c.js:1 -> global:S"]);
  eq("the removed importer is resolved", lines(swap, "resolved state-"), ["resolved state-import: src/js/a.js -> global:S"]);

  const writer = attempt(repo, { "src/js/a.js": 'import { S } from "./_state.js";\nimport { b } from "./b.js";\nexport function a() { S.state = null; return b(); }\n' });
  eq("a new S.state writer fails", writer.code, 1);
  eq("it is the only change reported", lines(writer, ""), ["dep-report: FAILED", "new state-write: src/js/a.js:3 -> global:S.state"]);

  const namespaced = attempt(repo, { "src/js/a.js": 'import * as G from "./_state.js";\nimport { b } from "./b.js";\nexport function a() { G.S.state.rows = []; return b(); }\n' });
  eq("a nested write through a namespace import fails", namespaced.code, 1);
  eq("the namespace import still counts as the same importer", lines(namespaced, ""), ["dep-report: FAILED", "new state-write: src/js/a.js:3 -> global:S.state.*"]);

  const aliased = attempt(repo, { "src/js/a.js": 'import { S as T } from "./_state.js";\nimport { b } from "./b.js";\nexport function a() { T["dirty"] = true; return b(); }\n' });
  eq("an element-access write through an aliased import fails", aliased.code, 1);
  eq("it names the member", lines(aliased, ""), ["dep-report: FAILED", "new state-write: src/js/a.js:3 -> global:S.dirty"]);

  const viaAlias = attempt(repo, { "src/js/a.js": 'import { S } from "./_state.js";\nimport { b } from "./b.js";\nexport function a() {\n  const st = S.state;\n  st.rows.push(1);\n  return b();\n}\n' });
  eq("a mutating call through a local alias fails", viaAlias.code, 1);
  eq("it is reported at the call", lines(viaAlias, ""), ["dep-report: FAILED", "new state-write: src/js/a.js:5 -> global:S.state.*"]);

  const bridge = attempt(repo, {
    "src/legacy/state.ts": 'export { S } from "../js/_state.js";\n',
    "src/features/rows/view.ts": 'import { S } from "../../legacy/state.ts";\nexport const v = (): unknown => S.state;\n'
  });
  eq("a re-export bridge and a feature using it fail", bridge.code, 1);
  eq("the bridge, the feature's import and its layer breach are all named", lines(bridge, "new "), [
    "new layer: src/features/rows/view.ts:1 -> src/legacy/state.ts",
    "new state-import: src/features/rows/view.ts:1 -> global:S",
    "new state-import: src/legacy/state.ts:1 -> global:S"
  ]);

  const outside = attempt(repo, { "src/util/helper.js": 'import { S } from "../js/_state.js";\nS.state = null;\n' });
  eq("an S writer in a src folder outside the layer table fails", outside.code, 1);
  eq("its folder, import and write are all named", lines(outside, "new "), [
    "new state-import: src/util/helper.js:1 -> global:S",
    "new state-write: src/util/helper.js:2 -> global:S.state",
    "new unknown-layer: src/util/helper.js -> src/util/"
  ]);

  const twoFile = attempt(repo, { "src/js/d.js": 'import "./e.js";\n', "src/js/e.js": 'import "./d.js";\n' });
  eq("a new two-module legacy cycle fails", twoFile.code, 1);
  eq("both of its edges are named", lines(twoFile, "new "), ["new cycle-edge: src/js/d.js:1 -> src/js/e.js", "new cycle-edge: src/js/e.js:1 -> src/js/d.js"]);

  const inner = attempt(repo, { "src/js/a.js": LEGACY["src/js/a.js"] + 'import "./f.js";\n' });
  eq("a new edge between two modules already in the cycle fails", inner.code, 1);
  eq("the new edge is named", lines(inner, "new "), ["new cycle-edge: src/js/a.js:4 -> src/js/f.js"]);

  const joined = attempt(repo, {
    "src/js/c.js": 'import { a } from "./a.js";\nexport const c = a;\n',
    "src/js/f.js": 'import { a } from "./a.js";\nimport "./c.js";\nexport function f() { return a; }\n'
  });
  eq("a module joining the existing cycle fails", joined.code, 1);
  eq("the edges that close the loop are named", lines(joined, "new "), ["new cycle-edge: src/js/c.js:1 -> src/js/a.js", "new cycle-edge: src/js/f.js:2 -> src/js/c.js"]);

  const acyclic = attempt(repo, { "src/js/g.js": 'import { a } from "./a.js";\nimport { f } from "./f.js";\nexport const g = [a, f];\n' });
  eq("a new acyclic legacy module importing cycle members passes", acyclic.code, 0);

  writeFiles(repo, {
    "src/js/b.js": 'import { S } from "./_state.js";\nimport { f } from "./f.js";\nexport function b() { return S.state && f(); }\n',
    "src/js/f.js": "export function f() { return 1; }\n"
  });
  const paid = cli(repo);
  eq("removing debt without pruning fails", paid.code, 1);
  eq("every resolved entry is listed", lines(paid, "resolved "), [
    "resolved cycle-edge: src/js/a.js -> src/js/b.js",
    "resolved cycle-edge: src/js/b.js -> src/js/f.js",
    "resolved cycle-edge: src/js/f.js -> src/js/a.js",
    "resolved state-write: src/js/b.js -> global:S.state"
  ]);
  eq("--prune accepts it", cli(repo, "--prune").code, 0);
  eq("the pruned baseline keeps only the importers", JSON.parse(readFileSync(join(repo, "tools/dep-baseline.json"), "utf8")).exceptions.map((e) => `${e.rule} ${e.source}`), ["state-import src/js/a.js", "state-import src/js/b.js"]);
  eq("and the check passes", cli(repo).code, 0);

  const r = spawnSync(process.execPath, [join(TOOLS, "dep-report.mjs"), "--bogus"], { encoding: "utf8" });
  eq("an unknown argument exits 2", r.status, 2);

  const accepting = cliRepo(LEGACY);
  cli(accepting, "--init");
  const baselineFile = join(accepting, "tools/dep-baseline.json");
  const initial = readFileSync(baselineFile, "utf8");
  writeFiles(accepting, { "src/js/a.js": LEGACY["src/js/a.js"] + 'import "./f.js";\n' });
  const moved = cli(accepting);
  eq("moving a helper between two cycle members fails the check", moved.code, 1);
  check("the summary counts the baseline and the new entries separately", moved.out.includes("6 exceptions in the baseline, 1 new, 0 resolved"), moved.out);
  eq("--accept without a reason exits 2", cli(accepting, "--accept").code, 2);
  eq("--accept with a blank reason exits 2", cli(accepting, "--accept", "  ").code, 2);
  eq("and leaves the baseline alone", readFileSync(baselineFile, "utf8"), initial);
  const accepted = cli(accepting, "--accept", "helper moved from b.js to f.js; a.js now calls it directly");
  eq("--accept with a reason exits 0", accepted.code, 0);
  check("it prints what it added", accepted.out.includes("+ cycle-edge: src/js/a.js:4 -> src/js/f.js"), accepted.out);
  const afterAccept = JSON.parse(readFileSync(baselineFile, "utf8")).exceptions;
  eq("exactly the new entry is added, with the reason", afterAccept.filter((e) => e.reason), [
    { rule: "cycle-edge", source: "src/js/a.js", target: "src/js/f.js", reason: "helper moved from b.js to f.js; a.js now calls it directly" }
  ]);
  eq("the other entries are unchanged", afterAccept.filter((e) => !e.reason).length, 6);
  eq("the check passes after --accept", cli(accepting).code, 0);

  writeFiles(accepting, { "src/js/b.js": 'import { S } from "./_state.js";\nimport { f } from "./f.js";\nexport function b() { S.dirty = true; return f(); }\n' });
  const mixed = cli(accepting, "--accept", "b.js sets the dirty flag while it waits for the session owner");
  eq("--accept adds new entries but does not prune", [mixed.code, cli(accepting).code], [0, 1]);
  check("and says what is left to prune", mixed.out.includes("1 resolved"), mixed.out);
  eq("--prune then removes the resolved entry and keeps both reasons", [cli(accepting, "--prune").code, JSON.parse(readFileSync(baselineFile, "utf8")).exceptions.filter((e) => e.reason).map((e) => e.target)], [0, ["src/js/f.js", "global:S.dirty"]]);
  eq("and the check passes", cli(accepting).code, 0);

  writeFiles(accepting, { "src/core/document/a.ts": 'import "./b.ts";\n', "src/core/document/b.ts": 'import "./a.ts";\n' });
  const beforeCycle = readFileSync(baselineFile, "utf8");
  const refused = cli(accepting, "--accept", "trying to accept a cycle in core");
  eq("--accept refuses while a cycle runs through a migrated folder", refused.code, 1);
  eq("and writes nothing", readFileSync(baselineFile, "utf8"), beforeCycle);

  const linkedRepo = cliRepo({ "src/js/a.js": "export const a = 1;\n" });
  symlinkSync(join(linkedRepo, "tools"), join(linkedRepo, "linked"), "junction");
  const viaLink = (...args) => spawnSync(process.execPath, [join("linked", "dep-report.mjs"), ...args], { cwd: linkedRepo, encoding: "utf8" });
  eq("run through a linked folder, an unknown argument still exits 2", viaLink("--bogus").status, 2);
  const linkedMetrics = viaLink("--metrics");
  eq("run through a linked folder, the report still runs", [linkedMetrics.status, linkedMetrics.stdout.includes("frontendModules")], [0, true]);

  const sorted = cliRepo({ "shared/t.js": '"use strict";\nmodule.exports = [clearTimeout, TextDecoder, URL, setTimeout];\n' });
  cli(sorted, "--init");
  const initText = readFileSync(join(sorted, "tools/dep-baseline.json"), "utf8");
  eq("--init writes the baseline in code-point order", JSON.parse(initText).exceptions.map((e) => e.target), ["global:TextDecoder", "global:URL", "global:clearTimeout", "global:setTimeout"]);
  eq("--prune rewrites the same bytes", [cli(sorted, "--prune").code, readFileSync(join(sorted, "tools/dep-baseline.json"), "utf8") === initText], [0, true]);
} finally {
  rmSync(cliWork, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
