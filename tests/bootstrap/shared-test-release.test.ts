import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const TIMING_MARKS = ["trial", "live-apply", "mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry", "render",
  "input-handler", "input-command", "input-write"].flatMap(seam => [`measure:${seam}:start`, `measure:${seam}:end`]);

for (const enabled of [false, true]) test("shared hook build gate: release has no hook, peer or notices, test build keeps them: " + enabled, async () => {
  const result = await build({ stdin: { contents: 'export { mountSharedSessionFeature, stopSharedSessionFeature } from "./src/bootstrap/wiring/shared-test.ts";',
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)), sourcefile: "shared-hook-build-entry.ts", loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", minify: true, treeShaking: true,
    define: { SPLITPAGE_TEST_HOOKS: String(enabled) }, logLevel: "silent" });
  const code = result.outputFiles[0]?.text; assert.ok(code);
  for (const text of ["__sharedTest", "The peer has left", "The peer beat is missing", "draft-not-kept", "The shared session did not start",
    "The draft writer did not detach", "ownershipScans", "appliedUpdates", "app-stopped", "The late joiner has not joined", "lateJoiner",
    "The name is already given to another identity", "recoveryEntries", "nameIdentities", "nameBeat", "enterFrom", "refusedUpdate", "replayed", "stopReplay",
    "There is no refused update of that kind", "The stored shared state is incomplete", "splitpage.timingMarks", ...TIMING_MARKS]) {
    assert.equal(code.includes(text), enabled, text);
  }
});
