import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

const HOLDS = [/\.beforeCommand\(/, /\bcreateBufferedField\(/, /\bbufferedText\.open\(/];

type Row = { readonly registers: string } | { readonly holdsNothing: string } | { readonly notSharedYet: string };

const SURFACES: Readonly<Record<string, Row>> = {
  "application/editing/buffered-field.ts": { registers: "const stopAbandonment = ports.abandonment?.(abandon);" },
  "features/writer/flow-buffer.ts": { registers: "createBufferedField(ports" },
  "bootstrap/wiring/ports/writer-visual-buffer.ts": { registers: "const stopAbandonment = shared.bufferedText.abandonment?.(abandon);" },
  "features/empty-script/empty-script.ts": { registers: "abandoning = ports.abandonment?.(abandon);" },
  "bootstrap/wiring/shared-test-peer.ts": { holdsNothing: "the test peer opens an edit and commits it in the same call" },
  "bootstrap/wiring/split-buffer.ts": { notSharedYet: "#1581" },
  "bootstrap/wiring/buffered-input.ts": { notSharedYet: "#1581" },
  "features/rows/scene-controls.ts": { notSharedYet: "#1591" }
};

function modules(path = ""): string[] {
  return readdirSync(join(REPO, "src", path), { withFileTypes: true }).flatMap(entry => {
    const inner = path ? path + "/" + entry.name : entry.name;
    if (entry.isDirectory()) return inner === "test" ? [] : modules(inner);
    return /\.(?:ts|js|mjs)$/.test(inner) && !/\.(?:test|d)\.(?:ts|js|mjs)$/.test(inner) ? [inner] : [];
  });
}

const source = (path: string): string => readFileSync(join(REPO, "src", path), "utf8");

test("every surface that can hold an uncommitted shared edit or composition has an abandonment row, and every registered row registers", () => {
  const holders = modules().filter(path => HOLDS.some(pattern => pattern.test(source(path)))).sort();
  assert.deepEqual(holders, Object.keys(SURFACES).sort(),
    "a surface that admits shared commands or holds a buffered edit must register for abandonment (SharedBindings.abandon and drop) and add its row here");
  for (const [path, row] of Object.entries(SURFACES)) {
    if ("registers" in row) assert.ok(source(path).includes(row.registers), path + " registers its abandon step");
    if ("notSharedYet" in row) {
      assert.equal(/abandonment/.test(source(path)), false, path + " is listed as not shared yet; once " + row.notSharedYet + " mounts it in a shared session, register it and move its row");
    }
  }
});
