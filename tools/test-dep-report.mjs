import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  layerOf, layerAllows, analyzeScript, buildGraph, findViolations, migratedCycles, compareBaseline, metrics, run, loadGraph, stronglyConnected
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

eq("the starter catalogue has its own layer", layerOf("src/starters/index.ts"), "starters");
check("bootstrap may import starters", layerAllows("bootstrap", "starters"));
check("starters may not import application", !layerAllows("starters", "application"));
check("a feature may not import starters", !layerAllows("features/newtab", "starters"));

eq("src/core/document is its own layer", layerOf("src/core/document/ids.ts"), "core/document");
eq("an unlisted core folder is core", layerOf("src/core/timing/x.ts"), "core");
eq("a feature folder is named", layerOf("src/features/rows/view.ts"), "features/rows");
eq("src/test is tests", layerOf("src/test/undo.test.mjs"), "tests");
eq("an unknown src folder is src-unknown, not other", layerOf("src/util/helper.js"), "src-unknown");
eq("the retired contracts folder is an unknown source layer", layerOf("src/contracts/dto.ts"), "src-unknown");
eq("a file directly under src is src-unknown", layerOf("src/entry.js"), "src-unknown");
eq("a root script is still other", layerOf("build.mjs"), "other");
check("core may not import an unknown src folder", !layerAllows("core/document", "src-unknown"));
check("a feature may import features/common", layerAllows("features/rows", "features/common"));
check("a feature may not import another feature", !layerAllows("features/rows", "features/find"));
check("a feature may not import an unknown src folder", !layerAllows("features/rows", "src-unknown"));
eq("a .test.ts beside source is tests", layerOf("src/core/text/runs.test.ts"), "tests");
check("core/text may import core/document", layerAllows("core/text", "core/document"));
check("core/document may not import core/text", !layerAllows("core/document", "core/text"));
check("core may not import application", !layerAllows("core/text", "application"));
check("application may not import adapters", !layerAllows("application", "adapters"));
check("a feature may not import another feature", !layerAllows("features/rows", "features/find"));
check("a feature may import application", layerAllows("features/rows", "application"));
check("bootstrap may import anything", layerAllows("bootstrap", "features/rows") && layerAllows("bootstrap", "adapters"));
check("production code may not import tests", !layerAllows("application", "tests") && !layerAllows("server", "tests"));
check("tools may import tests", layerAllows("tools", "tests"));

