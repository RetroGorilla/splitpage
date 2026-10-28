import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, listRepoFiles } from "../../tools/source-scan.mjs";
import { CONFIGURATION } from "../../src/test/_load-order-hooks.mjs";
import { loadAlone, NOTHING_STARTED } from "./load-order-support.ts";

const QUERIES = new Set<string>();
const CONFIGURES = /^(?:start|install|register|provide|configure|route|watch|hand|use|on)[A-Z]/;

test("every configuration function the load-order check spies on exists, and every bridge or bootstrap export that configures is spied on", () => {
  const listed = new Set<string>();
  for (const [file, entry] of Object.entries(CONFIGURATION)) {
    const spec = entry as { readonly functions: readonly string[]; readonly facade?: { readonly name: string } };
    const source = readFileSync(join(REPO, file), "utf8");
    for (const name of spec.functions) {
      assert.equal(source.split("export function " + name + "(").length, 2, file + " declares " + name + " once");
      listed.add(file + "#" + name);
    }
    if (spec.facade) assert.match(source, new RegExp("export const " + spec.facade.name + "\\b"), file + " has the " + spec.facade.name + " facade");
  }
  const unlisted: string[] = [];
  const files = (listRepoFiles(REPO) as readonly string[]).filter((f) => /^src\/(?:legacy|bootstrap)\/.+\.ts$/.test(f));
  for (const file of files) {
    for (const found of readFileSync(join(REPO, file), "utf8").matchAll(/^export (?:async )?function (\w+)/gm)) {
      const name = found[1] ?? "";
      if (CONFIGURES.test(name) && !QUERIES.has(file + "#" + name) && !listed.has(file + "#" + name)) unlisted.push(file + "#" + name);
    }
  }
  assert.deepEqual(unlisted, [], "a new function that stores a callback, an effect or an owner is added to the spy list");
});

test("the load-order check catches a module that configures a bridge while it loads, including one that only stores a callback", async () => {
  const report = await loadAlone("src/test/_configures-on-load.mjs");
  assert.equal(report.error, null);
  assert.deepEqual(report.calls.map((c) => [c.file, c.name, c.from]), [
    ["src/legacy/desktop-bridge.ts", "handDesktopTo", "src/test/_configures-on-load.mjs"],
    ["src/bootstrap/wiring/export-registry.ts", "installExportFormats", "src/test/_configures-on-load.mjs"]
  ]);
  assert.deepEqual(report.owners, { ...NOTHING_STARTED, exports: true });
});
