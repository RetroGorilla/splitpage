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
}

export function resolveNativeSizeOptions(options: NativeSizeOptions) {
  const limit = options.sizeLimit ?? DEFAULT_LIMIT;
  const warning = options.sizeWarning ?? Math.min(DEFAULT_WARNING, limit);
  const minimumStep = options.sizeMinimumStep ?? DEFAULT_STEP;
  const ceilingRatio = options.sizeCeilingRatio ?? DEFAULT_CEILING_RATIO;
  const ceiling = limit * ceilingRatio;
  if (!Number.isFinite(limit) || limit <= 0) throw new RangeError("Size limit must be a positive finite number");
  if (!Number.isFinite(warning) || warning < 0 || warning > limit) {
    throw new RangeError("Size warning threshold must be a finite number between 0 and the size limit");
  }
  if (!Number.isSafeInteger(minimumStep) || minimumStep <= 0) {
    throw new RangeError("Size recheck step must be a positive integer");
  }
  if (!Number.isFinite(ceiling) || ceiling <= limit) {
    throw new RangeError("Size ceiling must be finite and above the size limit");
  }
  return { limits: Object.freeze({ limit, warning }), minimumStep, ceiling, now: options.now ?? Date.now };
}

export function createNativeSizeTracker(doc: Y.Doc, { limits, minimumStep, ceiling, now }: ReturnType<typeof resolveNativeSizeOptions>) {
  const { limit, warning } = limits;
  let lastExact = 0, grown = 0, measuredAt = 0, step = 0;
  let state: NativeSessionSize;

  function measure(): void {
    lastExact = Y.encodeStateAsUpdate(doc).byteLength;
    grown = 0;
    measuredAt = now();
    state = lastExact >= limit ? "full" : lastExact >= warning ? "warning" : "ok";
    const next = state === "ok" ? warning : state === "warning" ? limit : lastExact < ceiling ? ceiling : Infinity;
    step = Math.max(minimumStep, (next - lastExact) / 2);
  }

  function checkRecovery(): void {
    if (state !== "ok" && grown > 0 && now() - measuredAt >= RECOVERY_DELAY_MS) measure();
  }

  measure();
  return {
    get state() { return state; },
    recordUpdate(bytes: number): void {
      grown += bytes;
      if (grown >= step) measure();
      else checkRecovery();
    },
    checkRecovery,
    get atCeiling() { return lastExact >= ceiling; }
  };
}
