import { compileFixtures } from "./ts-fixtures.mjs";
import { CONFIGS } from "./typecheck.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " - " + detail : ""));
  console.log("  FAIL " + name + (detail ? " - " + detail : ""));
}

const FIXTURE = "tests/__validated__/fixture.ts";

const HEAD = [
  'import type { DocumentShape } from "../../src/core/document/validated.ts";',
  'import type { IdSource } from "../../src/core/document/ports.ts";',
  'import { mergeStates } from "../../src/core/merge-states.ts";',
  'import type { MergeStatesPorts } from "../../src/core/merge-states.ts";',
  'import { mergeStateFields } from "../../src/core/merge/states.ts";',
  'import type { MergeDoc } from "../../src/core/merge/states.ts";',
  'import { migrateDocument, migrateRows } from "../../src/core/migrate.ts";',
  'import type { MigratePorts } from "../../src/core/migrate.ts";',
  'import { brollEntries, planBrollAnchors } from "../../src/core/production/broll.ts";',
  'import type { BrollState } from "../../src/core/production/broll.ts";',
  'import type { ProductionReaders } from "../../src/core/production/ports.ts";',
  'import { deriveProductionIndex, planQuickAdd, planRegistryHealing } from "../../src/core/production/tags.ts";',
  'import type { TagState } from "../../src/core/production/tags.ts";',
  'import { syncCommentAnchors } from "../../src/core/text/anchors.ts";',
  'import type { AnchorState } from "../../src/core/text/anchors.ts";',
  "declare const migratePorts: MigratePorts;",
  "declare const mergePorts: MergeStatesPorts;",
  "declare const readers: ProductionReaders;",
  "declare const ids: IdSource;",
  "declare const text: string;",
  "const doc = migrateRows(JSON.parse(text), migratePorts);",
  'const opened = migrateDocument(JSON.parse(text), { kind: "file" }, migratePorts);',
  'const plain = (html: string | null | undefined): string => html || "";'
];

const CALLS = [
  { name: "mergeStates, base", call: "mergeStates(X, doc, doc, mergePorts)", was: "MergeDoc" },
  { name: "mergeStates, mine", call: "mergeStates(doc, X, doc, mergePorts)", was: "MergeDoc" },
  { name: "mergeStates, theirs", call: "mergeStates(doc, doc, X, mergePorts)", was: "MergeDoc" },
  { name: "mergeStateFields, base", call: "mergeStateFields(X, doc, doc, mergePorts)", was: "MergeDoc" },
  { name: "mergeStateFields, mine", call: "mergeStateFields(doc, X, doc, mergePorts)", was: "MergeDoc" },
  { name: "mergeStateFields, theirs", call: "mergeStateFields(doc, doc, X, mergePorts)", was: "MergeDoc" },
  { name: "syncCommentAnchors", call: "syncCommentAnchors(X, readers.cellOf)", was: "AnchorState" },
  { name: "deriveProductionIndex", call: "deriveProductionIndex(X, readers)", was: "TagState" },
  { name: "planRegistryHealing", call: "planRegistryHealing(X, readers)", was: "TagState" },
  { name: "planQuickAdd", call: 'planQuickAdd(X, readers, "")', was: "TagState" },
  { name: "brollEntries", call: "brollEntries(X, readers, ids, plain, false)", was: "BrollState" },
  { name: "planBrollAnchors", call: "planBrollAnchors(X, readers, ids)", was: "BrollState" }
];

const LITERAL = '{ title: "", docId: "", rev: 0, schema: 1, rows: [], comments: [], productionTags: [], brollShots: [] }';

const REFUSED = (was) => [
  { kind: "an object literal with every field", arg: LITERAL },
  { kind: "a JSON.parse result", arg: "JSON.parse(text)" },
  { kind: "a JSON.parse result asserted to the type it took before", arg: `(JSON.parse(text) as ${was})` },
  { kind: "a JSON.parse result asserted to the unbranded shape", arg: "(JSON.parse(text) as DocumentShape)" }
];

const ACCEPTED = [
  { kind: "a migrateRows result", arg: "doc" },
  { kind: "a migrateDocument result", arg: "opened" },
  { kind: "a merge result", arg: "mergeStates(doc, doc, doc, mergePorts).merged" }
];

const lines = [...HEAD];
const cases = [];
for (const c of CALLS) {
  for (const r of REFUSED(c.was)) {
    lines.push(`export const v${cases.length} = ${c.call.replace("X", r.arg)};`);
    cases.push({ name: `${c.name} refuses ${r.kind}`, line: lines.length, refused: true });
  }
  for (const a of ACCEPTED) {
    lines.push(`export const v${cases.length} = ${c.call.replace("X", a.arg)};`);
    cases.push({ name: `${c.name} takes ${a.kind}`, line: lines.length, refused: false });
  }
}

const caseLines = new Set(cases.map((c) => c.line));
for (const config of CONFIGS) {
  const { errorLines } = compileFixtures({ [FIXTURE]: lines.join("\n") + "\n" }, { config });
  const errors = errorLines(FIXTURE);
  check(`${config}: the fixture's setup lines type-check`, errors.every((l) => caseLines.has(l)), JSON.stringify(errors.filter((l) => !caseLines.has(l))));
  for (const c of cases) {
    const hit = errors.includes(c.line);
    check(`${config}: ${c.name}`, hit === c.refused, hit ? "a type error" : "no type error");
  }
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
