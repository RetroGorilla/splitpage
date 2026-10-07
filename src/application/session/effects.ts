import type { SessionChange } from "./change-set.ts";
import type { EffectPort, TimerPort } from "./ports.ts";

export interface RefreshTiming {
  readonly idleMs: number;
  readonly maxMs: number;
}

export const REFRESH_TIMING: RefreshTiming = Object.freeze({ idleMs: 180, maxMs: 1000 });

export interface EffectScheduler {
  pass: (change: SessionChange) => void;
  refresh: (job: string) => void;
  pending: () => readonly string[];
}

export function createEffectScheduler(effects: EffectPort, timers: TimerPort, timing: RefreshTiming = REFRESH_TIMING): EffectScheduler {
  let jobs = new Set<string>();
  let armed = false;
  let handle: unknown = null;
  let since = 0;

  function fire(): void {
    armed = false;
    handle = null;
    const due = jobs;
    jobs = new Set<string>();
    effects.refresh(due);
  }

  function refresh(job: string): void {
    jobs.add(job);
    const now = timers.now();
    if (armed) timers.stop(handle);
    else since = now;
    const wait = Math.max(0, Math.min(timing.idleMs, since + timing.maxMs - now));
    armed = true;
    handle = timers.start(fire, wait);
  }

  function pass(change: SessionChange): void {
    effects.dirty(change);
    effects.draft(change);
    effects.save(change);
    change.changes.derive.forEach(refresh);
  }

  return {
    pass: pass,
    refresh: refresh,
    pending: function () { return Array.from(jobs); }
  };
}
