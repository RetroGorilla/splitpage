import { execFile } from "node:child_process";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO } from "../../tools/source-scan.mjs";

export interface LoadReport {
  readonly target: string;
  readonly calls: readonly { readonly file: string; readonly name: string; readonly from: string }[];
  readonly error: string | null;
  readonly owners: Readonly<Record<string, boolean | string>>;
}

export const NOTHING_STARTED = { session: false, saves: false, recovery: false, merge: false, editor: false, productionEditing: false, preferences: false, location: false, effects: false, transitions: false, actions: false, exports: false, exportServices: false, projectFileServices: false, shotHiding: false, undo: false, exportCapture: false };
const run = promisify(execFile);

export async function loadAlone(target: string): Promise<LoadReport> {
  const { stdout } = await run(process.execPath, [join(REPO, "src/test/_load-order-probe.mjs"), target], { cwd: REPO, maxBuffer: 1 << 24 });
  return JSON.parse(stdout.trim().split("\n").pop() ?? "") as LoadReport;
}

export async function loadEachAlone(targets: readonly string[]): Promise<LoadReport[]> {
  const reports: LoadReport[] = [];
  const queue = [...targets];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) reports.push(await loadAlone(next));
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, availableParallelism())) }, worker));
  return reports.sort((a, b) => (a.target < b.target ? -1 : 1));
}
