import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { collaborationPreload } from "./build-preload.mjs";
import { leakedCollaboration } from "./release-hooks.mjs";

const status = execFileSync("git", [
  "status", "--porcelain", "--untracked-files=all", "--",
  "desktop/preload.js", "desktop/tabstrip-preload.js", "desktop/tabstrip/tabstrip.js"
], { encoding: "utf8" });

if (status) {
  process.stderr.write(status);
  process.exitCode = 1;
}

const release = readFileSync(new URL("../desktop/preload.js", import.meta.url), "utf8");
const app = collaborationPreload("preload", true);
const setup = collaborationPreload("relay-setup-preload", true);
const setupOff = collaborationPreload("relay-setup-preload", false);
const ownerChannels = ["status", "open", "test", "clear"].map(name => "splitpage:relay-owner-" + name);
if (leakedCollaboration(release).length || leakedCollaboration(setupOff).length ||
    ownerChannels.some(name => !app.includes(name)) || app.includes("splitpage:relay-setup-save") ||
    !setup.includes("splitpage:relay-setup-save") || ownerChannels.some(name => setup.includes(name))) {
  console.error("The collaboration preload variants expose the wrong IPC channels.");
  process.exitCode = 1;
}
