import { execFileSync } from "node:child_process";

const status = execFileSync("git", [
  "status", "--porcelain", "--untracked-files=all", "--",
  "desktop/preload.js", "desktop/tabstrip-preload.js"
], { encoding: "utf8" });

if (status) {
  process.stderr.write(status);
  process.exitCode = 1;
}
