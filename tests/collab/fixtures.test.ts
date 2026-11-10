import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureTable, stage0TraceTable } from "./fixtures.ts";
import * as oracles from "./oracles/oracles.ts";
import * as bufferOracles from "./oracles/buffer-oracles.ts";
import * as bufferReplacements from "./oracles/buffer-replacements.ts";
import * as structureOracles from "./oracles/structure-oracles.ts";
import * as markOracles from "./oracles/marks/oracles.ts";
import * as staleExpectations from "./oracles/split-stale/lifecycle-expectations.ts";
import * as splitExpectations from "./oracles/split-reconcile/lifecycle-expectations.ts";

const modules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "oracles.ts": oracles,
  "buffer-oracles.ts": bufferOracles,
  "buffer-replacements.ts": bufferReplacements,
  "structure-oracles.ts": structureOracles,
  "marks/oracles.ts": markOracles,
  "split-stale/lifecycle-expectations.ts": staleExpectations,
  "split-reconcile/lifecycle-expectations.ts": splitExpectations
};
const notOracles = new Set(["buffer-oracles.ts:bufferTraceOrder"]);

function oracleExports(): string[] {
  const found: string[] = [];
  for (const [file, module] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(module)) {
      const id = `${file}:${name}`;
      if (notOracles.has(id)) continue;
      if (name.endsWith("Oracle")) found.push(id);
      else if (Array.isArray(value)) for (const item of value as { name: string }[]) found.push(`${id}[${JSON.stringify(item.name)}]`);
      else for (const key of Object.keys(value as object)) found.push(`${id}[${JSON.stringify(key)}]`);
    }
  }
  return found;
}

test("every copied oracle export has exactly one row in the fixture table", () => {
  const exported = oracleExports();
  const listed = fixtureTable.map(entry => entry.oracle);
  assert.deepEqual(listed.filter((id, index) => listed.indexOf(id) !== index), [], "listed twice");
  assert.deepEqual(exported.filter(id => !listed.includes(id)), [], "exported but missing from the fixture table");
  assert.deepEqual(listed.filter(id => !exported.includes(id)), [], "listed but not exported");
});

test("the table names a work package for every Stage 2 fixture and none for candidate A data", () => {
  for (const entry of fixtureTable) {
    if (entry.status === "candidate A only") assert.equal(entry.workPackage, null, entry.oracle);
    else assert.notEqual(entry.workPackage, null, entry.oracle);
  }
});

test("every Stage 0 row the table names is a row of the Stage 0 trace or defect table", () => {
  const document = readFileSync(new URL(`../../${stage0TraceTable}`, import.meta.url), "utf8");
  const rows = new Set(document.split("\n").filter(line => line.startsWith("| ")).map(line => line.split("|")[1]?.trim()));
  assert.deepEqual([...new Set(fixtureTable.map(entry => entry.stage0Row))].filter(row => !rows.has(row)), []);
});

test("the export walk finds an oracle the table does not list", () => {
  const listed = new Set(fixtureTable.map(entry => entry.oracle));
  const unlisted = 'structure-oracles.ts:beatOracles["T05 two splits"]';
  listed.delete(unlisted);
  assert.deepEqual(oracleExports().filter(id => !listed.has(id)), [unlisted]);
});