eq("reintroducing the retired folder fails the unknown-layer and import rules", findViolations(graph({
  "src/contracts/dto.ts": "export type Dto = { id: string };\n",
  "src/application/probe.ts": 'import type { Dto } from "../contracts/dto.ts";\nexport type Probe = Dto;\n'
})).map(({ rule, source, target }) => ({ rule, source, target })), [
  { rule: "layer", source: "src/application/probe.ts", target: "src/contracts/dto.ts" },
  { rule: "unknown-layer", source: "src/contracts/dto.ts", target: "src/contracts/" }
]);

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
  const a = analyzeScript("src/bootstrap/x.js", 'function require(n) { return n; }\nrequire("./y.js");\n');
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
    "src/application/c.ts": "declare global { var leak: number }\nexport {};\n",
    "shared/s.js": '"use strict";\nmodule.exports = { f: () => 1 };\n',
    "src/adapters/dom/p.ts": "declare const FormData: new () => unknown;\nexport const p = [new DOMParser(), new FormData()];\n"
  })).filter((v) => v.rule === "platform-global").map((v) => `${v.source} ${v.target}`);
  eq("core and application may use or declare no DOM or ambient value; an adapter may", rules, [
    "src/application/a.ts ambient:__BUILD__",
    "src/application/c.ts ambient:leak",
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
    "src/application/k.ts": "export const k = Math.random();\n",
    "src/application/a.ts": "export const a = Date.now();\n",
    "src/bootstrap/clock.js": "export const t = Date.now() + Math.random();\n",
    "src/adapters/identity/i.ts": "export const i = Date.now() + Math.random();\n"
  })).filter((v) => v.rule === "platform-global").map((v) => `${v.source} ${v.target}`);
  eq("core, shared and application may not read the clock or draw random numbers; bootstrap and adapters may", rules, [
    "shared/h.js global:Date",
    "src/application/a.ts global:Date",
    "src/application/k.ts global:Math.random",
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

function htmlSinks(text, path = "src/bootstrap/h.js") {
  return htmlCells({ [path]: text }).map((f) => f.split(" ")[1]);
}

eq("the adapter itself may parse HTML and import its own modules", htmlCells({
  "src/adapters/richtext/sanitize.ts": 'import { decode } from "./decode.ts";\nexport const s = (h: string, p: { parseFromString(a: string, b: string): unknown }) => [decode(h), p.parseFromString(h, "text/html")];\n'
}), []);
eq("the bridge may import the adapter and parse", htmlCells({
  "src/bootstrap/richtext.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nimport { decode } from "../adapters/richtext/decode.ts";\nexport const r = [createRichText(), decode("")];\n'
}), []);
eq("another bootstrap module importing the adapter is reported", htmlCells({
  "src/bootstrap/document-ports.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nexport const r = createRichText();\n'
}), ["src/bootstrap/document-ports.ts:1 src/adapters/richtext/richtext.ts"]);
eq("a bootstrap module importing the decoder is reported", htmlCells({
  "src/bootstrap/05-x.js": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const d = decode;\n'
}), ["src/bootstrap/05-x.js:1 src/adapters/richtext/decode.ts"]);
eq("bootstrap modules may import a richtext helper that only rewrites an existing body", htmlCells({
  "src/adapters/richtext/tag-anchors.ts": 'export const retagTagAnchors = (body) => body.innerHTML;\n',
  "src/bootstrap/wiring/ports/text.ts": 'import { retagTagAnchors } from "../../../adapters/richtext/tag-anchors.ts";\nexport const text = { retagBody: retagTagAnchors };\n',
  "src/bootstrap/08-production-panels.js": 'import { retagTagAnchors } from "../adapters/richtext/tag-anchors.ts";\nexport const text = { retagBody: retagTagAnchors };\n'
}), []);
eq("a richtext helper that reaches the decoder indirectly is reported", htmlCells({
  "src/adapters/richtext/tag-anchors.ts": 'import { helper } from "./helper.ts";\nexport const retagTagAnchors = helper;\n',
  "src/adapters/richtext/helper.ts": 'import { decode } from "./decode.ts";\nexport const helper = decode;\n',
  "src/bootstrap/08-production-panels.js": 'import { retagTagAnchors } from "../adapters/richtext/tag-anchors.ts";\nexport const text = retagTagAnchors;\n'
}), ["src/bootstrap/08-production-panels.js:1 src/adapters/richtext/tag-anchors.ts"]);
eq("a richtext helper that parses HTML is reported", htmlCells({
  "src/adapters/richtext/tag-anchors.ts": 'export const retagTagAnchors = (s) => new DOMParser().parseFromString(s, "text/html");\n',
  "src/bootstrap/08-production-panels.js": 'import { retagTagAnchors } from "../adapters/richtext/tag-anchors.ts";\nexport const text = retagTagAnchors;\n'
}), ["src/bootstrap/08-production-panels.js:1 src/adapters/richtext/tag-anchors.ts"]);
eq("an unclassified richtext helper assigning detached innerHTML is reported", htmlCells({
  "src/adapters/richtext/detached.ts": 'export const parse = (html) => { const body = document.createElement("div"); body.innerHTML = html; return body; };\n',
  "src/bootstrap/08-production-panels.js": 'import { parse } from "../adapters/richtext/detached.ts";\nexport const body = parse("");\n'
}), ["src/bootstrap/08-production-panels.js:1 src/adapters/richtext/detached.ts"]);
eq("an unclassified richtext helper calling a bound HTML parser is reported", htmlCells({
  "src/adapters/richtext/bound.ts": 'const parser = new DOMParser();\nconst parse = parser.parseFromString.bind(parser);\nexport const body = (html) => parse(html, "text/html");\n',
  "src/bootstrap/08-production-panels.js": 'import { body } from "../adapters/richtext/bound.ts";\nexport const parsed = body("");\n'
}), ["src/bootstrap/08-production-panels.js:1 src/adapters/richtext/bound.ts"]);
eq("an unclassified richtext helper with no recognized parsing calls is conservatively reported", htmlCells({
  "src/adapters/richtext/unknown.ts": 'export const helper = (value) => value;\n',
  "src/bootstrap/08-production-panels.js": 'import { helper } from "../adapters/richtext/unknown.ts";\nexport const value = helper("");\n'
}), ["src/bootstrap/08-production-panels.js:1 src/adapters/richtext/unknown.ts"]);
eq("bootstrap importing the adapter is reported", htmlCells({
  "src/bootstrap/main.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nexport const r = createRichText();\n'
}), ["src/bootstrap/main.ts:1 src/adapters/richtext/richtext.ts"]);
eq("a re-export of the decoder is reported", htmlCells({
  "src/bootstrap/other.ts": 'export { decode } from "../adapters/richtext/decode.ts";\n'
}), ["src/bootstrap/other.ts:1 src/adapters/richtext/decode.ts"]);
eq("a dynamic import and a require of the decoder are reported", htmlCells({
  "src/bootstrap/late.js": 'export const l = () => import("../adapters/richtext/decode.ts");\n',
  "server/s.js": '"use strict";\nmodule.exports = require("../src/adapters/richtext/decode.ts");\n'
}), ["server/s.js:2 src/adapters/richtext/decode.ts", "src/bootstrap/late.js:1 src/adapters/richtext/decode.ts"]);
eq("a type-only import of the adapter is not a decoder", htmlCells({
  "src/bootstrap/types.ts": 'import type { RichText } from "../adapters/richtext/richtext.ts";\nexport type T = RichText;\n'
}), []);
eq("tests and tools may import the adapter", htmlCells({
  "src/test/x.test.mjs": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const d = decode;\n',
  "tests/adapters/richtext/golden.test.ts": 'import { decode } from "../../../src/adapters/richtext/decode.ts";\nexport const d = decode;\n',
  "tools/probe.mjs": 'import { decode } from "../src/adapters/richtext/decode.ts";\nexport const d = decode;\n'
}), []);
eq("a module that imports the adapter's neighbour is not reported", htmlCells({
  "src/adapters/identity/ids.ts": "export const id = 1;\n",
  "src/bootstrap/ids.ts": 'import { id } from "../adapters/identity/ids.ts";\nexport const i = id;\n'
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
  "src/bootstrap/element-access.js": 'export const a = (p, s) => p["parseFromString"](s, "text/html");\n'
}), ["src/bootstrap/element-access.js:1 html-parse:parseFromString"]);
eq("parseFromString through an optional call is a parse", htmlCells({
  "src/bootstrap/optional-call.js": 'export const a = (p, s) => p?.parseFromString(s, "text/html");\n'
}), ["src/bootstrap/optional-call.js:1 html-parse:parseFromString"]);
eq("parseFromString through parentheses is a parse", htmlCells({
  "src/bootstrap/parenthesised.js": 'export const a = (p, s) => (p.parseFromString)(s, "text/html");\n'
}), ["src/bootstrap/parenthesised.js:1 html-parse:parseFromString"]);
eq("parseFromString through a parenthesised element access is a parse", htmlCells({
  "src/bootstrap/wrapped-element-access.js": 'export const a = (p, s) => (p["parseFromString"])(s, "text/html");\n'
}), ["src/bootstrap/wrapped-element-access.js:1 html-parse:parseFromString"]);
eq("parseFromString through a local alias of the parser is a parse", htmlCells({
  "src/bootstrap/alias.js": 'const p = new DOMParser();\nexport const a = (s) => p.parseFromString(s, "text/html");\n'
}), ["src/bootstrap/alias.js:2 html-parse:parseFromString"]);
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
  htmlSinks('export const p = (s) => new DOMParser().parseFromString(s, "text/html");', "src/bootstrap/richtext.ts")
], [[], []]);
eq("each sink is reported once, at its first line", htmlCells({
  "src/bootstrap/two.js": 'export const a = (s) => new DOMParser().parseFromString(s, "text/html");\nexport const b = (s) => new DOMParser().parseFromString(s, "text/html");\n'
}), ["src/bootstrap/two.js:1 html-parse:parseFromString"]);
eq("an import and a parse in one module are two findings", htmlCells({
  "src/bootstrap/both.js": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const a = (s) => new DOMParser().parseFromString(decode(s), "text/html");\n'
}), ["src/bootstrap/both.js:2 html-parse:parseFromString", "src/bootstrap/both.js:1 src/adapters/richtext/decode.ts"]);

