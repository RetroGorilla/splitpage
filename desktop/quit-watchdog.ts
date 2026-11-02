"use strict";

type QuitWatchdogTimer = ReturnType<typeof setTimeout> | number;
interface QuitWatchdogTimers {
  setTimeout: (callback: () => void, delayMs: number) => QuitWatchdogTimer;
  clearTimeout: (timer: QuitWatchdogTimer) => void;
}

function createQuitWatchdog(delayMs: number, isWaiting: () => boolean, onExpire: () => void, timers?: QuitWatchdogTimers) {
  const t = timers || { setTimeout, clearTimeout };
  let timer: QuitWatchdogTimer | null = null;
  let done = false;
  const fire = () => {
    timer = null;
    if (done) return;
    if (isWaiting()) { timer = t.setTimeout(fire, delayMs); return; }
    done = true;
    onExpire();
  };
  timer = t.setTimeout(fire, delayMs);
  return {
    restart() {
      if (done) return;
      if (timer !== null) t.clearTimeout(timer);
      timer = t.setTimeout(fire, delayMs);
    },
    stop() {
      done = true;
      if (timer !== null) t.clearTimeout(timer);
      timer = null;
    }
  };
}

export type { createQuitWatchdog };

module.exports = { createQuitWatchdog };
