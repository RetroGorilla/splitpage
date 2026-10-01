import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORE = fileURLToPath(new URL("../../src/core/", import.meta.url));
const DOM_GLOBALS = ["document", "window", "DOMParser", "localStorage"];

const globalsBefore = new Set(Reflect.ownKeys(globalThis));

const modules: Record<string, Record<string, unknown>> = {
  "document/broll.ts": await import("../../src/core/document/broll.ts"),
  "document/ids.ts": await import("../../src/core/document/ids.ts"),
  "document/memo.ts": await import("../../src/core/document/memo.ts"),
  "document/ports.ts": await import("../../src/core/document/ports.ts"),
  "document/tags.ts": await import("../../src/core/document/tags.ts"),
  "document/text-policy.ts": await import("../../src/core/document/text-policy.ts")
};

const globalsAfter = new Set(Reflect.ownKeys(globalThis));

function coreModules(): string[] {
  return readdirSync(CORE, { recursive: true, encoding: "utf8" })
    .map((f) => f.split("\\").join("/"))
    .filter((f) => /\.ts$/.test(f) && !/\.(test|d)\.ts$/.test(f))
    .sort();
}

test("every core module is loaded here", () => {
  assert.deepEqual(Object.keys(modules).sort(), coreModules());
});

test("core runs where no DOM globals exist", () => {
  for (const name of DOM_GLOBALS) {
    assert.equal(name in globalThis, false, name);
    assert.equal(typeof (globalThis as Record<string, unknown>)[name], "undefined", name);
  }
});

test("loading core adds no globals", () => {
  assert.deepEqual([...globalsAfter].filter((k) => !globalsBefore.has(k)), []);
});

test("core's policies run without a DOM", async () => {
  const { sha256Hex } = await import("../../src/core/document/ids.ts");
  const { plainText, safeHref } = await import("../../src/core/document/text-policy.ts");
  const { normalizeBrollProps } = await import("../../src/core/document/broll.ts");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(plainText("<b>x</b>"), "x");
  assert.equal(safeHref("javascript:x"), null);
  assert.deepEqual(normalizeBrollProps(["Mug"], []), [{ id: "", name: "Mug" }]);
  for (const name of DOM_GLOBALS) assert.equal(name in globalThis, false, name);
});
