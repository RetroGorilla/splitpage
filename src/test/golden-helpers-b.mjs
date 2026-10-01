import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GOLDEN_DIR = fileURLToPath(new URL("./fixtures/golden/", import.meta.url));
export const FIXED_NOW = Date.UTC(2030, 0, 2, 3, 4, 5, 678);
export const FIXED_ISO = new Date(FIXED_NOW).toISOString();

export function updatingGoldens() {
  return process.env.GOLDEN_UPDATE === "1";
}

export function freezeClockAndRandom(seed) {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(FIXED_NOW);
    }
    static now() { return FIXED_NOW; }
  }
  globalThis.Date = FixedDate;
  let state = (seed >>> 0) || 1;
  Math.random = function () {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
}

export function jsonCopy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function goldenPath(name) {
  return path.join(GOLDEN_DIR, name + ".json");
}

function goldenText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

export function readGolden(name) {
  const file = goldenPath(name);
  assert.ok(existsSync(file), "no golden fixture " + name + ".json: generate it with GOLDEN_UPDATE=1");
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeGolden(name, value) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const file = goldenPath(name);
  const text = goldenText(value);
  if (existsSync(file) && readFileSync(file, "utf8").replace(/\r\n/g, "\n") === text) return false;
  writeFileSync(file, text);
  return true;
}

export function assertGolden(name, value) {
  if (updatingGoldens()) {
    writeGolden(name, value);
    return;
  }
  const file = goldenPath(name);
  assert.ok(existsSync(file), "no golden fixture " + name + ".json: generate it with GOLDEN_UPDATE=1");
  const stored = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const text = goldenText(value);
  assert.deepStrictEqual(JSON.parse(text), JSON.parse(stored), name + " differs from its golden fixture");
  assert.equal(text, stored, name + " has its golden fixture's values in a different key order");
}

export function goldenNames(prefix) {
  if (!existsSync(GOLDEN_DIR)) return [];
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function maskTokens(value, tokens, label) {
  let text = JSON.stringify(value);
  const order = [...new Set(tokens)]
    .map((token) => ({ token, at: text.indexOf(token) }))
    .filter((t) => t.at !== -1)
    .sort((a, b) => a.at - b.at);
  order.forEach((t, i) => {
    text = text.split(t.token).join("<" + label + "-" + (i + 1) + ">");
  });
  return JSON.parse(text);
}

export function newTokens(outputValue, inputValue, re) {
  const seen = new Set(JSON.stringify(inputValue).match(re) || []);
  return [...new Set(JSON.stringify(outputValue).match(re) || [])].filter((t) => !seen.has(t));
}
