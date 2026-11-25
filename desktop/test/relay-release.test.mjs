import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { build } from "../../build.mjs";
import { leakedCollaboration, leakedHooks } from "../../tools/release-hooks.mjs";
import { releaseCollaborationProblems } from "../release-collaboration.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const stage = join(desktop, ".stage");
const app = join(stage, "splitpage");
const variant = join(stage, "desktop-build");
const code = join(stage, "desktop-code");
const read = file => readFileSync(file, "utf8");
const stageBuild = (...args) => execFileSync(process.execPath, [join(desktop, "stage.mjs"), ...args], { encoding: "utf8" });

test("a release stage following a test stage removes the setup code, assets, origin and preload", () => {
  const config = parse(read(join(desktop, "electron-builder.yml")));
  assert.deepEqual(config.extraResources, [
    { from: ".stage/splitpage", to: "splitpage" },
    { from: ".stage/desktop-build", to: "splitpage/desktop-build" }
  ]);
  stageBuild("--test");
  const enabledHtml = read(join(app, "index.html"));
  const enabledPreload = read(join(variant, "preload.js"));
  assert.equal(read(join(code, "collaboration.json")).trim(), '{"collabUi":true}');
  assert.ok(leakedCollaboration(enabledHtml).includes("settings-collaboration"));
  assert.ok(leakedCollaboration(enabledPreload).includes("splitpage:relay-owner-"));
  assert.ok(leakedCollaboration(enabledHtml).includes("share-script"));
  assert.ok(leakedCollaboration(enabledHtml).includes("share-script-modal"));
  for (const marker of ['url.searchParams.has("join")', "splitpageInvitation", "join-script-modal", "Join a shared script…", "leave-script-modal", "Leave shared script"]) {
    assert.ok(leakedCollaboration(enabledHtml).includes(marker), marker);
  }
  assert.ok(leakedCollaboration(enabledPreload).includes("splitpage:relay-owner-share-create"));
  assert.ok(leakedCollaboration(enabledPreload).includes("splitpage:relay-owner-sharing"));
  assert.match(enabledPreload, /splitpage:relay-owner-resume/);
  for (const marker of ["shared-pill", "shared-popover", "sharing-and-people", "leave-shared-script"]) {
    assert.ok(leakedCollaboration(enabledHtml).includes(marker), marker);
  }
  assert.match(enabledHtml, /connect-src 'self' https: http: wss: ws:\/\/127\.0\.0\.1:\*;/);
  assert.deepEqual(readdirSync(join(variant, "relay-setup")).sort(), ["index.html", "preload.js", "setup.css"]);
  assert.deepEqual(readdirSync(code).sort(), ["collaboration.json", "relay-owner.ts", "relay-setup-window.ts"]);
  stageBuild();
  const release = read(join(app, "index.html"));
  const preload = read(join(desktop, "preload.js"));
  assert.ok(release === build(false));
  assert.deepEqual(leakedCollaboration(release), []);
  assert.deepEqual(leakedCollaboration(preload), []);
  assert.match(release, /connect-src 'self' https: http: wss:;/);
  assert.deepEqual(readdirSync(variant), []);
  assert.equal(read(join(code, "collaboration.json")).trim(), '{"collabUi":false}');
  assert.deepEqual(readdirSync(code), ["collaboration.json"]);
  assert.equal(existsSync(join(app, "relay-setup")), false);
  const verify = (preload, appFiles) => releaseCollaborationProblems({
    appRoot: app, desktopBuild: variant, settings: read(join(code, "collaboration.json")), preload, appFiles
  });
  assert.deepEqual(verify(preload, []), []);
  assert.deepEqual(verify(enabledPreload, ["\\relay-setup-window.ts"]), [
    "collaboration assets were packaged", "the app preload is missing or exposes collaboration IPC"
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
  assert.match(collaborationOnly, /connect-src 'self' https: http: wss:;/);
  assert.ok(!leakedHooks(collaborationOnly).includes("__sharedTest"));
});
