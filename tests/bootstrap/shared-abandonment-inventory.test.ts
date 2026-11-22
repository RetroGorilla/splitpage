import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const HOLDS = [/\.beforeCommand\(/, /\bcreateBufferedField\(/, /\bbufferedText\.open\(/];

function modules(path = ""): string[] {
  return readdirSync(join(REPO, "src", path), { withFileTypes: true }).flatMap(entry => {
    const inner = path ? path + "/" + entry.name : entry.name;
    if (entry.isDirectory()) return inner === "test" ? [] : modules(inner);
    return /\.(?:ts|js|mjs)$/.test(inner) && !/\.(?:test|d)\.(?:ts|js|mjs)$/.test(inner) ? [inner] : [];
  });
}

const source = (path: string): string => readFileSync(join(REPO, "src", path), "utf8");

test("production surfaces have no legacy buffered field registration", () => {
  assert.deepEqual(modules().filter(path => HOLDS.some(pattern => pattern.test(source(path)))).sort(), []);
});
