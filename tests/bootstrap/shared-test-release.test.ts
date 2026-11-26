import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const TEST_ONLY = ["__sharedTest", "nativePeer", "enterFrom", "enterRetained", "invitationConnected", "invitationSettled"];

const COLLABORATION = ["draft-not-kept", "The shared session did not start", "The draft writer did not detach", "app-stopped",
  "splitpage-native-replica-log", "shared-copy-erase-failed", "Splitpage-Deployment",
  "Could not reopen the local shared script.", "share-script", "share-script-modal", "Uploading script", "shared-pill", "shared-popover",
  "sharing-and-people", "leave-shared-script", "join-script-modal", "Join a shared script…", "leave-script-modal",
  "Shared scripts on this device", "note-shared", "focus-shared", "invalid-saved-relay",
  "file-copy-banner", "file-copy-status", "file-copy-write", "file-copy-stop", "file-copy-choice",
  "data-shared-version", "data-shared-history", "Versions kept by the relay for this shared script.", "/versions"];

const BUILDS = [
  { name: "release", testHooks: false, collabUi: true },
  { name: "test", testHooks: true, collabUi: true },
  { name: "without collaboration", testHooks: false, collabUi: false }
];

for (const { name, testHooks, collabUi } of BUILDS) test("shared hook build gate: " + name + " build keeps collaboration " + collabUi + " and test hooks " + testHooks, async () => {
  const result = await build({ stdin: { contents: `
    export { mountSharedSessionFeature, stopSharedSessionFeature } from "./src/bootstrap/wiring/shared-startup.ts";
    export { registerCollaborationActions } from "./src/bootstrap/wiring/collaboration.ts";
    export { mountNewTabFeature } from "./src/bootstrap/wiring/newtab.ts";
    export { mountHistoryPanelFeature } from "./src/bootstrap/wiring/history-panel.ts";
  `,
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)), sourcefile: "shared-hook-build-entry.ts", loader: "ts" },
    bundle: true, write: false, charset: "utf8", format: "esm", platform: "browser", minify: true, treeShaking: true,
    define: { SPLITPAGE_TEST_HOOKS: String(testHooks), SPLITPAGE_COLLAB_UI: String(collabUi) }, logLevel: "silent" });
  const code = result.outputFiles[0]?.text; assert.ok(code);
  for (const text of TEST_ONLY) assert.equal(code.includes(text), testHooks, text);
  for (const text of COLLABORATION) assert.equal(code.includes(text), collabUi, text);
  assert.equal(code.includes('hostname==="127.0.0.1"'), testHooks && collabUi, "loopback test relay");
  for (const text of ["ownershipScans", "appliedUpdates", "lateJoiner", "joinerType", "joinerUndo",
    "recoveryEntries", "nameIdentities", "nameBeat", "refusedUpdate", "stopReplay", "measure:trial:start"]) {
    assert.equal(code.includes(text), false, text);
  }
});
