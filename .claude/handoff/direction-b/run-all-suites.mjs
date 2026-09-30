import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const child = spawn(process.execPath, [join(repo, "tools", "run-suites.mjs"), ...process.argv.slice(2)], { stdio: "inherit", cwd: repo });
if (process.platform !== "win32") {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { child.kill(signal); });
}
child.on("close", (code) => { process.exitCode = code ?? 1; });
