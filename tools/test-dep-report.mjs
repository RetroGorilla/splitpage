import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  layerOf, layerAllows, analyzeScript, buildGraph, findViolations, migratedCycles, compareBaseline, metrics, run, loadGraph, stronglyConnected,
  legacyMeasurements, legacyMetrics, legacyViolations, assertLegacyMetrics, loopModel
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

console.log("\nDOM globals:\n");

const DOM_GLOBALS = [
  "DOMParser", "XMLSerializer", "Node", "Element", "HTMLElement", "Text", "DocumentFragment",
  "Range", "Selection", "getSelection", "getComputedStyle",
  "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "Event", "CustomEvent", "EventTarget", "KeyboardEvent", "MouseEvent",
  "CSS", "matchMedia", "alert", "confirm", "prompt", "open",
  "Option", "Audio", "HTMLCanvasElement", "OffscreenCanvas", "createImageBitmap", "structuredClone",
  "atob", "btoa", "postMessage", "addEventListener", "removeEventListener", "dispatchEvent"
];

for (const name of DOM_GLOBALS) {
  eq(`a bare ${name} reference in core is a platform global`, freeGlobals("src/core/document/x.ts", [`export const r = [${name}];`]), [`${name}:1`]);
}

const domCases = [
  ["the reviewer's probe: the use of an ambient DOMParser is a free reference", [
    "declare const DOMParser: new () => { parseFromString(s: string, m: string): unknown };",
    'export function reviewPlatformProbe(s: string): unknown { return new DOMParser().parseFromString(s, "text/html"); }'
  ], ["DOMParser:2"]],
  ["a use of XMLSerializer is reported", [
    "export const s = (n: unknown) => new XMLSerializer().serializeToString(n);"
  ], ["XMLSerializer:1"]],
  ["an ambient XMLSerializer does not hide its use", [
    "declare var XMLSerializer: new () => { serializeToString(n: unknown): string };",
    "export const s = (n: unknown) => new XMLSerializer().serializeToString(n);"
  ], ["XMLSerializer:2"]],
  ["an ambient interface does not hide a free type reference to a listed name", [
    "declare interface Text { data: string }",
    "export const t = (x: Text): string => x.data;"
  ], ["Text:2"]],
  ["a local type named Text or Range is not the global", [
    "type Text = { runs: string[] };",
    "interface Range { from: number; to: number }",
    "export const t = (x: Text, r: Range): number => x.runs.length + r.to - r.from;"
  ], []],
  ["a local class named Event or Node is not the global", [
    "class Event { at = 0; }",
    "class Node { next: Node | null = null; }",
    "export const e = [new Event(), new Node()];"
  ], []],
  ["an imported Selection, Range or Option is not the global", [
    'import type { Selection, Range } from "./model.ts";',
    'import { Option } from "./option.ts";',
    "export const o = (s: Selection, r: Range) => Option.some([s, r]);"
  ], []],
  ["a parameter or local named open, prompt or confirm is not the global", [
    "export function f(open: boolean, prompt: string) { const confirm = open ? prompt : ''; return confirm; }"
  ], []],
  ["a property, method or key named open, alert or postMessage is not a reference", [
    "const o = { open: 1, alert() { return 2; }, postMessage: 3 };",
    "export const r = [o.open, o.alert(), o.postMessage];"
  ], []],
  ["a type reference to a free DOM type is reported", ["export type N = Node;", "export const f = (e: Event, t: Text): void => { void [e, t]; };"], ["Event:2", "Node:1", "Text:2"]],
  ["a DOM global through globalThis is globalThis", ["export const p = new globalThis.DOMParser();"], ["globalThis:1"]]
];

for (const [name, lines, expected] of domCases) eq(name, freeGlobals("src/core/document/x.ts", lines), expected);

console.log("\neval and Function:\n");

const codeCases = [
  ["an indirect eval is reported", ['export const r = (0, eval)("1 + 1");'], ["eval:1"]],
  ["a direct eval is reported", ['export const r = eval("1 + 1");'], ["eval:1"]],
  ["eval as a value is reported", ["export const e = eval;"], ["eval:1"]],
  ["new Function is reported", ['export const f = new Function("a", "return a");'], ["Function:1"]],
  ["Function called without new is reported", ['export const f = Function("return 1");'], ["Function:1"]],
  ["Function as a value is reported", ["const F = Function;", 'export const f = new F("return 1");'], ["Function:1"]],
  ["Function.prototype is reported", ["export const p = Function.prototype;"], ["Function:1"]],
  ["the Function type in a type position is not reported", [
    "export const call = (f: Function): unknown => (f as () => unknown)();",
    "export type Handler = Function | null;",
    "export interface Box { fn: Function }",
    "export class K implements Box { fn: Function = () => 1; }"
  ], []],
  ["instanceof Function is not reported", ["export const isFn = (v: unknown) => v instanceof Function;"], []],
  ["typeof on a value named eval or Function in a type query is not reported", ["export type T = typeof eval;", "export type U = typeof Function;"], []],
  ["a local eval or Function is not the global", [
    "export function f(eval_: number) { return eval_; }",
    "const Function = class { run() { return 1; } };",
    "export const g = new Function().run();"
  ], []],
  ["a method or property named eval or Function is not a reference", [
    "const o = { eval: 1, Function: 2, run() { return 3; } };",
    "export const r = [o.eval, o.Function, o.run()];"
  ], []]
];

for (const [name, lines, expected] of codeCases) eq(name, freeGlobals("src/core/document/x.ts", lines), expected);

console.log("\nambient declarations:\n");

function ambientsOf(path, lines) {
  return (analyzeScript(path, lines.join("\n")).ambients ?? []).map((a) => `${a.name}:${a.line}`).sort();
}

