import * as Y from "yjs";

const DEFAULT_LIMIT = 15_000_000;
const DEFAULT_WARNING = 12_000_000;
const DEFAULT_STEP = 64 * 1024;
const DEFAULT_CEILING_RATIO = 1.05;
const RECOVERY_DELAY_MS = 2000;

export type NativeSessionSize = "ok" | "warning" | "full";

export interface NativeSizeOptions {
  readonly sizeLimit?: number;
  readonly sizeWarning?: number;
  readonly sizeMinimumStep?: number;
  readonly sizeCeilingRatio?: number;
  readonly now?: () => number;
  readonly scheduleRecovery?: (run: () => void, delayMs: number) => () => void;
}

function scheduleRecovery(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

export function resolveNativeSizeOptions(options: NativeSizeOptions) {
  const limit = options.sizeLimit ?? DEFAULT_LIMIT;
  const warning = options.sizeWarning ?? Math.min(DEFAULT_WARNING, limit);
  const minimumStep = options.sizeMinimumStep ?? DEFAULT_STEP;
  const ceilingRatio = options.sizeCeilingRatio ?? DEFAULT_CEILING_RATIO;
  const ceiling = limit * ceilingRatio;
  if (!Number.isFinite(warning) || warning < 0 || warning > limit) {
    throw new RangeError("Size warning threshold must be a finite number between 0 and the size limit");
  }
  if (!Number.isSafeInteger(minimumStep) || minimumStep <= 0) {
    throw new RangeError("Size recheck step must be a positive integer");
  }
  if (!Number.isFinite(ceiling) || ceiling <= limit) {
    throw new RangeError("Size ceiling must be finite and above the size limit");
  }
  return {
    limits: Object.freeze({ limit, warning }), minimumStep, ceiling, now: options.now ?? Date.now,
    scheduleRecovery: options.scheduleRecovery ?? scheduleRecovery
  };
}

export function createNativeSizeTracker(
  doc: Y.Doc,
  { limits, minimumStep, ceiling, now, scheduleRecovery }: ReturnType<typeof resolveNativeSizeOptions>,
  publishRecovery: () => void
) {
  const { limit, warning } = limits;
  let lastExact = 0, grown = 0, measuredAt = 0, step = 0;
  let deleted = false, stopped = false;
  let cancelTimer: (() => void) | undefined;
  let state: NativeSessionSize;

  function clearRecovery(): void {
    cancelTimer?.();
    cancelTimer = undefined;
  }

  function measure(): void {
    clearRecovery();
    lastExact = Y.encodeStateAsUpdate(doc).byteLength;
    grown = 0;
    deleted = false;
    measuredAt = now();
    state = lastExact >= limit ? "full" : lastExact >= warning ? "warning" : "ok";
    const next = state === "ok" ? warning : state === "warning" ? limit : lastExact < ceiling ? ceiling : Infinity;
    step = Math.max(minimumStep, (next - lastExact) / 2);
  }

  function recoverWhenDue(): void {
    cancelTimer = undefined;
    if (checkRecovery()) publishRecovery();
  }

  function checkRecovery(): boolean {
    if (stopped || state === "ok" || !deleted) return false;
    const remaining = RECOVERY_DELAY_MS - (now() - measuredAt);
    if (remaining > 0) {
      cancelTimer ??= scheduleRecovery(recoverWhenDue, remaining);
      return false;
    }
    const previous = state;
    measure();
    return state !== previous;
  }

  measure();
  return {
    get state() { return state; },
    recordUpdate(bytes: number, hasDeletes: boolean): void {
      grown += bytes;
      deleted ||= hasDeletes;
      if (grown >= step) measure();
      else checkRecovery();
    },
    checkRecovery,
    stopRecovery(): void {
      stopped = true;
      clearRecovery();
    },
    get atCeiling() { return lastExact >= ceiling; }
  };
}
