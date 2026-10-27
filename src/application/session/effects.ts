import type { SessionChange } from "./change-set.ts";
import type { EffectPort, TimerPort } from "./ports.ts";

export interface RefreshTiming {
  readonly idleMs: number;
  readonly maxMs: number;
}

export const REFRESH_TIMING: RefreshTiming = Object.freeze({ idleMs: 180, maxMs: 1000 });

export interface EffectScheduler {
  pass: (change: SessionChange) => readonly unknown[];
  refresh: (job: string) => void;
  cancelRefresh: (jobs: readonly string[]) => void;
  pending: () => readonly string[];
  dispose: () => void;
}

export function attempt(errors: unknown[], step: () => void): void {
  try {
    step();
  } catch (error) {
    errors.push(error);
  }
}

export function createEffectScheduler(effects: EffectPort, timers: TimerPort, timing: RefreshTiming = REFRESH_TIMING): EffectScheduler {
  let jobs = new Set<string>();
  let armed = false;
  let handle: unknown = null;
  let since = 0;
  let stopped = false;
  let now = 0;
  let wait = 0;
  let fire = createFire();

  function createFire(): () => void {
    const mine = (): void => {
      if (stopped || fire !== mine) return;
      armed = false;
      handle = null;
      const due = jobs;
      jobs = new Set<string>();
      effects.refresh(due);
    };
    return mine;
  }

  function refresh(job: string): void {
    if (stopped) return;
    jobs.add(job);
    now = timers.now();
    if (armed) timers.stop(handle);
    else since = now;
    wait = Math.max(0, Math.min(timing.idleMs, since + timing.maxMs - now));
    armed = true;
    handle = timers.start(fire, wait);
  }

  function cancelRefresh(cancelled: readonly string[]): void {
    for (const job of cancelled) jobs.delete(job);
    fire = createFire();
    if (!armed) return;
    const retiring = handle;
    armed = false;
    handle = null;
    timers.stop(retiring);
    if (!jobs.size) return;
    armed = true;
    handle = timers.start(fire, Math.max(0, now + wait - timers.now()));
  }

  function pass(change: SessionChange): readonly unknown[] {
    const errors: unknown[] = [];
    if (stopped) return errors;
    attempt(errors, function () { effects.dirty(change); });
    attempt(errors, function () { effects.draft(change); });
    attempt(errors, function () { effects.save(change); });
    change.changes.derive.forEach(function (job) {
      attempt(errors, function () { refresh(job); });
    });
    return errors;
  }

  function dispose(): void {
    if (armed) timers.stop(handle);
    stopped = true;
    armed = false;
    handle = null;
    jobs = new Set<string>();
  }

  return {
    pass: pass,
    refresh: refresh,
    cancelRefresh: cancelRefresh,
    pending: function () { return Array.from(jobs); },
    dispose: dispose
  };
}
