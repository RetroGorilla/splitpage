import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leakedHooks, missingCollaboration, testRelayAllowances } from "../tools/release-hooks.mjs";

export function releaseCollaborationProblems({ appRoot, desktopBuild, settings, preload, appFiles }) {
  const problems = [];
  const index = join(appRoot, "index.html");
  if (!existsSync(index)) problems.push("index.html is missing");
  else {
    const html = readFileSync(index, "utf8");
    const missing = missingCollaboration(html);
    if (missing.length) problems.push("index.html is missing collaboration: " + missing.join(", "));
    const testRelay = testRelayAllowances(html);
    if (testRelay.length) problems.push("index.html allows the test relay: " + testRelay.join(", "));
  }
  if (settings?.trim() !== '{"collabUi":true,"testRelay":false}') {
    problems.push("the packaged collaboration setting is missing, disabled or allows the test relay");
  }
  const setup = join(desktopBuild, "relay-setup");
  if (!["index.html", "preload.js", "setup.css"].every(name => existsSync(join(setup, name))) ||
      !["relay-owner.ts", "relay-setup-window.ts"].every(name => appFiles.some(file => file.replace(/^[\\/]/, "") === name))) {
    problems.push("collaboration assets are missing");
  }
  const appPreload = join(desktopBuild, "preload.js");
  const shipped = existsSync(appPreload) ? readFileSync(appPreload, "utf8") : null;
  if (!shipped || !shipped.includes("splitpage:relay-owner-share-create") || leakedHooks(shipped).length) {
    problems.push("the collaboration preload is missing or exposes test hooks");
  }
  if (!preload || leakedHooks(preload).length) problems.push("the app preload is missing or exposes test hooks");
  return problems;
}
