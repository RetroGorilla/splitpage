import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  layerOf, layerAllows, analyzeScript, buildGraph, findViolations, migratedCycles, compareBaseline, run
} from "./dep-report.mjs";

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

console.log("\nlayers:\n");

eq("src/core/document is its own layer", layerOf("src/core/document/ids.ts"), "core/document");
eq("an unlisted core folder is core", layerOf("src/core/timing/x.ts"), "core");
eq("a feature folder is named", layerOf("src/features/rows/view.ts"), "features/rows");
eq("numbered modules are legacy-js", layerOf("src/js/21-events.js"), "legacy-js");
eq("src/test is tests", layerOf("src/test/undo.test.mjs"), "tests");
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
  eq("only free platform identifiers are reported", a.globals.map((g) => g.name).sort(), ["setTimeout", "window"]);
}

{
  const a = analyzeScript("src/js/w.js", [
    'import { S as G } from "./_state.js";',
    "G.state = {};",
    "G.dirty = true;",
    "G.editSeq++;",
    "if (G.state) G.state.rows = [];"
  ].join("\n"));
  eq("an aliased S import is detected", a.state.importsState, true);
  eq("S.state assignment through an alias is counted", a.state.stateWrites, 1);
  eq("every S field write is counted", a.state.stateFieldWrites, 3);
}

console.log("\nviolations and baseline:\n");

function graph(files) {
  return buildGraph(Object.entries(files).map(([path, text]) => ({ path, text })));
}

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
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

function runIn(repo, mode) {
  const out = [];
  const err = [];
  const code = run({ repo, baselinePath: join(repo, "baseline.json"), mode, print: (l) => out.push(l), printError: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

{
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
}

{
  const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "dep-report.mjs"), "--bogus"], { encoding: "utf8" });
  eq("an unknown argument exits 2", r.status, 2);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
