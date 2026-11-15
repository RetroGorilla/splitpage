import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { admissionRound, expectedAfter, fixtures, growth, updatesFor } from "./run.mjs";
import { isMain } from "../../../tools/main-module.mjs";

export const PAIRED_FIXTURES = ["short", "long", "large"];
const base64 = bytes => Buffer.from(bytes).toString("base64");
const bytesOf = text => Buffer.from(text, "base64");

export function prepare(only) {
  const sources = fixtures().filter(source => only.includes(source.name));
  return { fixtures: sources.map(source => {
    process.stderr.write(`Preparing ${source.name}\n`);
    const row = growth(source);
    const stream = updatesFor(row.fresh, source.document.rows[0].id);
    return { name: source.name, plain: source.plain, document: source.document, fresh: base64(row.fresh), edited: base64(row.edited),
      updates: stream.updates.map(base64) };
  }) };
}

export function round(data, index) {
  assert.equal(process.versions.node, "24.22.1", "Use the repository Node pin");
  assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
  const rows = [];
  for (const fixture of data.fixtures) {
    const updates = fixture.updates.map(bytesOf), owner = fixture.document.rows[0].id;
    for (const phase of ["fresh", "edited"]) {
      const state = bytesOf(fixture[phase]), expected = expectedAfter(state, updates, owner);
      const measured = admissionRound(fixture, state, updates, expected, index - 1, index === 1);
      rows.push({ name: fixture.name, phase, per1000Typed: expected.length - state.length, run: measured });
      process.stderr.write(`${fixture.name} ${phase}: round ${index} done\n`);
    }
  }
  return rows;
}

function onlyOf(args) {
  const at = args.indexOf("--only");
  const only = at === -1 ? PAIRED_FIXTURES : (args[at + 1] ?? "").split(",").filter(Boolean);
  assert.ok(only.length && only.every(name => PAIRED_FIXTURES.includes(name)), `--only needs fixtures from ${PAIRED_FIXTURES.join(",")}`);
  return only;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--prepare") writeFileSync(args[1], JSON.stringify(prepare(onlyOf(args))));
  else if (args[0] === "--round") {
    const index = Number(args[2]);
    assert.ok(Number.isInteger(index) && index >= 1, "Usage: paired.mjs --round <data.json> <round>");
    process.stdout.write("ROUND " + JSON.stringify(round(JSON.parse(readFileSync(args[1], "utf8")), index)) + "\n");
  } else throw new Error("Usage: node --expose-gc tests/collab/measure/paired.mjs --prepare <data.json> [--only short,long,large] | --round <data.json> <round>");
}
