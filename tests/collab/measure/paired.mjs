import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { admissionRound, expectedAfter, fixtures, growth, markedAdmission, stateFixture, updatesFor } from "./run.mjs";
import { TRIAL_METHOD } from "./trial-method.mjs";
import { isMain } from "../../../tools/main-module.mjs";

export const PAIRED_FIXTURES = ["short", "long", "large"];
const base64 = bytes => Buffer.from(bytes).toString("base64");
const bytesOf = text => Buffer.from(text, "base64");

const streamFor = (state, owner) => {
  const clock = performance.now(), stream = updatesFor(state, owner);
  process.stderr.write(`Update stream of ${stream.updates.length} built, ${((performance.now() - clock) / 1000).toFixed(1)} s\n`);
  return stream.updates.map(base64);
};

export function prepare(only, states = []) {
  const sources = fixtures().filter(source => only.includes(source.name));
  const built = sources.map(source => {
    process.stderr.write(`Preparing ${source.name}\n`);
    const row = growth(source);
    return { name: source.name, plain: source.plain, document: source.document, states: { fresh: base64(row.fresh), edited: base64(row.edited) },
      updates: streamFor(row.fresh, source.document.rows[0].id) };
  });
  const files = states.filter(file => only.includes(file.name)).map(file => {
    process.stderr.write(`Preparing ${file.name} from its state file\n`);
    const fixture = stateFixture(file.name, readFileSync(file.file));
    return { name: file.name, plain: fixture.plain, document: fixture.document, states: { state: base64(fixture.state) },
      updates: streamFor(fixture.state, fixture.document.rows[0].id) };
  });
  return { fixtures: [...built, ...files] };
}

export function round(data, index) {
  assert.equal(process.versions.node, "24.22.1", "Use the repository Node pin");
  assert.equal(typeof globalThis.gc, "function", "Run with --expose-gc");
  const rows = [];
  for (const fixture of data.fixtures) {
    const updates = fixture.updates.map(bytesOf), owner = fixture.document.rows[0].id;
    for (const [phase, encoded] of Object.entries(fixture.states)) {
      const state = bytesOf(encoded), expected = expectedAfter(state, updates, owner);
      const measured = admissionRound(fixture, state, updates, expected, index - 1, index === 1);
      rows.push({ name: fixture.name, phase, trial: TRIAL_METHOD, stateBytes: state.length, stateSha256: createHash("sha256").update(state).digest("hex"),
        per1000Typed: expected.length - state.length, run: measured, parts: markedAdmission(state, updates.slice(0, 500)) });
      process.stderr.write(`${fixture.name} ${phase}: round ${index} done\n`);
    }
  }
  return rows;
}

function statesOf(args) {
  return args.flatMap((arg, at) => arg === "--state" ? [args[at + 1] ?? ""] : []).map(raw => {
    const split = raw.indexOf("=");
    assert.ok(split > 0 && split < raw.length - 1, "--state needs <name>=<file>");
    return { name: raw.slice(0, split), file: raw.slice(split + 1) };
  });
}

function onlyOf(args, states) {
  const at = args.indexOf("--only"), known = [...PAIRED_FIXTURES, ...states.map(file => file.name)];
  const only = at === -1 ? known : (args[at + 1] ?? "").split(",").filter(Boolean);
  assert.ok(only.length && only.every(name => known.includes(name)), `--only needs fixtures from ${known.join(",")}`);
  return only;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--prepare") {
    const states = statesOf(args);
    writeFileSync(args[1], JSON.stringify(prepare(onlyOf(args, states), states)));
  }
  else if (args[0] === "--round") {
    const index = Number(args[2]);
    assert.ok(Number.isInteger(index) && index >= 1, "Usage: paired.mjs --round <data.json> <round>");
    process.stdout.write("ROUND " + JSON.stringify(round(JSON.parse(readFileSync(args[1], "utf8")), index)) + "\n");
  } else throw new Error("Usage: node --expose-gc tests/collab/measure/paired.mjs --prepare <data.json> [--only short,long,large,<state>] [--state <name>=<file> ...] | --round <data.json> <round>");
}
