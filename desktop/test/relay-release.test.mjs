import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createRequire } from "node:module";
import { build } from "../../build.mjs";
import { leakedCollaboration, leakedHooks, missingCollaboration, testRelayAllowances } from "../../tools/release-hooks.mjs";
import { releaseCollaborationProblems } from "../release-collaboration.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const stage = join(desktop, ".stage");
const app = join(stage, "splitpage");
const variant = join(stage, "desktop-build");
const code = join(stage, "desktop-code");
const read = file => readFileSync(file, "utf8");
const stageBuild = (...args) => execFileSync(process.execPath, [join(desktop, "stage.mjs"), ...args], { encoding: "utf8" });
const { createSessionRestore } = createRequire(import.meta.url)("../session-restore.ts");

test("main gates Recent and both desktop restore paths on the collaboration setting", () => {
  const main = read(join(desktop, "main.ts"));
  assert.match(main, /createRecents\(\{[^}]*shared: COLLAB_UI && sharedScriptKey\s*\}\)/);
  assert.match(main, /createSessionRestore\(\{[^}]*restoreShared: COLLAB_UI,\s*canRestoreShared: source => COLLAB_UI && !!retainedSharedScript\(source\)/);
});

test("main accepts a loopback relay address only when the build setting allows the test relay", () => {
  const main = read(join(desktop, "main.ts"));
  assert.match(main, /const TEST_RELAY = COLLAB_UI && COLLABORATION_SETTING\?\.testRelay === true;/);
  assert.match(main, /createRelayOwner\(userData, safeStorage, passwordPolicy, fetch, TEST_RELAY\)/);
  assert.equal((main.match(/createRelayOwner\(/g) ?? []).length, 1);
});

test("restore uses a retained shared identity when enabled and opens a blank tab when collaboration is off", () => {
  const id = "a".repeat(32);
  const source = { kind: "shared", deployment: "relay", script: "script" };
  const window = { id: "window", tabIds: [] };
  const state = { windows: [{ windowId: window.id, activeTabId: id, tabs: [{ tabId: id, source }] }] };
  for (const enabled of [true, false]) {
    window.tabIds = [];
    const tabs = new Map();
    const windowsById = new Map();
    const restore = createSessionRestore({
      desktopState: { read: () => state },
      draftsList: () => [],
      tabs, windowsById,
      createTabWindow() { windowsById.set(window.id, window); return window; },
      createTab(_windowId, spec) {
        const key = spec.tabId ?? "blank";
        window.tabIds.push(key);
        const tab = { id: key, ...spec };
        tabs.set(key, tab);
        return tab;
      },
      activateTab: () => {},
      liveWindows: () => [window],
      argvFilesToOpen: [],
      persistShellState: () => {},
      canRestoreShared: () => enabled
    });
    restore.restoreSessionAtLaunch();
    assert.equal(tabs.size, 1);
    assert.deepEqual(tabs.get(enabled ? id : "blank").source, enabled ? source : { kind: "blank" });
    assert.equal(tabs.get(enabled ? id : "blank").launchIntent.type, enabled ? "open-shared" : "blank");
  }
});

test("a release stage following a test stage keeps collaboration and removes the test hooks and test relay", () => {
  const config = parse(read(join(desktop, "electron-builder.yml")));
  assert.deepEqual(config.extraResources, [
    { from: ".stage/splitpage", to: "splitpage" },
    { from: ".stage/desktop-build", to: "splitpage/desktop-build" }
  ]);
  stageBuild("--test");
  const enabledHelp = read(join(app, "help.md"));
  assert.match(enabledHelp, /^## Collaboration$/m);
  assert.match(enabledHelp, /collaboration\/relay-setup\.md/);
  const enabledHtml = read(join(app, "index.html"));
  const enabledPreload = read(join(variant, "preload.js"));
  assert.equal(read(join(code, "collaboration.json")).trim(), '{"collabUi":true,"testRelay":true}');
  assert.ok(leakedHooks(enabledHtml).includes("__sharedTest"));
  assert.ok(testRelayAllowances(enabledHtml).includes("ws://127.0.0.1:*"));
  assert.ok(leakedCollaboration(enabledHtml).includes("settings-collaboration"));
  assert.ok(leakedCollaboration(enabledPreload).includes("splitpage:relay-owner-"));
  assert.ok(leakedCollaboration(enabledHtml).includes("share-script"));
  assert.ok(leakedCollaboration(enabledHtml).includes("share-script-modal"));
  assert.ok(leakedCollaboration(enabledHtml).includes("Shared scripts on this device"));
  assert.ok(leakedCollaboration(enabledHtml).includes("note-shared"));
  for (const marker of ['url.searchParams.has("join")', "splitpageInvitation", "join-script-modal", "Join a shared script…", "leave-script-modal", "Leave shared script"]) {
    assert.ok(leakedCollaboration(enabledHtml).includes(marker), marker);
  }
  assert.ok(leakedCollaboration(enabledPreload).includes("splitpage:relay-owner-share-create"));
  assert.ok(leakedCollaboration(enabledPreload).includes("open-shared"));
  assert.ok(leakedCollaboration(enabledPreload).includes("splitpage:relay-owner-sharing"));
  assert.match(enabledPreload, /splitpage:relay-owner-resume/);
  for (const marker of ["shared-pill", "shared-popover", "sharing-and-people", "leave-shared-script"]) {
    assert.ok(leakedCollaboration(enabledHtml).includes(marker), marker);
  }
  for (const marker of ["file-copy-banner", "file-copy-status", "file-copy-write", "file-copy-stop", "file-copy-choice", "Incomplete copy ("]) {
    assert.ok(leakedCollaboration(enabledHtml).includes(marker), marker);
  }
  for (const marker of ["Link password", "Require a password", "Change password", "Remove password", "Re-enter password",
    "link-password-modal", "collab-access-reenter-password", "/password-exchange", "The link password changed."]) {
    assert.ok(leakedCollaboration(enabledHtml).includes(marker), marker);
  }
  assert.ok(existsSync(join(app, "shared", "link-password.ts")));
  assert.match(enabledHtml, /connect-src 'self' https: http: wss: ws:\/\/127\.0\.0\.1:\*;/);
  assert.deepEqual(readdirSync(join(variant, "relay-setup")).sort(), ["index.html", "preload.js", "setup.css"]);
  assert.deepEqual(readdirSync(code).sort(), ["collaboration.json", "relay-owner.ts", "relay-setup-window.ts"]);
  const enabledSettings = read(join(code, "collaboration.json"));
  stageBuild();
  const releaseHelp = read(join(app, "help.md"));
  assert.match(releaseHelp, /^## Collaboration$/m);
  assert.match(releaseHelp, /collaboration\/relay-setup\.md/);
  assert.match(releaseHelp, /^## Installing and updating$/m);
  const release = read(join(app, "index.html"));
  const releasePreload = read(join(variant, "preload.js"));
  const preload = read(join(desktop, "preload.js"));
  assert.ok(release === build(false));
  assert.deepEqual(missingCollaboration(release), []);
  assert.ok(release.includes('id="help-collaboration"'));
  for (const marker of ["settings-collaboration", "share-script-modal", "join-script-modal", "shared-pill", "shared-popover",
    "leave-script-modal", "file-copy-banner", "link-password-modal", "data-shared-history", "Shared scripts on this device"]) {
    assert.ok(leakedCollaboration(release).includes(marker), marker);
  }
  for (const marker of ["splitpage:relay-owner-share-create", "splitpage:relay-owner-sharing", "open-shared"]) {
    assert.ok(leakedCollaboration(releasePreload).includes(marker), marker);
  }
  assert.match(release, /connect-src 'self' https: http: wss:;/);
  assert.deepEqual(leakedHooks(release), []);
  assert.deepEqual(leakedHooks(releasePreload), []);
  assert.deepEqual(testRelayAllowances(release), []);
  assert.equal(release.includes("__sharedTest"), false);
  assert.equal(release.includes("SPLITPAGE_TEST_HOOKS"), false);
  assert.deepEqual(readdirSync(join(variant, "relay-setup")).sort(), ["index.html", "preload.js", "setup.css"]);
  assert.equal(read(join(code, "collaboration.json")).trim(), '{"collabUi":true,"testRelay":false}');
  assert.deepEqual(readdirSync(code).sort(), ["collaboration.json", "relay-owner.ts", "relay-setup-window.ts"]);
  const verify = (settings, preload, appFiles) => releaseCollaborationProblems({
    appRoot: app, desktopBuild: variant, settings, preload, appFiles
  });
  const shipped = ["\\relay-owner.ts", "\\relay-setup-window.ts"];
  assert.deepEqual(verify(read(join(code, "collaboration.json")), preload, shipped), []);
  assert.deepEqual(verify(enabledSettings, preload, []), [
    "the packaged collaboration setting is missing, disabled or allows the test relay", "collaboration assets are missing"
  ]);
});

test("test hooks and invitation handling are selected independently", () => {
  const testsOnly = build(true, false);
  const collaborationOnly = build(false, true);
  assert.ok(leakedHooks(testsOnly).includes("__sharedTest"));
  assert.deepEqual(leakedCollaboration(testsOnly), []);
  assert.ok(leakedCollaboration(collaborationOnly).includes("splitpageInvitation"));
  assert.ok(leakedCollaboration(collaborationOnly).includes("settings-collaboration"));
  assert.ok(leakedCollaboration(collaborationOnly).includes("share-script-modal"));
  assert.match(collaborationOnly, /Could not reopen the local shared script/);
  assert.ok(leakedCollaboration(collaborationOnly).includes("join-script-modal"));
  assert.ok(leakedCollaboration(collaborationOnly).includes("Shared scripts on this device"));
  assert.match(collaborationOnly, /connect-src 'self' https: http: wss:;/);
  assert.ok(!leakedHooks(collaborationOnly).includes("__sharedTest"));
});