console.log("\nmetrics():\n");
eq("metrics reports runtime cycle information", metrics(graph({ "src/bootstrap/a.ts": 'import "./b.ts";', "src/bootstrap/b.ts": 'import "./a.ts";' })), { frontendModules: 2, frontendRuntimeCycles: 1, runtimeCycleEdges: 2, migratedModules: 2 });

console.log("\ncycle edges:\n");

function cycleEdges(files) {
  return findViolations(graph(files)).filter((v) => v.rule === "cycle-edge").map((v) => `${v.source} -> ${v.target}`);
}

eq("both edges of a two-module server cycle", cycleEdges({ "server/l1.js": 'import "./l2.js";\n', "server/l2.js": 'import "./l1.js";\n' }), ["server/l1.js -> server/l2.js", "server/l2.js -> server/l1.js"]);
eq("an edge into a cycle is not part of it", cycleEdges({ "src/bootstrap/a.js": 'import "./b.js";\n', "src/bootstrap/b.js": 'import "./c.js";\n', "src/bootstrap/c.js": 'import "./b.js";\n' }), ["src/bootstrap/b.js -> src/bootstrap/c.js", "src/bootstrap/c.js -> src/bootstrap/b.js"]);
eq("a self-import", cycleEdges({ "src/bootstrap/s.js": 'import "./s.js";\n' }), ["src/bootstrap/s.js -> src/bootstrap/s.js"]);
eq("a literal dynamic import closes a runtime cycle", cycleEdges({ "src/bootstrap/d1.js": 'import "./d2.js";\n', "src/bootstrap/d2.js": 'export const load = () => import("./d1.js");\n' }), ["src/bootstrap/d1.js -> src/bootstrap/d2.js", "src/bootstrap/d2.js -> src/bootstrap/d1.js"]);
eq("type-only references do not make a runtime cycle", cycleEdges({
  "server/a.ts": 'import type { B } from "./b.ts";\nexport type A = B;\n',
  "server/b.ts": 'import type { A } from "./a.ts";\nexport type B = A;\n'
}), []);

