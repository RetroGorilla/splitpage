import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--paired") {
  const { main } = await import("./measure-shared-paired.mjs");
  process.exitCode = await main(process.argv.slice(3));
} else {
  const modes = { "--options": "options", "--bytes": "bytes", "--prepare-options": "prepare-options" };
  const mode = modes[process.argv[2]];
  const entry = fileURLToPath(new URL(`../tests/collab/measure/${mode ?? "run"}.mjs`, import.meta.url));
  const result = spawnSync(process.execPath, ["--expose-gc", entry, ...process.argv.slice(mode ? 3 : 2)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
