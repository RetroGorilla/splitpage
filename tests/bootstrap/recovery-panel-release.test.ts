import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

for (const enabled of [false, true]) test("C9 build gate: release has no panel or action path, test build keeps both: " + enabled, async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../../src/bootstrap/wiring/recovery-panel.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", minify: true, treeShaking: true,
    define: { SPLITPAGE_TEST_HOOKS: String(enabled) }, logLevel: "silent" });
  const code = result.outputFiles[0]?.text; assert.ok(code);
  for (const text of ["shared-recovery-panel", "Nothing in recovery.", "Reply without comment", "recovery-no-session", "removed discarded restore"]) {
    assert.equal(code.includes(text), enabled, text);
  }
});