console.log("\nviolations and baseline:\n");

{
  const g = graph({
    "src/core/document/a.ts": 'import { b } from "../../bootstrap/b.js";\nimport fs from "node:fs";\nexport const a = window;\n',
    "src/bootstrap/b.js": "export const b = 1;\n",
    "src/features/rows/v.ts": 'import { f } from "../find/f.ts";\nexport const v = f;\n',
    "src/features/find/f.ts": "export const f = 1;\n",
    "src/application/s.ts": 'import { m } from "./missing.ts";\nexport const s = m;\n'
  });
  const rules = findViolations(g).map((v) => `${v.rule} ${v.source} ${v.target}`);
  check("core importing bootstrap is a layer violation", rules.includes("layer src/core/document/a.ts src/bootstrap/b.js"), rules.join("\n"));
  check("core importing a builtin is a platform-import violation", rules.includes("platform-import src/core/document/a.ts builtin:fs"), rules.join("\n"));
  check("core using window is a platform-global violation", rules.includes("platform-global src/core/document/a.ts global:window"), rules.join("\n"));
  check("feature to feature is a layer violation", rules.includes("layer src/features/rows/v.ts src/features/find/f.ts"), rules.join("\n"));
  check("an unresolvable relative import is reported", rules.includes("missing-module src/application/s.ts src/application/missing.ts"), rules.join("\n"));
}

eq("violations sort by code point, field by field, not by locale", findViolations(graph({
  "src/core/document/t.ts": "export const t = [clearTimeout, TextDecoder, URL, setTimeout, AbortController];\n"
})).map((v) => v.target), ["global:AbortController", "global:TextDecoder", "global:URL", "global:clearTimeout", "global:setTimeout"]);

{
  const before = findViolations(graph({ "src/core/document/a.ts": 'import { x } from "../../bootstrap/x.js";\n', "src/bootstrap/x.js": "", "src/bootstrap/y.js": "" }));
  const after = findViolations(graph({ "src/core/document/a.ts": 'import { y } from "../../bootstrap/y.js";\n', "src/bootstrap/x.js": "", "src/bootstrap/y.js": "" }));
  eq("the swap keeps the violation count equal", after.length, before.length);
  const { added, resolved } = compareBaseline(after, { exceptions: before });
  eq("a new forbidden edge fails even when the count does not grow", added.map((v) => v.target), ["src/bootstrap/y.js"]);
  eq("the replaced exception is reported as resolved", resolved.map((v) => v.target), ["src/bootstrap/x.js"]);
}

