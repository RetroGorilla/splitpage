import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TIMING_MARKS = ["trial", "live-apply", "queue", "mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry", "render",
  "cell-refresh", "input-handler", "input-command", "input-write", "receive", "drain"].flatMap(seam => [`measure:${seam}:start`, `measure:${seam}:end`]);
const MARK_LINE = /if \(\(typeof SPLITPAGE_TEST_HOOKS === "undefined" \|\| SPLITPAGE_TEST_HOOKS\) && timingMarks\.marksOn\) performance\.mark\("measure:[a-z-]+:(?:start|end)"\);/g;
const MARKED = ["src/adapters/collab/document.ts", "src/adapters/collab/state.ts", "src/adapters/collab/incremental-project.ts", "src/adapters/collab/replica.ts",
  "src/adapters/collab/buffer.ts", "src/bootstrap/wiring/session-owner.ts", "src/bootstrap/wiring/undo.ts", "src/bootstrap/wiring/ports/shared-undo.ts",
  "src/bootstrap/wiring/ports/shared-commands.ts", "src/bootstrap/wiring/editor.ts", "src/features/editing/cell-buffer.ts",
  "src/features/writer/flow-surface.ts"];

const ENTRY = [
  'export { applySharedUpdate } from "./src/adapters/collab/document.ts";',
  'export { sharedWriteFrame } from "./src/adapters/collab/state.ts";',
  'export { createSharedReplica } from "./src/adapters/collab/replica.ts";',
  'export { createSharedBufferedText } from "./src/adapters/collab/buffer.ts";',
  'export { adoptShared, onSessionChange, runCommand } from "./src/bootstrap/wiring/session-owner.ts";',
  'export { stepSharedUndo } from "./src/bootstrap/wiring/undo.ts";',
  'export { sharedUndoOwner } from "./src/bootstrap/wiring/ports/shared-undo.ts";',
  'export { mountRowsEditingFeature } from "./src/bootstrap/wiring/editor.ts";',
  'export { sharedStructureCommands } from "./src/bootstrap/wiring/ports/shared-commands.ts";',
  'export { mountCellBuffer } from "./src/features/editing/cell-buffer.ts";',
  'export { createSurface } from "./src/features/writer/flow-surface.ts";'
].join("\n");

const stripMarks: Plugin = { name: "strip-marks", setup(plugin) {
  plugin.onLoad({ filter: /\.ts$/ }, args => {
    const source = readFileSync(args.path, "utf8");
    return { contents: source.replace(MARK_LINE, ""), loader: "ts" };
  });
} };

async function bundle(enabled: boolean, plugins: Plugin[] = []): Promise<string> {
  // why: byte identity holds with identifier minification off; with build.mjs's options the two bundles have the same
  // size and are identical after identifier normalization, because renaming follows name frequency
  const result = await build({ stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "timing-marks-entry.ts", loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "browser", minifySyntax: true, minifyWhitespace: true, treeShaking: true, plugins,
    define: { SPLITPAGE_TEST_HOOKS: String(enabled) }, logLevel: "silent" });
  const code = result.outputFiles[0]?.text; assert.ok(code);
  return code;
}

test("every mark is the one guarded line the release comparison strips, and every marked module is in the bundle", () => {
  const found = MARKED.flatMap(file => readFileSync(new URL("../../" + file, import.meta.url), "utf8").match(MARK_LINE) ?? []);
  assert.deepEqual([...new Set(found.map(line => /"(measure:[^"]+)"/.exec(line)?.[1]))].sort(), [...TIMING_MARKS].sort());
  const all = MARKED.map(file => readFileSync(new URL("../../" + file, import.meta.url), "utf8")).join("\n");
  assert.equal((all.match(/performance\.mark\(/g) ?? []).length, found.length, "no mark outside the guarded line");
});

test("with identifier minification off, a release bundle of every marked module is byte for byte the bundle of the same modules with every mark line removed", async () => {
  const release = await bundle(false), stripped = await bundle(false, [stripMarks]);
  assert.equal(release, stripped);
  for (const absent of ["measure:", "performance.mark", "marksOn", "timingMarks", "SPLITPAGE_TEST_HOOKS", "finally{}"]) assert.ok(!release.includes(absent), absent);
});

test("a test build keeps every mark behind one read of the flag", async () => {
  const code = await bundle(true);
  assert.deepEqual(TIMING_MARKS.filter(mark => !code.includes(mark)), []);
  const reads = code.match(/[\w$]+\.marksOn&&performance\.mark\("measure:/g) ?? [];
  assert.equal(reads.length, (code.match(/performance\.mark\(/g) ?? []).length);
  assert.ok(!code.includes("splitpage.timingMarks"));
});
