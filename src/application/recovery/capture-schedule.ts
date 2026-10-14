export interface CaptureTiming {
  readonly idle: number;
  readonly max: number;
  readonly slow: number;
  readonly backoffMin: number;
  readonly backoffMax: number;
}

export interface CaptureTimers {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface CaptureSchedulePorts {
  readonly timing: () => CaptureTiming;
  readonly timers: CaptureTimers;
  readonly capture: () => void;
}

export interface CaptureSchedule {
  readonly noteChange: () => void;
  readonly pending: () => boolean;
  readonly keepPending: () => void;
  readonly dropPending: () => void;
  readonly slow: () => boolean;
  readonly setSlow: (slow: boolean) => void;
  readonly cancel: () => void;
  readonly cancelRetry: () => void;
  readonly backingOff: () => boolean;
  readonly landed: () => void;
  readonly refused: () => number;
  readonly resume: () => void;
}

export function createCaptureSchedule(ports: CaptureSchedulePorts): CaptureSchedule {
  let idleTimer: unknown = null;
  let maxTimer: unknown = null;
  let retryTimer: unknown = null;
  let retryMs = 0;
  let isSlow = false;
  let isPending = false;

  function cancel(): void {
    if (idleTimer !== null) { ports.timers.clear(idleTimer); idleTimer = null; }
    if (maxTimer !== null) { ports.timers.clear(maxTimer); maxTimer = null; }
  }

  function cancelRetry(): void {
    if (retryTimer !== null) { ports.timers.clear(retryTimer); retryTimer = null; }
  }

  function fire(): void {
    cancel();
    if (retryTimer !== null) return;
    ports.capture();
  }

  function arm(): void {
    const timing = ports.timing();
    const idle = isSlow ? timing.slow : timing.idle;
    const max = isSlow ? timing.slow : timing.max;
    if (idleTimer !== null) ports.timers.clear(idleTimer);
    idleTimer = ports.timers.set(fire, idle);
    if (maxTimer === null) maxTimer = ports.timers.set(fire, max);
  }

  function noteChange(): void {
    isPending = true;
    if (retryTimer !== null) return;
    arm();
  }

  function landed(): void {
    retryMs = 0;
  }

  function refused(): number {
    const timing = ports.timing();
    isPending = true;
    cancel();
    retryMs = retryMs ? Math.min(retryMs * 2, timing.backoffMax) : timing.backoffMin;
    cancelRetry();
    retryTimer = ports.timers.set(function () {
      retryTimer = null;
      ports.capture();
    }, retryMs);
    return retryMs;
  }

  function resume(): void {
    if (isPending && retryTimer === null) arm();
  }

  return Object.freeze({
    noteChange: noteChange,
    pending: function () { return isPending; },
    keepPending: function () { isPending = true; },
    dropPending: function () { isPending = false; },
    slow: function () { return isSlow; },
    setSlow: function (slow: boolean) { isSlow = slow; },
    cancel: cancel,
    cancelRetry: cancelRetry,
    backingOff: function () { return retryTimer !== null; },
    landed: landed,
    refused: refused,
    resume: resume
  });
}