{
  const g = graph({
    "src/core/document/a.ts": 'import type { B } from "./b.ts";\nexport type A = B;\n',
    "src/core/document/b.ts": 'import { a } from "./a.ts";\nexport const b = a;\nexport type B = number;\n',
    "server/l1.js": 'import "./l2.js";\n',
    "server/l2.js": 'import "./l1.js";\n'
  });
  const cycles = migratedCycles(g);
  eq("a type-only cycle in core is caught by the type-inclusive graph", cycles.map((c) => c.graph), ["with-types"]);
  check("a server-only cycle is not a migrated cycle", cycles.every((c) => !c.modules.includes("server/l1.js")));
}

{
  const g = graph({
    "src/bootstrap/root.ts": 'import "../../server/boot.js";\n',
    "server/boot.js": 'import "./mid.js";\n',
    "server/mid.js": 'import "../src/bootstrap/root.ts";\n'
  });
  const cycles = migratedCycles(g);
  check("a cycle through server modules involving migrated code is caught", cycles.some((c) => c.graph === "runtime" && c.modules.length === 3), JSON.stringify(cycles));
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
    "src/bootstrap/a.js": 'import "../../shared/p.js";\n'
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
  eq("a resolved exception left in the baseline warns and passes", resolved.code, 0);
  check("the warning names the entry and the prune command", resolved.err.includes("warning: resolved platform-global: shared/p.js -> global:URL (remove it with `node tools/dep-report.mjs --prune`)"), resolved.err);
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
    "src/bootstrap/richtext.ts": 'import { createRichText } from "../adapters/richtext/richtext.ts";\nexport const r = createRichText();\n',
    "src/bootstrap/old.js": 'export const p = (s) => new DOMParser().parseFromString(s, "text/html");\n'
  });
  const baselinePath = join(repo, "baseline.json");
  const go = (mode, reason) => {
    const out = [];
    const err = [];
    const code = run({ repo, baselinePath, mode, reason, print: (l) => out.push(l), printError: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  eq("init records the existing HTML parse and not the bridge", (go("init"), JSON.parse(readFileSync(baselinePath, "utf8")).exceptions), [
    { rule: "html-cells", source: "src/bootstrap/old.js", target: "html-parse:parseFromString" }
  ]);
  eq("the baselined parse passes", go("check").code, 0);

  writeFiles(repo, { "src/bootstrap/new.js": 'import { decode } from "../adapters/richtext/decode.ts";\nexport const d = decode;\n' });
  const added = go("check");
  eq("a new module reaching the decoder fails", added.code, 1);
  check("the failure names the rule, the line and the adapter file", added.err.includes("new html-cells: src/bootstrap/new.js:1 -> src/adapters/richtext/decode.ts"), added.err);
  eq("accept without a reason is refused", go("accept").code, 2);
  const accepted = go("accept", "reads the decoder until the bridge lands");
  eq("accept with a reason records it", accepted.code, 0);
  const rows = JSON.parse(readFileSync(baselinePath, "utf8")).exceptions;
  eq("the accepted row carries its reason", rows.find((r) => r.source === "src/bootstrap/new.js")?.reason, "reads the decoder until the bridge lands");
  eq("the check passes after accepting", go("check").code, 0);

  writeFiles(repo, { "src/bootstrap/old.js": "export const p = (s) => s;\n" });
  const resolved = go("check");
  eq("removing the parse leaves a resolved exception that warns and passes", resolved.code, 0);
  check("the warning names the resolved html-cells entry", resolved.err.includes("warning: resolved html-cells: src/bootstrap/old.js"), resolved.err);
  eq("prune clears it", go("prune").code, 0);
  eq("and the check passes", go("check").code, 0);
} finally {
  rmSync(inv10Work, { recursive: true, force: true });
}

console.log("\nthe CLI against a temporary git repository:\n");

const cacheDir = join(ROOT, ".cache");
mkdirSync(cacheDir, { recursive: true });
const cliWork = mkdtempSync(join(cacheDir, "dep-report-test-"));

const CYCLE_FIXTURE = {
  "server/a.js": 'import { b } from "./b.js";\nconst enabled = true;\nexport function a() { return enabled ? b() : 0; }\n',
  "server/b.js": 'import { f } from "./f.js";\nconst enabled = true;\nexport function b() { return enabled && f(); }\n',
  "server/f.js": 'import { a } from "./a.js";\nexport function f() { return a; }\n',
  "server/c.js": "export const c = 1;\n"
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
  const repo = cliRepo(CYCLE_FIXTURE);
  const init = cli(repo, "--init");
  eq("--init on the cycle fixture exits 0", init.code, 0);
  const recorded = JSON.parse(readFileSync(join(repo, "tools/dep-baseline.json"), "utf8")).exceptions.map((e) => `${e.rule} ${e.source} ${e.target}`);
  eq("the baseline records the cycle edges exactly", recorded, [
    "cycle-edge server/a.js server/b.js",
    "cycle-edge server/b.js server/f.js",
    "cycle-edge server/f.js server/a.js"
  ]);
  eq("the unchanged fixture passes", cli(repo).code, 0);

  const twoFile = attempt(repo, { "server/d.js": 'import "./e.js";\n', "server/e.js": 'import "./d.js";\n' });
  eq("a new two-module server cycle fails", twoFile.code, 1);
  eq("both of its edges are named", lines(twoFile, "new "), ["new cycle-edge: server/d.js:1 -> server/e.js", "new cycle-edge: server/e.js:1 -> server/d.js"]);

  const inner = attempt(repo, { "server/a.js": CYCLE_FIXTURE["server/a.js"] + 'import "./f.js";\n' });
  eq("a new edge between two modules already in the cycle fails", inner.code, 1);
  eq("the new edge is named", lines(inner, "new "), ["new cycle-edge: server/a.js:4 -> server/f.js"]);

  const joined = attempt(repo, {
    "server/c.js": 'import { a } from "./a.js";\nexport const c = a;\n',
    "server/f.js": 'import { a } from "./a.js";\nimport "./c.js";\nexport function f() { return a; }\n'
  });
  eq("a module joining the existing cycle fails", joined.code, 1);
  eq("the edges that close the loop are named", lines(joined, "new "), ["new cycle-edge: server/c.js:1 -> server/a.js", "new cycle-edge: server/f.js:2 -> server/c.js"]);

  const acyclic = attempt(repo, { "server/g.js": 'import { a } from "./a.js";\nimport { f } from "./f.js";\nexport const g = [a, f];\n' });
  eq("a new acyclic server module importing cycle members passes", acyclic.code, 0);

  writeFiles(repo, {
    "server/b.js": 'import { f } from "./f.js";\nconst enabled = true;\nexport function b() { return enabled && f(); }\n',
    "server/f.js": "export function f() { return 1; }\n"
  });
  const paid = cli(repo);
  eq("removing debt without pruning warns and passes", paid.code, 0);
  eq("every resolved entry is listed as a warning", lines(paid, "warning: resolved "), [
    "warning: resolved cycle-edge: server/a.js -> server/b.js",
    "warning: resolved cycle-edge: server/b.js -> server/f.js",
    "warning: resolved cycle-edge: server/f.js -> server/a.js"
  ]);
  eq("--prune accepts it", cli(repo, "--prune").code, 0);
  eq("the pruned baseline removes resolved cycle edges", JSON.parse(readFileSync(join(repo, "tools/dep-baseline.json"), "utf8")).exceptions, []);
  eq("and the check passes", cli(repo).code, 0);

  const r = spawnSync(process.execPath, [join(TOOLS, "dep-report.mjs"), "--bogus"], { encoding: "utf8" });
  eq("an unknown argument exits 2", r.status, 2);

  const accepting = cliRepo(CYCLE_FIXTURE);
  cli(accepting, "--init");
  const baselineFile = join(accepting, "tools/dep-baseline.json");
  const initial = readFileSync(baselineFile, "utf8");
  writeFiles(accepting, { "server/a.js": CYCLE_FIXTURE["server/a.js"] + 'import "./f.js";\n' });
  const moved = cli(accepting);
  eq("moving a helper between two cycle members fails the check", moved.code, 1);
  check("the summary counts the baseline and the new entries separately", moved.out.includes("3 exceptions in the baseline, 1 new, 0 resolved"), moved.out);
  eq("--accept without a reason exits 2", cli(accepting, "--accept").code, 2);
  eq("--accept with a blank reason exits 2", cli(accepting, "--accept", "  ").code, 2);
  eq("and leaves the baseline alone", readFileSync(baselineFile, "utf8"), initial);
  const accepted = cli(accepting, "--accept", "helper moved from b.js to f.js; a.js now calls it directly");
  eq("--accept with a reason exits 0", accepted.code, 0);
  check("it prints what it added", accepted.out.includes("+ cycle-edge: server/a.js:4 -> server/f.js"), accepted.out);
  const afterAccept = JSON.parse(readFileSync(baselineFile, "utf8")).exceptions;
  eq("exactly the new entry is added, with the reason", afterAccept.filter((e) => e.reason), [
    { rule: "cycle-edge", source: "server/a.js", target: "server/f.js", reason: "helper moved from b.js to f.js; a.js now calls it directly" }
  ]);
  eq("the other entries are unchanged", afterAccept.filter((e) => !e.reason).length, 3);
  eq("the check passes after --accept", cli(accepting).code, 0);

  writeFiles(accepting, { "server/f.js": "export function f() { return 1; }\n", "shared/probe.js": '"use strict";\nmodule.exports = URL;\n' });
  const mixed = cli(accepting, "--accept", "the shared probe still needs its platform port");
  const afterMixed = cli(accepting);
  eq("accept adds a new entry but does not prune resolved entries; the check then warns about them", [mixed.code, afterMixed.code, lines(afterMixed, "warning: resolved ").length > 0], [0, 0, true]);
  check("accept reports the resolved entries", mixed.out.includes("resolved remain"), mixed.out);
  eq("prune removes resolved entries and retains the new reason", [cli(accepting, "--prune").code, JSON.parse(readFileSync(baselineFile, "utf8")).exceptions.filter((e) => e.reason).map((e) => e.target)], [0, ["global:URL"]]);
  eq("the pruned baseline passes", cli(accepting).code, 0);

  writeFiles(accepting, { "src/core/document/a.ts": 'import "./b.ts";\n', "src/core/document/b.ts": 'import "./a.ts";\n' });
  const beforeCycle = readFileSync(baselineFile, "utf8");
  const refused = cli(accepting, "--accept", "trying to accept a cycle in core");
  eq("--accept refuses while a cycle runs through a migrated folder", refused.code, 1);
  eq("and writes nothing", readFileSync(baselineFile, "utf8"), beforeCycle);

  const linkedRepo = cliRepo({ "server/a.js": "export const a = 1;\n" });
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
} finally {
  rmSync(cliWork, { recursive: true, force: true });
}

console.log("\nimport-equals and load parsing:\n");
for (const [text, expected] of [
  ['import b = require("./b.cts");', { spec: "./b.cts", names: ["b"], typeOnly: false, kind: "import-equals", line: 1 }],
  ['import type b = require("./b.cts");', { spec: "./b.cts", names: ["b"], typeOnly: true, kind: "import-equals", line: 1 }]
]) eq(`the import-equals parser handles ${text}`, analyzeScript("server/a.cts", text).imports, [expected]);
eq("an internal import-equals creates no external dependency", analyzeScript("server/a.cts", "import b = Namespace.b;").imports, []);
eq("import-equals contributes an edge to runtime cycles", stronglyConnected(graph({ "server/a.cts": 'import b = require("./b.cts");', "server/b.cts": 'import a = require("./a.cts");' }), false).map((c) => c.sort()), [["server/a.cts", "server/b.cts"]]);
for (const [label, text, names] of [
  ["nested dynamic bindings", 'const { b: { value }, default: run } = await import("./b.mjs");', ["b", "default"]],
  ["a wrapped dynamic property", 'export const b = (await (import("./b.mjs"))).b;', ["b"]],
  ["a literal require property", 'const b = require("./b.mjs")["b"];', ["b"]],
  ["a promise callback", 'import("./b.mjs").then(({ b }) => b());', null]
]) eq(`the load parser handles ${label}`, analyzeScript("server/a.mjs", text).imports[0]?.names, names);

const WRITERS_OUT_OF_THE_CYCLE = [
  "src/application/save/export-kit.ts", "src/bootstrap/wiring/export-kit.ts", "src/adapters/formats/export-projections.ts", "src/adapters/formats/docx.ts", "src/adapters/formats/csv.ts",
  "src/adapters/formats/xlsx.ts", "src/adapters/formats/pdf.ts", "src/adapters/formats/export-text.ts", "src/bootstrap/wiring/exporters.ts"
];
const repoGraph = loadGraph(ROOT);
const inCycle = new Set(stronglyConnected(repoGraph, false).flat());
eq("the writers, the export projections, the text builders and the format declarations are outside every runtime import cycle", WRITERS_OUT_OF_THE_CYCLE.filter((p) => inCycle.has(p)), []);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