const ambientCases = [
  ["an ambient declare const is reported although nothing uses it", ["declare const DOMParser: new () => unknown;", "export const x = 1;"], ["DOMParser:1"]],
  ["an ambient declare let is reported", ["declare let counter: number;"], ["counter:1"]],
  ["an ambient declare var is reported", ["declare var Node: unknown;"], ["Node:1"]],
  ["an ambient declare function is reported", ["declare function atob(s: string): string;"], ["atob:1"]],
  ["every overload of an ambient function is one finding", ["declare function f(a: number): number;", "declare function f(a: string): string;"], ["f:1"]],
  ["an ambient declare class is reported", ["declare class MutationObserver { observe(n: unknown): void }"], ["MutationObserver:1"]],
  ["an ambient declare abstract class is reported", ["declare abstract class Base { abstract run(): void }"], ["Base:1"]],
  ["an ambient declare enum and const enum are reported", ["declare enum Color { Red }", "declare const enum Mode { A }"], ["Color:1", "Mode:2"]],
  ["an exported ambient declare is reported", ["export declare const structuredClone: <T>(v: T) => T;"], ["structuredClone:1"]],
  ["an ambient declare of an unlisted name is reported", ["declare const FormData: new () => unknown;", "export const f = new FormData();"], ["FormData:1"]],
  ["an ambient declare of an existing platform global is reported", ["declare const window: { name: string };"], ["window:1"]],
  ["an ambient declare of the clock is reported", ["declare const Date: { now(): number };", "declare const Math: { random(): number };"], ["Date:1", "Math:2"]],
  ["an ambient build constant is reported", ["declare const __BUILD__: string;", "export const b = __BUILD__;"], ["__BUILD__:1"]],
  ["an ambient value inside declare global is reported", [
    "export {};",
    "declare global {",
    "  var getSelection: () => unknown;",
    "  function open(): void;",
    "  class Widget {}",
    "  namespace Extra { const x: number }",
    "}"
  ], ["Extra:6", "Widget:5", "getSelection:3", "open:4"]],
  ["a destructured ambient name is reported", ["declare const { DOMParser }: any;"], ["DOMParser:1"]],
  ["a renamed, nested, rest and array destructured ambient are reported", [
    "declare const { a: A, b: { B }, ...rest }: any;",
    "declare const [first, [second], ...others]: any;"
  ], ["A:1", "B:1", "first:2", "others:2", "rest:1", "second:2"]],
  ["a multi-declarator ambient reports every name", ["declare const a: number, DOMParser: unknown;"], ["DOMParser:1", "a:1"]],
  ["a declare namespace is reported", ["declare namespace Intl2 { const x: number }"], ["Intl2:1"]],
  ["a dotted declare namespace reports its root", ["declare namespace A.B.C { const x: number }"], ["A:1"]],
  ["a declare module with a string name is reported", ['declare module "virtual-thing" { export const v: number }'], ['"virtual-thing":1']],
  ["a declare module with an identifier name is reported", ["declare module Legacy { const v: number }"], ["Legacy:1"]],
  ["a type-only ambient is allowed", [
    "declare interface Text { data: string }",
    "declare type Range = [number, number];",
    "declare global { interface Window { extra: number } type Id = string }"
  ], []],
  ["a file with no ambient declaration reports none", ["export const a = 1;", "export type T = number;"], []],
  ["a lib reference directive is reported", ['/// <reference lib="dom" />', "export const a = 1;"], ['reference lib="dom":1']],
  ["a types reference directive is reported", ['/// <reference types="node" />', "export const a = 1;"], ['reference types="node":1']],
  ["a path reference directive is reported", ['/// <reference path="./env.d.ts" />', "export const a = 1;"], ['reference path="./env.d.ts":1']]
];

for (const [name, lines, expected] of ambientCases) eq(name, ambientsOf("src/core/document/x.ts", lines), expected);

{
  const lines = ["declare const FormData: new () => unknown;", "export const f = new FormData();"];
  eq("an ambient declaration is not also a free reference to itself", freeGlobals("src/core/document/x.ts", ["declare const __BUILD__: string;"]), []);
  eq("the unlisted use beside an ambient declaration is not a global; the declaration is the finding", [freeGlobals("src/core/document/x.ts", lines), ambientsOf("src/core/document/x.ts", lines)], [[], ["FormData:1"]]);
}

{
  const compile = (files) => {
    const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, "tsconfig.core.json"), ts.sys.readFile).config, ts.sys, ROOT);
    const virtual = new Map(Object.entries(files).map(([name, text]) => [join(ROOT, name).replaceAll("\\", "/"), text]));
    const host = ts.createCompilerHost(config.options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...rest) => (virtual.has(name) ? ts.createSourceFile(name, virtual.get(name), config.options.target) : getSourceFile(name, ...rest));
    host.fileExists = ((exists) => (name) => virtual.has(name) || exists(name))(host.fileExists.bind(host));
    host.readFile = ((read) => (name) => virtual.get(name) ?? read(name))(host.readFile.bind(host));
    const program = ts.createProgram([...virtual.keys()], config.options, host);
    return { diagnostics: ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) };
  };
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, "tsconfig.core.json"), ts.sys.readFile).config, ts.sys, ROOT);
  const libs = (config.options.lib ?? []).map((l) => l.toLowerCase());
  check("core's tsconfig has no DOM, WebWorker or ScriptHost lib", libs.length > 0 && !libs.some((l) => /dom|webworker|scripthost/.test(l)), JSON.stringify(libs));
  eq("core's tsconfig loads no ambient @types packages", config.options.types, []);
  const bare = compile({ "src/core/document/probe-dom.ts": 'export const f = new FormData();\nexport const p = new DOMParser();\nexport const t = document.title;\n' });
  check("core's typecheck rejects undeclared DOM names", ["FormData", "DOMParser", "document"].every((n) => bare.diagnostics.some((d) => d.includes(`'${n}'`))), JSON.stringify(bare.diagnostics));
}

