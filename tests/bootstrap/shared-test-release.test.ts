import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

for (const enabled of [false, true]) test("shared hook build gate: release has no hook, peer or notices, test build keeps them: " + enabled, async () => {
  const result = await build({ stdin: { contents: `
    export { mountSharedSessionFeature, stopSharedSessionFeature } from "./src/bootstrap/wiring/shared-startup.ts";
    export { registerCollaborationActions } from "./src/bootstrap/wiring/collaboration.ts";
    export { mountNewTabFeature } from "./src/bootstrap/wiring/newtab.ts";
    export { mountHistoryPanelFeature } from "./src/bootstrap/wiring/history-panel.ts";
  `,
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)), sourcefile: "shared-hook-build-entry.ts", loader: "ts" },
    bundle: true, write: false, charset: "utf8", format: "esm", platform: "browser", minify: true, treeShaking: true,
    define: { SPLITPAGE_TEST_HOOKS: String(enabled), SPLITPAGE_COLLAB_UI: String(enabled) }, logLevel: "silent" });
  const code = result.outputFiles[0]?.text; assert.ok(code);
  for (const text of ["__sharedTest", "nativePeer", "draft-not-kept", "The shared session did not start",
    "The draft writer did not detach", "app-stopped", "enterFrom", "enterRetained",
    "splitpage-native-replica-log", "shared-copy-erase-failed", "invitationConnected", "invitationSettled", "Splitpage-Deployment",
    "Could not reopen the local shared script.", "share-script", "share-script-modal", "Uploading script", "shared-pill", "shared-popover", "sharing-and-people", "leave-shared-script",
    "join-script-modal", "Join a shared script…", "leave-script-modal",
    "Shared scripts on this device", "note-shared", "focus-shared", "open-shared",
    "file-copy-banner", "file-copy-status", "file-copy-write", "file-copy-stop", "file-copy-choice",
    "data-shared-version", "data-shared-history", "Versions kept by the relay for this shared script.", "/versions"]) {
    assert.equal(code.includes(text), enabled, text);
  }
  for (const text of ["ownershipScans", "appliedUpdates", "lateJoiner", "joinerType", "joinerUndo",
    "recoveryEntries", "nameIdentities", "nameBeat", "refusedUpdate", "stopReplay", "measure:trial:start"]) {
    assert.equal(code.includes(text), false, text);
  }
});
