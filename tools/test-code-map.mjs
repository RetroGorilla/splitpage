import { buildMap, duplicateTypeNames, renderMap, run, actionIds, featureOf } from "./code-map.mjs";

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

console.log("\nduplicate type names:\n");

eq("two modules exporting the same type name are reported", duplicateTypeNames([
  { path: "src/core/a.ts", text: "export interface Thing { a: 1 }\n" },
  { path: "src/application/b.ts", text: "export type Thing = number;\nexport type Other = string;\n" }
]), [{ name: "Thing", paths: ["src/core/a.ts", "src/application/b.ts"] }]);
eq("tests and JavaScript are not counted", duplicateTypeNames([
  { path: "src/core/a.ts", text: "export interface Thing {}\n" },
  { path: "tests/core/a.test.ts", text: "export interface Thing {}\n" },
  { path: "src/core/a.test.ts", text: "export interface Thing {}\n" }
]), []);
eq("a local type does not count", duplicateTypeNames([
  { path: "src/core/a.ts", text: "export interface Thing {}\n" },
  { path: "src/core/b.ts", text: "interface Thing {}\n" }
]), []);

console.log("\nfeature map:\n");

eq("common and routing are not features", [featureOf("src/features/common/dom.ts"), featureOf("src/features/routing/owned.ts"), featureOf("src/features/find/find.js")], [null, null, "find"]);
eq("action ids are read from definitions", actionIds('[{\n  id: "find",\n  label: "x"\n}, {\n    id: "find-next"\n}]'), ["find", "find-next"]);
{
  const map = buildMap([
    { path: "src/features/find/find.js", text: "" },
    { path: "src/features/find/actions.ts", text: '  id: "find",\n' },
    { path: "src/features/find/ports.test.ts", text: "" },
    { path: "src/bootstrap/wiring/find.ts", text: 'import { a } from "./ports/document.ts";\nimport { b } from "../../features/find/find.js";\n' },
    { path: "src/bootstrap/wiring/ports/document.ts", text: "" },
    { path: "tests/features/find/mount.test.ts", text: "" },
    { path: "src/test/find-replace.test.mjs", text: 'import { x } from "../features/find/find.js";\n' }
  ]);
  const find = map.get("find");
  eq("source files exclude tests", find.files.sort(), ["src/features/find/actions.ts", "src/features/find/find.js"]);
  eq("the wiring that imports the feature is listed", [...find.wiring], ["src/bootstrap/wiring/find.ts"]);
  eq("the shared ports its wiring imports are listed", [...find.ports], ["document"]);
  eq("its actions are listed", find.actions, ["find"]);
  eq("tests beside it, under tests/features and importing it are listed", [...find.tests].sort(), ["src/features/find/ports.test.ts", "src/test/find-replace.test.mjs", "tests/features/find/mount.test.ts"]);
  check("the rendered row names the wiring and ports", renderMap(map).includes("| `find` | `actions.ts`, `find.js` | `find.ts` | `document` | `find` |"), renderMap(map));
}

console.log("\nthe repository:\n");

{
  const err = [];
  const code = run({ print: () => {}, printError: (l) => err.push(l) });
  check("the committed feature map is current and no exported type name is duplicated", code === 0, err.join("\n"));
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