{
  const rules = findViolations(graph({
    "src/core/document/text-policy.ts": [
      "declare const DOMParser: new () => { parseFromString(s: string, m: string): unknown };",
      'export function reviewPlatformProbe(s: string): unknown { return new DOMParser().parseFromString(s, "text/html"); }'
    ].join("\n"),
    "src/core/text/s.ts": "export const s = (n: unknown) => new XMLSerializer().serializeToString(n);\n",
    "src/core/text/ok.ts": "type Text = { runs: string[] };\nexport const n = (t: Text) => t.runs.length;\n",
    "src/core/text/form.ts": "declare const FormData: new () => unknown;\nexport const f = new FormData();\n",
    "src/core/text/code.ts": 'export const e = (0, eval)("1");\nexport const g = new Function("return 1");\n',
    "src/application/a.ts": "declare const __BUILD__: string;\nexport const b = __BUILD__;\n",
    "src/contracts/c.ts": "declare global { var leak: number }\nexport {};\n",
    "shared/s.js": '"use strict";\nmodule.exports = { f: () => 1 };\n',
    "src/adapters/dom/p.ts": "declare const FormData: new () => unknown;\nexport const p = [new DOMParser(), new FormData()];\n"
  })).filter((v) => v.rule === "platform-global").map((v) => `${v.source} ${v.target}`);
  eq("core, contracts and application may use or declare no DOM or ambient value; an adapter may", rules, [
    "src/application/a.ts ambient:__BUILD__",
    "src/contracts/c.ts ambient:leak",
    "src/core/document/text-policy.ts ambient:DOMParser",
    "src/core/document/text-policy.ts global:DOMParser",
    "src/core/text/code.ts global:Function",
    "src/core/text/code.ts global:eval",
    "src/core/text/form.ts ambient:FormData",
    "src/core/text/s.ts global:XMLSerializer"
  ]);
}

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

console.log("\nINV-10, HTML into cells:\n");

const ADAPTER_FILES = {
  "src/adapters/richtext/decode.ts": "export const decode = (html: string): string[] => [html];\n",
  "src/adapters/richtext/richtext.ts": "export type RichText = { decode(html: string): string[] };\nexport const createRichText = (): RichText => ({ decode: (h) => [h] });\n"
};

function htmlCells(files) {
  return findViolations(graph({ ...ADAPTER_FILES, ...files }))
    .filter((v) => v.rule === "html-cells")
    .map((v) => `${v.source}:${v.line} ${v.target}`);
}

function htmlSinks(text, path = "src/js/h.js") {
  return htmlCells({ [path]: text }).map((f) => f.split(" ")[1]);
}

eq("the adapter itself may parse HTML and import its own modules", htmlCells({
  "src/adapters/richtext/sanitize.ts": 'import { decode } from "./decode.ts";\nexport const s = (h: string, p: { parseFromString(a: string, b: string): unknown }) => [decode(h), p.parseFromString(h, "text/html")];\n'
}), []);
eq("the bridge may import the adapter and parse", htmlCells({
  "src/legacy/richtext.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nimport { decode } from "../adapters/richtext/decode.ts";\nexport const r = [createRichText(), decode("")];\n'
}), []);
eq("another legacy module importing the adapter is reported", htmlCells({
  "src/legacy/document-ports.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nexport const r = createRichText();\n'
}), ["src/legacy/document-ports.ts:1 src/adapters/richtext/richtext.ts"]);
eq("a numbered legacy module importing the decoder is reported", htmlCells({
  "src/js/05-x.js": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const d = decode;\n'
}), ["src/js/05-x.js:1 src/adapters/richtext/decode.ts"]);
eq("bootstrap importing the adapter is reported", htmlCells({
  "src/bootstrap/main.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nexport const r = createRichText();\n'
}), ["src/bootstrap/main.ts:1 src/adapters/richtext/richtext.ts"]);
eq("a re-export of the decoder is reported", htmlCells({
  "src/legacy/other.ts": 'export { decode } from "../adapters/richtext/decode.ts";\n'
}), ["src/legacy/other.ts:1 src/adapters/richtext/decode.ts"]);
eq("a dynamic import and a require of the decoder are reported", htmlCells({
  "src/js/late.js": 'export const l = () => import("../adapters/richtext/decode.ts");\n',
  "server/s.js": '"use strict";\nmodule.exports = require("../src/adapters/richtext/decode.ts");\n'
}), ["server/s.js:2 src/adapters/richtext/decode.ts", "src/js/late.js:1 src/adapters/richtext/decode.ts"]);
eq("a type-only import of the adapter is not a decoder", htmlCells({
  "src/legacy/types.ts": 'import type { RichText } from "../adapters/richtext/richtext.ts";\nexport type T = RichText;\n'
}), []);
eq("tests and tools may import the adapter", htmlCells({
  "src/test/x.test.mjs": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const d = decode;\n',
  "tests/adapters/richtext/golden.test.ts": 'import { decode } from "../../../src/adapters/richtext/decode.ts";\nexport const d = decode;\n',
  "tools/probe.mjs": 'import { decode } from "../src/adapters/richtext/decode.ts";\nexport const d = decode;\n'
}), []);
eq("a module that imports the adapter's neighbour is not reported", htmlCells({
  "src/adapters/identity/ids.ts": "export const id = 1;\n",
  "src/legacy/ids.ts": 'import { id } from "../adapters/identity/ids.ts";\nexport const i = id;\n'
}), []);

