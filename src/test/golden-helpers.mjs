import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../../tools/main-module.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
export const GOLDEN_DIR = join(HERE, "fixtures", "golden");

export function goldenUpdating(name) {
  const raw = process.env.GOLDEN_UPDATE;
  if (!raw) return false;
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return names.includes("all") || names.includes(name);
}

export function goldenText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

export function goldenPath(file) {
  return join(GOLDEN_DIR, file);
}

export function readGoldenText(name, file) {
  const path = goldenPath(file);
  if (!existsSync(path)) {
    throw new Error(`golden fixture ${file} is missing; regenerate it with: node src/test/golden-helpers.mjs --update ${name}`);
  }
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

export function settleGolden(name, file, value) {
  if (goldenUpdating(name)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath(file), goldenText(value));
  }
  const text = readGoldenText(name, file);
  return { text, value: JSON.parse(text) };
}

export function createIdMasker(from, to) {
  const placeholders = new Map();
  const counts = new Map();
  const minted = [];
  function id(value, prefix) {
    if (typeof value !== "string") return value;
    if (placeholders.has(value)) return placeholders.get(value);
    if (!value.startsWith(prefix)) return value;
    const rest = value.slice(prefix.length);
    if (!/^[0-9a-z]{8,15}$/.test(rest)) return value;
    const at = parseInt(rest.slice(-8), 36);
    if (!(at >= from() && at <= to())) return value;
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    const ph = `{minted:${prefix}:${n}}`;
    placeholders.set(value, ph);
    minted.push({ prefix, value });
    return ph;
  }
  function html(text) {
    if (typeof text !== "string") return text;
    return text
      .replace(/(data-cmt=")([^"]*)(")/g, (m, a, v, b) => a + id(v, "c") + b)
      .replace(/(data-broll-id=")([^"]*)(")/g, (m, a, v, b) => a + id(v, "bs") + b);
  }
  return { id, html, minted };
}

export const FIXED_NOW = Date.UTC(2030, 0, 2, 3, 4, 5, 678);
export const FIXED_ISO = new Date(FIXED_NOW).toISOString();

function kindOf(name) {
  return name.split("-")[0];
}

export function updatingGoldens(kind) {
  return goldenUpdating(kind);
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

function fixtureFile(name) {
  return goldenPath(name + ".json");
}

function missing(name) {
  return `no golden fixture ${name}.json; generate it with: node src/test/golden-helpers.mjs --update ${kindOf(name)}`;
}

export function readGolden(name) {
  const file = fixtureFile(name);
  assert.ok(existsSync(file), missing(name));
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeGolden(name, value) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const file = fixtureFile(name);
  const text = goldenText(value);
  if (existsSync(file) && readFileSync(file, "utf8").replace(/\r\n/g, "\n") === text) return false;
  writeFileSync(file, text);
  return true;
}

export function assertGolden(name, value) {
  if (goldenUpdating(kindOf(name))) {
    writeGolden(name, value);
    return;
  }
  const file = fixtureFile(name);
  assert.ok(existsSync(file), missing(name));
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

export const IMAGE_MIME ={ png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n) => [n & 255, (n >>> 8) & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

const BUILD = {
  png: (w, h) => [
    0x89, ...ascii("PNG\r\n\x1a\n"), ...be32(13), ...ascii("IHDR"),
    ...be32(w), ...be32(h), 8, 6, 0, 0, 0, ...be32(0), ...be32(0), ...ascii("IEND")
  ],
  jpeg: (w, h) => [
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9
  ],
  gif: (w, h) => [...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0, 0x3b],
  webp: (w, h) => {
    const x = w - 1, y = h - 1;
    const bits = [0x2f, x & 255, ((x >> 8) & 0x3f) | ((y & 3) << 6), (y >> 2) & 255, (y >> 10) & 0x0f];
    return [...ascii("RIFF"), ...le32(4 + 8 + bits.length), ...ascii("WEBP"), ...ascii("VP8L"), ...le32(bits.length), ...bits];
  }
};

export function image(kind, w, h) {
  const bytes = new Uint8Array(BUILD[kind](w, h));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base64 = Buffer.from(bytes).toString("base64");
  return {
    kind,
    bytes,
    sha256,
    record: { sha256, width: w, height: h, mime: IMAGE_MIME[kind] },
    base64,
    dataUrl: `data:${IMAGE_MIME[kind]};base64,${base64}`
  };
}

function goldenTestFiles(names) {
  if (names.includes("all")) {
    return readdirSync(HERE).filter((f) => /-golden\.test\.mjs$/.test(f)).sort().map((f) => join("src", "test", f));
  }
  return names.map((n) => join("src", "test", `${n}-golden.test.mjs`));
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const names = args.slice(1).flatMap((a) => a.split(",")).map((s) => s.trim()).filter(Boolean);
  if (args[0] !== "--update" || !names.length) {
    console.error("usage: node src/test/golden-helpers.mjs --update <name>[,<name>...] | all");
    process.exitCode = 2;
  } else {
    const files = goldenTestFiles(names);
    const absent = files.filter((f) => !existsSync(join(REPO, f)));
    if (absent.length) {
      console.error(`golden-helpers: no such golden test: ${absent.join(", ")}`);
      process.exitCode = 2;
    } else {
      const r = spawnSync(process.execPath, ["--test", ...files], {
        cwd: REPO,
        stdio: "inherit",
        env: { ...process.env, GOLDEN_UPDATE: names.join(",") }
      });
      process.exitCode = r.status ?? 1;
    }
  }
}
