// Runs every browser suite in .claude/skills/run-splitpage-app/tests with
// driver.mjs, several at once, each lane on its own ports, and writes one
// log per suite plus summary.txt to the folder you name. For Linux and
// macOS, where run-tests.ps1 (Windows only) is not available. Build first:
//   node build.mjs && node .claude/handoff/direction-b/run-all-suites.mjs ../splitpage-runs/p2 [regex]
// Env: LANES (default 6), PORT_BASE (offset added to ports 18100/19300).
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const repo = process.cwd();
const dir = repo + "/.claude/skills/run-splitpage-app/tests";
const out = resolve(process.argv[2] || "../splitpage-runs/latest");
const only = process.argv[3] ? new RegExp(process.argv[3]) : null;
mkdirSync(out, { recursive: true });
const files = readdirSync(dir).filter(f => f.endsWith(".txt") && (!only || only.test(f))).sort();
const LANES = Number(process.env.LANES || 6);
const base = Number(process.env.PORT_BASE || 0);
let next = 0; const results = [];
function runOne(lane) {
  if (next >= files.length) return Promise.resolve();
  const f = files[next++];
  const port = 18100 + base + lane * 10, cdp = 19300 + base + lane * 10;
  return new Promise(res => {
    const p = spawn("node", [repo + "/.claude/skills/run-splitpage-app/driver.mjs", "--port", String(port), "--cdp-port", String(cdp), "--script", dir + "/" + f, "--shot-dir", out + "/shots"], { cwd: repo });
    let log = "";
    p.stdout.on("data", d => log += d); p.stderr.on("data", d => log += d);
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* already gone */ } }, 600000);
    p.on("close", code => {
      clearTimeout(t);
      writeFileSync(out + "/" + f + ".log", log);
      const m = log.match(/RESULT:[^\n]*/g);
      results.push([f, code, m ? m[m.length - 1] : "NO RESULT"]);
      res();
    });
  }).then(() => runOne(lane));
}
await Promise.all(Array.from({ length: LANES }, (_, i) => runOne(i)));
results.sort((a, b) => a[0].localeCompare(b[0]));
const lines = results.map(r => `${r[1] === 0 ? "PASS" : "FAIL"} ${r[0]} ${r[2]}`);
writeFileSync(out + "/summary.txt", lines.join("\n") + "\n");
console.log(lines.filter(l => l.startsWith("FAIL")).join("\n") || "ALL PASS");
console.log(results.length + " suites");