eq("parseFromString as text/html is a parse", htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");\n'), ["html-parse:parseFromString"]);
eq("parseFromString as XML, SVG or XHTML is not", htmlSinks([
  'export const a = (s) => new DOMParser().parseFromString(s, "application/xml");',
  'export const b = (s) => new DOMParser().parseFromString(s, "text/xml");',
  'export const c = (s) => new DOMParser().parseFromString(s, "image/svg+xml");',
  'export const d = (s) => new DOMParser().parseFromString(s, "application/xhtml+xml");'
].join("\n")), []);
eq("parseFromString with a computed or missing type is a parse", htmlSinks([
  "export const a = (s, m) => new DOMParser().parseFromString(s, m);",
  "export const b = (s) => new DOMParser().parseFromString(s);"
].join("\n")), ["html-parse:parseFromString"]);
eq("parseFromString through an element access is a parse", htmlCells({
  "src/js/element-access.js": 'export const a = (p, s) => p["parseFromString"](s, "text/html");\n'
}), ["src/js/element-access.js:1 html-parse:parseFromString"]);
eq("parseFromString through an optional call is a parse", htmlCells({
  "src/js/optional-call.js": 'export const a = (p, s) => p?.parseFromString(s, "text/html");\n'
}), ["src/js/optional-call.js:1 html-parse:parseFromString"]);
eq("parseFromString through parentheses is a parse", htmlCells({
  "src/js/parenthesised.js": 'export const a = (p, s) => (p.parseFromString)(s, "text/html");\n'
}), ["src/js/parenthesised.js:1 html-parse:parseFromString"]);
eq("parseFromString through a parenthesised element access is a parse", htmlCells({
  "src/js/wrapped-element-access.js": 'export const a = (p, s) => (p["parseFromString"])(s, "text/html");\n'
}), ["src/js/wrapped-element-access.js:1 html-parse:parseFromString"]);
eq("parseFromString through a local alias of the parser is a parse", htmlCells({
  "src/js/alias.js": 'const p = new DOMParser();\nexport const a = (s) => p.parseFromString(s, "text/html");\n'
}), ["src/js/alias.js:2 html-parse:parseFromString"]);
eq("createContextualFragment, parseHTMLUnsafe, setHTMLUnsafe and setHTML are parses", htmlSinks([
  "export const a = (r, s) => r.createContextualFragment(s);",
  "export const b = (s) => Document.parseHTMLUnsafe(s);",
  "export const c = (e, s) => e.setHTMLUnsafe(s);",
  "export const d = (e, s) => e.setHTML(s);"
].join("\n")), ["html-parse:createContextualFragment", "html-parse:parseHTMLUnsafe", "html-parse:setHTML", "html-parse:setHTMLUnsafe"]);
eq("innerHTML, outerHTML and insertAdjacentHTML render and are not parses", htmlSinks([
  "export const a = (e, h) => { e.innerHTML = h; e.outerHTML = h; e.insertAdjacentHTML('beforeend', h); e.innerHTML += h; };"
].join("\n")), []);
eq("reading innerHTML or a name that only looks like a parse is not a parse", htmlSinks([
  "export const a = (e) => e.innerHTML;",
  "export const parseFromString = (s) => s;",
  "export const b = (o) => o.parse(1);"
].join("\n")), []);
eq("a parse in a feature, core-adjacent adapter, server or desktop module is reported", [
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "src/features/rows/view.ts"),
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "src/adapters/dom/p.ts"),
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "desktop/p.js"),
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "server/p.js")
], [["html-parse:parseFromString"], ["html-parse:parseFromString"], ["html-parse:parseFromString"], ["html-parse:parseFromString"]]);
eq("a parse in a test, a tool or a root script is not reported", [
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "src/test/p.test.mjs"),
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "tools/p.mjs"),
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "build.mjs")
], [[], [], []]);
eq("a parse inside the adapter and inside the bridge is not reported", [
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "src/adapters/richtext/inert.ts"),
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "src/legacy/richtext.ts")
], [[], []]);
eq("each sink is reported once, at its first line", htmlCells({
  "src/js/two.js": 'export const a = (s) => new DOMParser().parseFromString(s, "text/html");\nexport const b = (s) => new DOMParser().parseFromString(s, "text/html");\n'
}), ["src/js/two.js:1 html-parse:parseFromString"]);
eq("an import and a parse in one module are two findings", htmlCells({
  "src/js/both.js": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const a = (s) => new DOMParser().parseFromString(decode(s), "text/html");\n'
}), ["src/js/both.js:2 html-parse:parseFromString", "src/js/both.js:1 src/adapters/richtext/decode.ts"]);

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

console.log("\nINV-10 through run():\n");

const inv10Work = mkdtempSync(join(tmpdir(), "splitpage-dep-report-inv10-"));

