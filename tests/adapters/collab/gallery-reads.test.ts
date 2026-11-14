import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const FOLDER = "src/adapters/collab", READ = "gallery-retirement.ts";

function table(): readonly { readonly modules: readonly string[]; readonly reads: string }[] {
  const lines = readFileSync("docs/collaboration/stage-2-shared-undo.md", "utf8").split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith("| Consumer | Module | Reads |"));
  assert.ok(start >= 0, "the consumer table is in the doc");
  const rows: { modules: string[]; reads: string }[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const [, , modules = "", reads = ""] = line.split("|").map(cell => cell.trim());
    rows.push({ modules: [...modules.matchAll(/`([\w-]+\.ts)`/g)].map(match => match[1] ?? ""), reads });
  }
  return rows;
}

test("every module that reads the stores directly is in the doc's consumer table, and every picture consumer there uses the one read", () => {
  const rows = table(), named = new Set(rows.flatMap(row => row.modules));
  const files = readdirSync(FOLDER).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const direct = files.filter(file => file !== READ && /[rR]oots(\.gallery\b|\[)/.test(readFileSync(`${FOLDER}/${file}`, "utf8")));
  assert.deepEqual(direct.filter(file => !named.has(file)), []);
  assert.deepEqual([...named].filter(file => !files.includes(file)), []);
  const through = rows.filter(row => /^(shown|the planned|notes)/.test(row.reads)).flatMap(row => row.modules);
  assert.deepEqual(through.filter(file => !readFileSync(`${FOLDER}/${file}`, "utf8").includes(`from "./${READ}"`)), []);
  assert.deepEqual(through.sort(), ["projection-source.ts", "record-executor.ts", "record-reader.ts", "removal-executor.ts", "structure-index.ts",
    "undo-executor.ts", "undo-handlers.ts", "undo-removal.ts"]);
});
