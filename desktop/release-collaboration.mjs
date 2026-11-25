import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leakedCollaboration } from "../tools/release-hooks.mjs";

export function releaseCollaborationProblems({ appRoot, desktopBuild, settings, preload, appFiles }) {
  const problems = [];
  const index = join(appRoot, "index.html");
  if (!existsSync(index)) problems.push("index.html is missing");
  else {
    const markers = leakedCollaboration(readFileSync(index, "utf8"));
    if (markers.length) problems.push("index.html contains collaboration entry points: " + markers.join(", "));
  }
  if (settings?.trim() !== '{"collabUi":false}') {
    problems.push("the packaged collaboration setting is missing or enabled");
  }
  if ((existsSync(desktopBuild) && readdirSync(desktopBuild).length) ||
      existsSync(join(appRoot, "relay-setup")) ||
      appFiles.some(name => /(?:^|[\\/])relay-(?:setup|owner)/.test(name))) {
    problems.push("collaboration assets were packaged");
  }
  if (!preload || leakedCollaboration(preload).length) problems.push("the app preload is missing or exposes collaboration IPC");
  return problems;
}
