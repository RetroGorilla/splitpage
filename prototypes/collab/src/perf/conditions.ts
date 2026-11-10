import { execFileSync } from "node:child_process";
import { cpus, freemem, release, totalmem } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

function cpuSnapshot(): { idle: number; total: number } {
  return cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}

export async function cpuBusy(): Promise<number> {
  const before = cpuSnapshot();
  await delay(1000);
  const after = cpuSnapshot();
  return 100 * (1 - (after.idle - before.idle) / (after.total - before.total));
}

export async function beforeMeasurement(allowOwnedEdge = false) {
  const freeMemoryBytes = freemem();
  const cpuBefore = await cpuBusy();
  const processes = process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-Command", "@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(msedge|pc-hold|cs2|dota2|Cyberpunk2077)$' } | Select-Object -ExpandProperty ProcessName) | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true }).trim() : "[]";
  const names = processes ? JSON.parse(processes) as string | string[] : [];
  const forbiddenProcesses = (Array.isArray(names) ? names : [names]).filter(name => !(allowOwnedEdge && name === "msedge"));
  return { at: new Date().toISOString(), freeMemoryBytes, cpuBefore, forbiddenProcesses };
}

export function perfMachine() {
  return { cpu: cpus()[0]?.model, platform: process.platform, osRelease: release(), architecture: process.arch, totalMemoryBytes: totalmem(), node: process.version, yjs: "13.6.33" };
}
