import { compileFixtures } from "./ts-fixtures.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " - " + detail : ""));
  console.log("  FAIL " + name + (detail ? " - " + detail : ""));
}

const FIXTURE = "tests/__frozen__/fixture.ts";

const HEAD = [
  'import type { CellReader } from "../../src/adapters/richtext/decode.ts";',
  'import { deepFreeze } from "../../src/core/document/freeze.ts";',
  'import { contentMemo } from "../../src/core/document/memo.ts";',
  'import type { ProductionReaders } from "../../src/core/production/ports.ts";',
  'import type { ProductionIndex } from "../../src/core/production/tags.ts";',
  'import type { CellDecoder } from "../../src/core/text/ports.ts";',
  "declare const readers: ProductionReaders;",
  "declare const index: ProductionIndex;",
  "declare const cellOf: CellReader;",
  "declare const decode: CellDecoder;",
  "declare function first<T>(list: readonly T[]): T;",
  "const memo = contentMemo((html) => ({ html: html, parts: [{ text: html }] }), deepFreeze);"
];

const READS = [
  "export const sizes: number = memo(\"\").parts.length + readers.tagsInField(\"\").length + cellOf(\"\").length + decode(\"\").length + index.entries.length;",
  "export const names: string[] = readers.tagsInField(\"\").map((t) => t.name).concat(first(index.entries).name, first(cellOf(\"\")).text);",
  "export const copy = cellOf(\"\").slice().reverse();"
];

const WRITES = [
  ["contentMemo's value", "memo(\"\").html = \"x\";"],
  ["contentMemo's nested array", "memo(\"\").parts.push({ text: \"x\" });"],
  ["contentMemo's nested object", "first(memo(\"\").parts).text = \"x\";"],
  ["tagsInField's list", "readers.tagsInField(\"\").push({ catId: \"prop\", name: \"x\", text: \"x\" });"],
  ["a tag tagsInField read", "first(readers.tagsInField(\"\")).name = \"x\";"],
  ["cueNamesInField's list", "readers.cueNamesInField(\"\")[0] = \"x\";"],
  ["a b-roll line brollInField read", "first(readers.brollInField(\"\")).desc = \"x\";"],
  ["brollPropsInField's props", "first(readers.brollPropsInField(\"\")).push(\"x\");"],
  ["the cell reader's runs", "cellOf(\"\").push(first(cellOf(\"\")));"],
  ["a run's text", "first(cellOf(\"\")).text = \"x\";"],
  ["a run's marks", "first(cellOf(\"\")).marks.b = true;"],
  ["a run's comment ids", "first(cellOf(\"\")).marks.cmt?.push(\"x\");"],
  ["a run a core decoder hands out", "first(decode(\"\")).text = \"x\";"],
  ["the index's entries", "index.entries.push(first(index.entries));"],
  ["an index entry's id", "first(index.entries).id = \"x\";"],
  ["an index entry's mentions", "first(index.entries).mentions.length = 0;"],
  ["the index's row signature", "index.rowSig[0] = \"x\";"],
  ["the index's unregistered tags", "index.unregistered.splice(0);"],
  ["the index's registry signature", "index.tagSig = [];"]
];

const lines = HEAD.concat(READS, WRITES.map((w) => w[1]));
const { errorLines } = compileFixtures({ [FIXTURE]: lines.join("\n") + "\n" });
const errors = new Set(errorLines(FIXTURE));

console.log("\nwrites into a cache's value are type errors:\n");
HEAD.concat(READS).forEach(function (text, i) {
  if (errors.has(i + 1)) check("line " + (i + 1) + " type-checks", false, text);
});
check("the fixture's head and its reads type-check", HEAD.concat(READS).every((_t, i) => !errors.has(i + 1)));
WRITES.forEach(function (w, k) {
  const line = HEAD.length + READS.length + k + 1;
  check("a write into " + w[0] + " is a type error", errors.has(line), w[1]);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