try {
  const repo = mkdtempSync(join(inv10Work, "repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  writeFiles(repo, {
    ...ADAPTER_FILES,
    "src/legacy/richtext.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nexport const r = createRichText();\n',
    "src/js/old.js": 'export const p = (s) => new DOMParser().parseFromString(s, "text/html");\n'
  });
  const baselinePath = join(repo, "baseline.json");
  const go = (mode, reason) => {
    const out = [];
    const err = [];
    const code = run({ repo, baselinePath, mode, reason, print: (l) => out.push(l), printError: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  eq("init records the existing HTML parse and not the bridge", (go("init"), JSON.parse(readFileSync(baselinePath, "utf8")).exceptions), [
    { rule: "html-cells", source: "src/js/old.js", target: "html-parse:parseFromString" }
  ]);
  eq("the baselined parse passes", go("check").code, 0);

  writeFiles(repo, { "src/js/new.js": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const d = decode;\n' });
  const added = go("check");
  eq("a new module reaching the decoder fails", added.code, 1);
  check("the failure names the rule, the line and the adapter file", added.err.includes("new html-cells: src/js/new.js:1 -> src/adapters/richtext/decode.ts"), added.err);
  eq("accept without a reason is refused", go("accept").code, 2);
  const accepted = go("accept", "reads the decoder until the bridge lands");
  eq("accept with a reason records it", accepted.code, 0);
  const rows = JSON.parse(readFileSync(baselinePath, "utf8")).exceptions;
  eq("the accepted row carries its reason", rows.find((r) => r.source === "src/js/new.js")?.reason, "reads the decoder until the bridge lands");
  eq("the check passes after accepting", go("check").code, 0);

  writeFiles(repo, { "src/js/old.js": "export const p = (s) => s;\n" });
  const resolved = go("check");
  eq("removing the parse leaves a resolved exception that fails", resolved.code, 1);
  eq("prune clears it", go("prune").code, 0);
  eq("and the check passes", go("check").code, 0);
} finally {
  rmSync(inv10Work, { recursive: true, force: true });
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
    "legacy-state-refs src/js/a.js global:S",
    "legacy-state-refs src/js/b.js global:S",
    "state-import src/js/a.js global:S",
    "state-import src/js/b.js global:S",
    "state-write src/js/b.js direct:S.state",
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
  eq("both the count and the field change are reported", lines(writer, ""), ["dep-report: FAILED", "new state-write: src/js/a.js -> direct:S.state", "new state-write: src/js/a.js:3 -> global:S.state"]);

  const namespaced = attempt(repo, { "src/js/a.js": 'import * as G from "./_state.js";\nimport { b } from "./b.js";\nexport function a() { G.S.state.rows = []; return b(); }\n' });
  eq("a nested write through a namespace import fails", namespaced.code, 1);
  eq("the namespace import still counts as the same importer", lines(namespaced, ""), ["dep-report: FAILED", "new state-write: src/js/a.js -> direct:S.state", "new state-write: src/js/a.js:3 -> global:S.state.*"]);

  const aliased = attempt(repo, { "src/js/a.js": 'import { S as T } from "./_state.js";\nimport { b } from "./b.js";\nexport function a() { T["dirty"] = true; return b(); }\n' });
  eq("an element-access write through an aliased import fails", aliased.code, 1);
  eq("it names the member and the removed literal reference", lines(aliased, ""), ["dep-report: FAILED", "new state-write: src/js/a.js:3 -> global:S.dirty", "resolved legacy-state-refs: src/js/a.js -> global:S"]);

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
    "new legacy-state-refs: src/features/rows/view.ts -> global:S",
    "new state-import: src/features/rows/view.ts:1 -> global:S",
    "new state-import: src/legacy/state.ts:1 -> global:S"
  ]);

  const outside = attempt(repo, { "src/util/helper.js": 'import { S } from "../js/_state.js";\nS.state = null;\n' });
  eq("an S writer in a src folder outside the layer table fails", outside.code, 1);
  eq("its folder, import and write are all named", lines(outside, "new "), [
    "new legacy-state-refs: src/util/helper.js -> global:S",
    "new state-import: src/util/helper.js:1 -> global:S",
    "new state-write: src/util/helper.js -> direct:S.state",
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
    "resolved state-write: src/js/b.js -> direct:S.state",
    "resolved state-write: src/js/b.js -> global:S.state"
  ]);
  eq("--prune accepts it", cli(repo, "--prune").code, 0);
  eq("the pruned baseline keeps the importers and reference counts", JSON.parse(readFileSync(join(repo, "tools/dep-baseline.json"), "utf8")).exceptions.map((e) => `${e.rule} ${e.source}`), ["legacy-state-refs src/js/a.js", "legacy-state-refs src/js/b.js", "state-import src/js/a.js", "state-import src/js/b.js"]);
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
  check("the summary counts the baseline and the new entries separately", moved.out.includes("9 exceptions in the baseline, 1 new, 0 resolved"), moved.out);
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
  eq("the other entries are unchanged", afterAccept.filter((e) => !e.reason).length, 9);
  eq("the check passes after --accept", cli(accepting).code, 0);

  writeFiles(accepting, { "src/js/b.js": 'import { S } from "./_state.js";\nimport { f } from "./f.js";\nexport function b() { S.dirty = true; return f(); }\n' });
  const mixed = cli(accepting, "--accept", "b.js sets the dirty flag while it waits for the session owner");
  eq("--accept adds new entries but does not prune", [mixed.code, cli(accepting).code], [0, 1]);
  check("and says what is left to prune", mixed.out.includes("2 resolved"), mixed.out);
  eq("--prune then removes the resolved entry and keeps both reasons", [cli(accepting, "--prune").code, JSON.parse(readFileSync(baselineFile, "utf8")).exceptions.filter((e) => e.reason).map((e) => e.target)], [0, ["src/js/f.js", "global:S.dirty"]]);
  eq("and the check passes", cli(accepting).code, 0);

  writeFiles(accepting, { "src/core/document/a.ts": 'import "./b.ts";\n', "src/core/document/b.ts": 'import "./a.ts";\n' });
  const beforeCycle = readFileSync(baselineFile, "utf8");
  const refused = cli(accepting, "--accept", "trying to accept a cycle in core");
  eq("--accept refuses while a cycle runs through a migrated folder", refused.code, 1);
  eq("and writes nothing", readFileSync(baselineFile, "utf8"), beforeCycle);

  const linkedRepo = cliRepo({ "src/js/a.js": "export const a = 1;\n" });
  symlinkSync(join(linkedRepo, "tools"), join(linkedRepo, "linked"), process.platform === "win32" ? "junction" : "dir");
  const viaLink = (...args) => spawnSync(process.execPath, [join("linked", "dep-report.mjs"), ...args], { cwd: linkedRepo, encoding: "utf8" });
  eq("run through a linked folder, an unknown argument still exits 2", viaLink("--bogus").status, 2);
  const linkedMetrics = viaLink("--metrics");
  eq("run through a linked folder, the report still runs", [linkedMetrics.status, linkedMetrics.stdout.includes("frontendModules")], [0, true]);

  const sorted = cliRepo({ "shared/t.js": '"use strict";\nmodule.exports = [clearTimeout, TextDecoder, URL, setTimeout];\n' });
  cli(sorted, "--init");
  const initText = readFileSync(join(sorted, "tools/dep-baseline.json"), "utf8");
  eq("--init writes the baseline in code-point order", JSON.parse(initText).exceptions.map((e) => e.target), ["global:TextDecoder", "global:URL", "global:clearTimeout", "global:setTimeout"]);
  eq("--prune rewrites the same bytes", [cli(sorted, "--prune").code, readFileSync(join(sorted, "tools/dep-baseline.json"), "utf8") === initText], [0, true]);
  const numberedFiles = {
    ...STATE_FILE,
    "src/js/00-a.js": 'import { S } from "./_state.js";\nimport { b } from "./01-b.js";\nexport function a() { S.state.rows.push(1); return S.dirty ? b() : 0; }\n',
    "src/js/01-b.js": 'import { a } from "./00-a.js";\nexport function b() { return a; }\nexport function extra() { return 2; }\n',
    "src/test/a.test.mjs": 'import { S } from "../js/_state.js";\nvoid S.state;\n'
  };
  const guarded = cliRepo(numberedFiles);
  eq("init records the four legacy ratchets", cli(guarded, "--init").code, 0);
  eq("the numbered fixture starts clean", cli(guarded).code, 0);
  const newFile = attempt(guarded, { "src/js/02-new.js": "export const leaf = 1;\n" });
  eq("a new acyclic numbered file fails", newFile.code, 1);
  eq("the numbered file guard names it", lines(newFile, "new legacy-file"), ["new legacy-file: src/js/02-new.js -> src/js"]);
  const newTsFile = attempt(guarded, { "src/js/99-growth.ts": "export const leaf = 1;\n" });
  eq("a new acyclic numbered TypeScript file fails", newTsFile.code, 1);
  eq("the numbered file guard names the TypeScript file", lines(newTsFile, "new legacy-file"), ["new legacy-file: src/js/99-growth.ts -> src/js"]);
  const newMjsFile = attempt(guarded, { "src/js/99-growth.mjs": "export const leaf = 1;\n" });
  eq("a new acyclic numbered mjs file fails", newMjsFile.code, 1);
  eq("the numbered file guard names the mjs file", lines(newMjsFile, "new legacy-file"), ["new legacy-file: src/js/99-growth.mjs -> src/js"]);
  const tsFiles = {
    "src/js/00-a.ts": "export const a = 1;\n",
    "src/js/01-b.ts": "export const b = 2;\n"
  };
  const tsGuarded = cliRepo(tsFiles);
  eq("init records the numbered TypeScript fixture", cli(tsGuarded, "--init").code, 0);
  eq("the numbered TypeScript fixture starts clean", cli(tsGuarded).code, 0);
  const newTsImport = attempt(tsGuarded, { "src/js/00-a.ts": 'import { b } from "./01-b.ts";\n' + tsFiles["src/js/00-a.ts"] });
  eq("a new acyclic import between numbered TypeScript files fails", newTsImport.code, 1);
  eq("only the numbered TypeScript import is new", lines(newTsImport, "new "), ["new loop-import: src/js/00-a.ts:1 -> src/js/01-b.ts#b"]);
  const ctsFiles = {
    "src/js/00-a.cts": "export const a = 1;\n",
    "src/js/01-b.cts": "export const b = 2;\n"
  };
  const ctsGuarded = cliRepo(ctsFiles);
  eq("init records the numbered cts fixture", cli(ctsGuarded, "--init").code, 0);
  const importEquals = attempt(ctsGuarded, { "src/js/00-a.cts": 'import b = require("./01-b.cts");\n' + ctsFiles["src/js/00-a.cts"] });
  eq("a new import-equals between numbered cts files fails", importEquals.code, 1);
  eq("import-equals records its binding on the numbered link", lines(importEquals, "new "), ["new loop-import: src/js/00-a.cts:1 -> src/js/01-b.cts#b"]);
  const missingEquals = attempt(ctsGuarded, { "src/js/00-a.cts": 'import b = require("./missing.cts");\n' });
  eq("an import-equals with a missing module fails", missingEquals.code, 1);
  check("the missing import-equals explains resolution failure", missingEquals.err.includes("./missing.cts does not resolve to a file"), missingEquals.err);
  const computedEquals = attempt(ctsGuarded, { "src/js/00-a.cts": 'import b = require(moduleName);\n' });
  eq("an import-equals with a computed module fails", computedEquals.code, 1);
  check("the computed import-equals explains its unresolved name", computedEquals.err.includes("import-equals with a computed specifier"), computedEquals.err);
  const moreRefs = attempt(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"] + "void S.dirty;\n" });
  eq("one more reference to an existing S field fails", moreRefs.code, 1);
  eq("the reference count guard names its file", lines(moreRefs, "new legacy-state-refs"), ["new legacy-state-refs: src/js/00-a.js -> global:S"]);
  for (const [label, reference] of [
    ["optional chaining", "S?.dirty"],
    ["parentheses", "(S).dirty"],
    ["multiline access", "S\n  .dirty"]
  ]) {
    const added = attempt(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"] + `void ${reference};\n` });
    eq(`one more S reference with ${label} fails`, added.code, 1);
    eq(`the reference ratchet catches ${label}`, lines(added, "new "), ["new legacy-state-refs: src/js/00-a.js -> global:S"]);
  }
  for (const path of ["src/js/00-a.js", "src/test/a.test.mjs", "src/legacy/alias.ts"]) {
    for (const alias of ["const T = S;", "const T = (S);", "let T; T = S;", "let T; T = (S);"]) {
      const added = attempt(guarded, { [path]: (numberedFiles[path] ?? "") + alias + "\nT.state.rows.push({});\n" });
      eq(`a direct alias in ${path} using ${alias} fails`, added.code, 1);
      eq(`the reference ratchet catches ${alias} in ${path}`, lines(added, "new legacy-state-refs"), [`new legacy-state-refs: ${path} -> global:S`]);
    }
  }
  const moreTestRefs = attempt(guarded, { "src/test/a.test.mjs": numberedFiles["src/test/a.test.mjs"] + "void S.dirty;\n" });
  eq("one more S reference in tests also fails", moreTestRefs.code, 1);
  const moreWrites = attempt(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"] + "S.state.rows.push(2);\n" });
  eq("one more write to an already recorded target fails", moreWrites.code, 1);
  eq("the per-file write count catches it", lines(moreWrites, "new state-write"), ["new state-write: src/js/00-a.js -> direct:S.state"]);
  const stateRead = numberedFiles["src/js/00-a.js"] + "void S.state.rows.length;\n";
  const writeGuarded = cliRepo({ ...numberedFiles, "src/js/00-a.js": stateRead });
  eq("init records an existing write beside a state read", cli(writeGuarded, "--init").code, 0);
  for (const [label, replacement] of [
    ["postfix increment", "S.state.rows.length++"],
    ["delete", "delete S.state.rows.length"],
    ["multiline compound assignment", "S.state\n  .rows.length\n  += 1"]
  ]) {
    const mutation = attempt(writeGuarded, { "src/js/00-a.js": stateRead.replace("void S.state.rows.length", replacement) });
    eq(`replacing a state read with ${label} fails`, mutation.code, 1);
    eq(`the write ratchet catches ${label} without reference growth`, lines(mutation, "new "), ["new state-write: src/js/00-a.js -> direct:S.state"]);
  }
  eq("prune refuses a rise in a count", (() => {
    writeFiles(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"] + "S.state.rows.push(2);\n" });
    const code = cli(guarded, "--prune").code;
    writeFiles(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"] });
    return code;
  })(), 1);
  const moreNames = attempt(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"].replace("{ b }", "{ b, extra as notify }") });
  eq("a new name on an existing numbered link fails", moreNames.code, 1);
  eq("only the imported name is new, not the cycle edge", lines(moreNames, "new "), ["new loop-import: src/js/00-a.js:2 -> src/js/01-b.js#extra"]);
  for (const [label, load] of [
    ["dynamic import", 'await import("./01-b.mjs")'],
    ["require", 'require("./01-b.mjs")']
  ]) {
    const loadedFiles = {
      "src/js/00-a.mjs": `const { b } = ${load};\nexport const a = b;\n`,
      "src/js/01-b.mjs": "export const b = 1;\nexport const extra = 2;\n"
    };
    const loaded = cliRepo(loadedFiles);
    eq(`init records a numbered ${label}`, cli(loaded, "--init").code, 0);
    const addedName = attempt(loaded, { "src/js/00-a.mjs": loadedFiles["src/js/00-a.mjs"].replace("{ b }", "{ b, extra: notify }") });
    eq(`a new destructured name on an existing ${label} fails`, addedName.code, 1);
    eq(`the ${label} names the imported export`, lines(addedName, "new "), ["new loop-import: src/js/00-a.mjs:1 -> src/js/01-b.mjs#extra"]);
    for (const binding of ["namespace", "{ b, ...rest }", "{ [key]: b }"]) {
      const unknown = attempt(loaded, { "src/js/00-a.mjs": `const ${binding} = ${load};\n` });
      eq(`a numbered ${label} with ${binding} fails`, unknown.code, 1);
      check(`the ${label} explains the unknown imported names for ${binding}`, unknown.err.includes("imported names cannot be determined statically; use explicit named destructuring"), unknown.err);
    }
    const beforeUnknown = readFileSync(join(loaded, "tools/dep-baseline.json"), "utf8");
    writeFiles(loaded, { "src/js/00-a.mjs": `const namespace = ${load};\nimport * as other from "./01-b.mjs";\n` });
    eq(`a wildcard cannot mask unknown ${label} names`, cli(loaded).code, 1);
    eq(`accept refuses unknown ${label} names`, cli(loaded, "--accept", "unknown imported names").code, 1);
    eq(`refusing unknown ${label} names preserves the baseline`, readFileSync(join(loaded, "tools/dep-baseline.json"), "utf8"), beforeUnknown);
    const unknownInit = cliRepo({ ...loadedFiles, "src/js/00-a.mjs": `const namespace = ${load};\n` });
    eq(`init refuses unknown ${label} names`, cli(unknownInit, "--init").code, 1);
    eq(`init writes no baseline for unknown ${label} names`, existsSync(join(unknownInit, "tools/dep-baseline.json")), false);
    const wildcard = cliRepo({ ...loadedFiles, "src/js/00-a.mjs": 'import * as known from "./01-b.mjs";\n' });
    eq(`init records a wildcard before adding a ${label}`, cli(wildcard, "--init").code, 0);
    writeFiles(wildcard, { "src/js/00-a.mjs": `const namespace = ${load};\nimport * as known from "./01-b.mjs";\n` });
    const masked = cli(wildcard);
    eq(`a baselined wildcard cannot accept unknown ${label} names`, masked.code, 1);
    check(`the baselined wildcard still reports unknown ${label} names`, masked.err.includes("imported names cannot be determined statically"), masked.err);
  }
  const measured = cli(guarded, "--legacy-metrics");
  eq("legacy metrics emits JSON and exits successfully", measured.code, 0);
  eq("legacy metrics reports the entire numeric exit table", JSON.parse(measured.out), {
    loopModules: 2, loopLinks: 2, stateModules: 1, stateFields: 3,
    stateReferences: 2, testStateReferences: 1, stateImporters: 1, testStateImporters: 1,
    stateAssigners: 0, directWriteLines: 1, numberedFiles: 2, numberedLines: 6
  });
  writeFiles(guarded, { "limits.json": measured.out, "steps.json": '[{"label":"moved b","names":["b"]}]\n' });
  eq("assert accepts values exactly on their thresholds", cli(guarded, "--legacy-metrics", "--assert", "limits.json").code, 0);
  writeFiles(guarded, { "limits.json": JSON.stringify({ ...JSON.parse(measured.out), numberedFiles: 1 }) });
  const missed = cli(guarded, "--assert", "limits.json");
  eq("assert fails a missed closing threshold", missed.code, 1);
  check("the missed threshold is named", missed.err.includes("numberedFiles: 2 exceeds 1"), missed.err);
  writeFiles(guarded, { "limits.json": '{"unknown":0}\n' });
  eq("assert rejects an unknown metric", cli(guarded, "--assert", "limits.json").code, 2);
  eq("assert rejects a missing threshold file", cli(guarded, "--assert", "missing.json").code, 2);
  eq("assert needs a filename", cli(guarded, "--assert").code, 2);
  const modeled = cli(guarded, "--loop-model", "steps.json");
  eq("the loop steps option runs", modeled.code, 0);
  eq("moving the last imported name cuts the loop", JSON.parse(modeled.out).steps.map((s) => [s.label, s.loopModules, s.loopLinks]), [["now", 2, 2], ["moved b", 0, 0]]);
  eq("loop steps needs a filename", cli(guarded, "--loop-model").code, 2);
  writeFiles(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"].replace("S.dirty", "true") });
  eq("a fallen reference count must be pruned", cli(guarded).code, 1);
  eq("prune lowers the recorded reference count", cli(guarded, "--prune").code, 0);
  eq("the lower reference count is recorded", JSON.parse(readFileSync(join(guarded, "tools/dep-baseline.json"), "utf8")).exceptions.find((e) => e.rule === "legacy-state-refs" && e.source === "src/js/00-a.js")?.count, 1);
  eq("the lowered baseline passes", cli(guarded).code, 0);
  writeFiles(guarded, { "src/js/00-a.js": numberedFiles["src/js/00-a.js"] });
  eq("references cannot grow back after pruning", cli(guarded).code, 1);
  const deleted = cliRepo({ "src/js/00-leaf.js": "export const leaf = 1;\n" });
  cli(deleted, "--init");
  rmSync(join(deleted, "src/js/00-leaf.js"));
  eq("a deleted numbered file must be pruned", cli(deleted).code, 1);
  eq("prune removes the deleted numbered file", cli(deleted, "--prune").code, 0);
  eq("the deleted numbered file leaves no exceptions", JSON.parse(readFileSync(join(deleted, "tools/dep-baseline.json"), "utf8")).exceptions, []);
} finally {
  rmSync(cliWork, { recursive: true, force: true });
}

console.log("\nlegacy measurements and loop steps:\n");

eq("the measurement uses appendix matches and counts write lines once", legacyMeasurements("S.state = {}; S.state.rows.push(1);\nS.state == null;\nS.state.rows.splice(0);\n"), { references: 4, directWrites: 2, lines: 3 });
for (const [label, text, count] of [
  ["optional property and element chains", 'S?.dirty; S?.["dirty"];', 2],
  ["wrapped and multiline access", '(S).dirty; S\n.dirty; (S)\n["dirty"];', 3],
  ["bare direct alias declarations", "const T = S; const U = (S);", 2],
  ["bare direct alias assignments", "let T, U; T = S; U = (S);", 2],
  ["type identity wrappers", "const T = (S as State); let U; U = S!;", 2],
  ["property names", "const S = {}; const obj = { S: 1 };", 0],
  ["historical references in string contents", 'const text = "S.dirty"; S?.dirty;', 2],
  ["function call and object property alias limits", "const T = identity(S); const U = holder.S;", 0]
]) {
  eq(`the reference measurement counts ${label}`, legacyMeasurements(text, "src/legacy/example.ts").references, count);
}
for (const [text, expected] of [
  ['import b = require("./01-b.cts");', { spec: "./01-b.cts", names: ["b"], typeOnly: false, kind: "import-equals", line: 1 }],
  ['import type b = require("./01-b.cts");', { spec: "./01-b.cts", names: ["b"], typeOnly: true, kind: "import-equals", line: 1 }]
]) {
  eq(`the import-equals parser handles ${text}`, analyzeScript("src/js/00-a.cts", text).imports, [expected]);
}
eq("an internal import-equals creates no external dependency", analyzeScript("src/js/00-a.cts", "import b = Namespace.b;").imports, []);
eq("import-equals contributes an edge to runtime cycles", stronglyConnected(graph({
  "src/js/00-a.cts": 'import b = require("./01-b.cts");',
  "src/js/01-b.cts": 'import a = require("./00-a.cts");'
}), false).map((c) => c.sort()), [["src/js/00-a.cts", "src/js/01-b.cts"]]);
eq("a fully retired legacy layer meets the committed closing limits", assertLegacyMetrics(legacyMetrics(graph({})), JSON.parse(readFileSync(join(TOOLS, "legacy-exit.json"), "utf8"))), []);
eq("an unnumbered caller still gets a reference and direct-write ratchet", legacyViolations(graph({ "src/legacy/example.ts": "S.state = {};\n" })).map(({ rule, target, count }) => ({ rule, target, count })), [
  { rule: "legacy-state-refs", target: "global:S", count: 1 },
  { rule: "state-write", target: "direct:S.state", count: 1 }
]);

for (const operator of ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??="]) {
  const writes = legacyViolations(graph({ "src/legacy/example.ts": `S.state\n  .rows[0].length\n  ${operator} 1;\n` }));
  eq(`the direct-write ratchet parses multiline ${operator}`, writes.find((v) => v.target === "direct:S.state")?.count, 1);
}

for (const [label, text, count] of [
  ["each write on the same line", "S.state = {}; S.state.rows.push(1); S.state.rows.splice(0);\n", 3],
  ["prefix and postfix updates", "++S.state.rows.length; --S.state.rows.length; S.state.rows.length++; S.state.rows.length--;\n", 4],
  ["delete and wrapped element targets", 'delete S.state.rows[0]; (S["state"].rows[0].length) += 1;\n', 2],
  ["the appendix mutating methods", ["push", "splice", "pop", "shift", "unshift", "sort"].map((m) => `S.state\n.rows\n.${m}\n(1);`).join("\n"), 6],
  ["reads and methods outside the appendix", "S.state.rows.length; S.state.rows.reverse(); S.state.rows.fill(0); S.state.rows.copyWithin(0);\n", 0],
  ["source text in strings", 'const example = "S.state.rows.length++";\n', 0]
]) {
  const writes = legacyViolations(graph({ "src/legacy/example.ts": text }));
  eq(`the direct-write ratchet counts ${label}`, writes.find((v) => v.target === "direct:S.state")?.count ?? 0, count);
}

for (const [label, text, names] of [
  ["nested dynamic bindings", 'const { b: { value }, default: run } = await import("./b.mjs");', ["b", "default"]],
  ["a wrapped dynamic property", 'export const b = (await (import("./b.mjs"))).b;', ["b"]],
  ["a literal require property", 'const b = require("./b.mjs")["b"];', ["b"]],
  ["a promise callback", 'import("./b.mjs").then(({ b }) => b());', null]
]) {
  eq(`the load parser handles ${label}`, analyzeScript("src/js/00-a.mjs", text).imports[0]?.names, names);
}

{
  const modelGraph = graph({
    ...STATE_FILE,
    "src/js/00-a.js": 'import { call, pure, page, held, moving, fixed, passed } from "./01-b.js";\nexport function a() { return call(); }\n',
    "src/js/01-b.js": 'import { a } from "./00-a.js";\nimport { S } from "./_state.js";\nexport function call() { return a(); }\nexport function pure() { return 2; }\nexport function page() { return document.title; }\nexport function held() { return S.dirty; }\nexport let moving = 0;\nmoving++;\nexport const fixed = 1;\nexport { S as passed } from "./_state.js";\n'
  });
  const model = loopModel(modelGraph, [
    { label: "rules", kinds: ["rule"], exceptNames: ["pure"] },
    { label: "one name", names: ["call"] },
    { label: "rest", kinds: ["rule", "page-helper", "stateful", "changing", "value"] }
  ]);
  eq("the loop model classifies all six appendix kinds", model.counts, { "calls-loop": 2, rule: 1, "page-helper": 1, stateful: 1, changing: 1, value: 2 });
  eq("a link stays until every imported name moves", model.steps.map((s) => [s.label, s.loopModules, s.loopLinks]), [["now", 2, 2], ["rules", 2, 2], ["one name", 2, 2], ["rest", 0, 0]]);
}

const WRITERS_OUT_OF_THE_CYCLE = [
  "src/js/14b-export-kit.js", "src/js/14c-export-projections.js", "src/js/15-docx.js", "src/js/16-csv.js",
  "src/js/16b-xlsx.js", "src/js/17-pdf.js", "src/js/14d-export-text.js", "src/js/14e-export-formats.js"
];
const repoGraph = loadGraph(ROOT);
const inCycle = new Set(stronglyConnected(repoGraph, false).flat());
eq("the writers, the export projections, the text builders and the format declarations are outside every runtime import cycle", WRITERS_OUT_OF_THE_CYCLE.filter((p) => inCycle.has(p)), []);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
