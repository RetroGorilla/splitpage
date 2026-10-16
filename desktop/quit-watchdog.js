"use strict";

function createQuitWatchdog(delayMs, isWaiting, onExpire, timers) {
  const t = timers || { setTimeout, clearTimeout };
  let timer = null;
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

module.exports = { createQuitWatchdog };
