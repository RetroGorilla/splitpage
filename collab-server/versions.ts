import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";
import { BACKUP_LOCK_NAME, VERSION_CHUNK_BYTES } from "./storage.ts";
import type { versionStorage } from "./version-storage.ts";

export interface VersionFailureRecord {
  readonly at: string;
  readonly reason: "snapshot-over-budget" | "version-store-failed" | "version-thin-failed";
}

const compress = promisify(zstdCompress);
const PAUSE_MS = 250;

export function versionHistory(
  versions: ReturnType<typeof versionStorage>,
  directory: string,
  { interval, budget, thinInterval }: { interval: number; budget: number; thinInterval: number }
) {
  const backupLock = new DatabaseSync(join(directory, BACKUP_LOCK_NAME), { timeout: 0 });
  const pending = new Map<string, { due: number }>();
  let failure: VersionFailureRecord | null = null;
  let timer: NodeJS.Timeout | undefined;
  let notice: NodeJS.Immediate | undefined;
  let scheduledAt = Infinity;
  let pausedUntil = 0;
  let sweepAt = Date.now() + thinInterval;
  let reclaimAt = 0;
  let running = false;
  let stopped = false;

  function report(reason: VersionFailureRecord["reason"]): void {
    failure = { at: new Date().toISOString(), reason };
  }

  function withBackupIdle(run: () => void): boolean {
    if (stopped || pausedUntil > Date.now()) return false;
    try {
      backupLock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5) throw error;
      pausedUntil = Date.now() + PAUSE_MS;
      return false;
    }
    try {
      run();
      return true;
    } finally {
      backupLock.exec("ROLLBACK");
    }
  }

  function schedule(): void {
    if (stopped || running) return;
    let due = Math.min(sweepAt, reclaimAt);
    for (const entry of pending.values()) due = Math.min(due, entry.due);
    const at = Math.max(due, pausedUntil);
    if (at === scheduledAt) return;
    clearTimeout(timer);
    scheduledAt = at;
    timer = setTimeout(() => { void tick(); }, Math.max(0, at - Date.now())).unref();
  }

  async function capture(script: string): Promise<{ next: number; done: boolean }> {
    if (!withBackupIdle(() => {})) return { next: 0, done: false };
    const latest = versions.latest(script);
    const due = latest ? latest.createdAt + interval : 0;
    if (due > Date.now()) return { next: due, done: false };
    const current = versions.current(script);
    if (!current) return { next: 0, done: true };
    const hash = createHash("sha256").update(current.state).digest();
    if (latest && hash.equals(latest.hash)) return { next: 0, done: true };
    const compressed = await compress(current.state);
    if (stopped) return { next: 0, done: true };
    if (compressed.length > budget) {
      report("snapshot-over-budget");
      return { next: Date.now() + interval, done: false };
    }
    const id = randomUUID();
    if (!withBackupIdle(() => versions.stage(id, script, current.generation, Date.now(), compressed.length, hash))) {
      return { next: 0, done: false };
    }
    reclaimAt = 0;
    for (let offset = 0; offset < compressed.length; offset += VERSION_CHUNK_BYTES) {
      await yieldTurn();
      if (!withBackupIdle(() => versions.append(id, offset / VERSION_CHUNK_BYTES,
        compressed.subarray(offset, offset + VERSION_CHUNK_BYTES)))) return { next: 0, done: false };
    }
    await yieldTurn();
    const publishedAt = Date.now();
    if (!withBackupIdle(() => versions.publish(id, script, publishedAt, budget))) return { next: 0, done: false };
    return { next: publishedAt + interval, done: true };
  }

  async function tick(): Promise<void> {
    scheduledAt = Infinity;
    running = true;
    try {
      const entry = [...pending].find(([, item]) => item.due <= Date.now());
      if (entry) {
        const [script, queued] = entry;
        let result;
        try {
          result = await capture(script);
        } catch {
          if (!stopped) report("version-store-failed");
          result = { next: Date.now() + interval, done: false };
        }
        if (result.done && pending.get(script) === queued) pending.delete(script);
        else if (!stopped) pending.set(script, { due: result.next });
      }
      if (stopped) return;
      if (sweepAt <= Date.now()) {
        const now = Date.now();
        sweepAt = now + thinInterval;
        for (const script of versions.scripts()) {
          await yieldTurn();
          if (!withBackupIdle(() => versions.thin(script, now, budget))) {
            sweepAt = stopped ? Infinity : pausedUntil;
            break;
          }
          reclaimAt = 0;
        }
      }
      if (reclaimAt <= Date.now()) {
        withBackupIdle(() => {
          if (!versions.reclaim()) reclaimAt = Infinity;
        });
      }
    } catch {
      if (!stopped) report("version-thin-failed");
      if (reclaimAt <= Date.now()) reclaimAt = Date.now() + thinInterval;
    } finally {
      running = false;
      schedule();
    }
  }

  try {
    for (const script of versions.pending()) pending.set(script, { due: 0 });
  } catch {
    report("version-store-failed");
  }
  schedule();

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    clearImmediate(notice);
    pending.clear();
  }

  return {
    changed(script: string): void {
      if (stopped) return;
      pending.set(script, { due: pending.get(script)?.due ?? 0 });
      notice ??= setImmediate(() => {
        notice = undefined;
        schedule();
      }).unref();
    },
    lastFailure: () => failure,
    stop,
    close(): void {
      stop();
      backupLock.close();
    }
  };
}
