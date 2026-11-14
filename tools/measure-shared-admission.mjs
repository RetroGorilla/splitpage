import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../tests/collab/measure/run.mjs", import.meta.url));
const result = spawnSync(process.execPath, ["--expose-gc", entry, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
