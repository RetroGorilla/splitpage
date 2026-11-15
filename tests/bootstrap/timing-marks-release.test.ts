import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const TIMING_MARKS = ["trial", "live-apply", "mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry", "render",
  "input-handler", "input-command", "input-write"].flatMap(seam => [`measure:${seam}:start`, `measure:${seam}:end`]);

const ENTRY = [
  'export { applySharedUpdate } from "./src/adapters/collab/document.ts";',
  'export { sharedWriteFrame } from "./src/adapters/collab/state.ts";',
  'export { createSharedReplica } from "./src/adapters/collab/replica.ts";',
  'export { adoptShared, onSessionChange } from "./src/bootstrap/wiring/session-owner.ts";',
  'export { sharedBufferPorts } from "./src/bootstrap/wiring/ports/shared-buffer.ts";',
  'export { mountCellBuffer } from "./src/features/editing/cell-buffer.ts";',
  'export { createSurface } from "./src/features/writer/flow-surface.ts";'
].join("\n");

for (const enabled of [false, true]) test("timing marks build gate: a release bundle of every marked module has no mark name, a test build has every one: " + enabled, async () => {
  const result = await build({ stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("../../", import.meta.url)), sourcefile: "timing-marks-entry.ts", loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", minify: true, treeShaking: true,
    define: { SPLITPAGE_TEST_HOOKS: String(enabled) }, logLevel: "silent" });
  const code = result.outputFiles[0]?.text; assert.ok(code);
  assert.deepEqual(TIMING_MARKS.filter(mark => code.includes(mark) !== enabled), []);
  assert.equal(code.includes("measure:"), enabled);
  assert.equal(code.includes("splitpage.timingMarks"), enabled);
});
