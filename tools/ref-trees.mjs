import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withRefTrees(repo, label, refs, work) {
  let scratch;
  let active;
  let interrupted;
  let cleaning = false;
  let status;
  const trees = [];
  const stop = (signal) => {
    interrupted = signal;
    if (!active?.pid || cleaning) return;
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(active.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
      if (result.status !== 0) active.kill("SIGTERM");
    } else {
      try { process.kill(-active.pid, "SIGTERM"); } catch {}
    }
  };
  const run = (command, args, cwd = repo, env = process.env) => new Promise((resolve, reject) => {
    if (interrupted && !cleaning) return reject(new Error(`interrupted by ${interrupted}`));
    active = execFile(command, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, detached: process.platform !== "win32" }, (error, stdout, stderr) => {
      active = undefined;
      if (interrupted && !cleaning) reject(new Error(`interrupted by ${interrupted}`));
      else if (error) reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stdout}${stderr}`));
      else resolve(stdout);
    });
  });
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const commit = async (ref) => (await run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    const shas = {};
    for (const [side, ref] of refs) shas[side] = await commit(ref);
    if (!existsSync(join(repo, "node_modules"))) throw new Error("node_modules is missing; install the repo dependencies first");
    scratch = mkdtempSync(join(tmpdir(), `splitpage-${label}-`));
    const dirs = {};
    for (const [side] of refs) {
      const dir = join(scratch, side);
      trees.push(dir);
      console.error(`${label}: preparing ${side} ${shas[side]}`);
      await run("git", ["worktree", "add", "--detach", dir, shas[side]]);
      symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      dirs[side] = dir;
    }
    status = (await work({ dirs, shas, run, scratch })) ?? 0;
  } catch (error) {
    console.error(`${label}: ${error.message}`);
    status = 1;
  } finally {
    cleaning = true;
    let cleaned = true;
    for (const dir of trees.reverse()) {
      try {
        if (existsSync(join(dir, "node_modules"))) unlinkSync(join(dir, "node_modules"));
        if (existsSync(dir)) await run("git", ["worktree", "remove", "--force", dir]);
      } catch (error) {
        cleaned = false;
        console.error(`${label}: cleanup failed: ${error.message}`);
      }
    }
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (scratch && cleaned) rmSync(scratch, { recursive: true, force: true });
    if (!cleaned) status = 1;
  }
  return status;
}
