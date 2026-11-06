export const LOCK_MARGIN_PX = 8;
export const LOCK_EDGE_PX = 24;
const LOCK_HIDDEN_PX = 6;

export interface IndexRef {
  readonly x: number;
  readonly q: number;
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

export function lensIndexAt(knots: readonly number[], x: number): number {
  const n = knots.length - 2;
  if (n < 1 || x <= (knots[0] as number)) return 0;
  if (x >= (knots[n] as number)) return n;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((knots[mid] as number) <= x) lo = mid; else hi = mid;
  }
  const w = (knots[lo + 1] as number) - (knots[lo] as number);
  return lo + (w > 0 ? (x - (knots[lo] as number)) / w : 0);
}

export function lensPointAt(knots: readonly number[], index: number): number {
  const n = knots.length - 2;
  if (n < 1) return knots[0] ?? 0;
  const q = clamp(index, 0, n);
  const j = Math.min(n - 1, Math.floor(q));
  return (knots[j] as number) + (q - j) * ((knots[j + 1] as number) - (knots[j] as number));
}

export function lensIndexMap(ref: IndexRef, x: number, trackWidth: number, beats: number): number {
  const xr = clamp(ref.x, 0, trackWidth);
  const qr = clamp(ref.q, 0, beats);
  const px = clamp(x, 0, trackWidth);
  if (px >= xr) return xr >= trackWidth ? beats : qr + (px - xr) * (beats - qr) / (trackWidth - xr);
  return xr <= 0 ? 0 : qr - (xr - px) * qr / xr;
}

type LayoutAt = (index: number, anchor: number) => readonly number[];

const STOP_PX = 1e6;
const FIT_STEPS = 24;
const FIT_EPS = 0.002;

export function lensIndexFit(index: number, x: number, layout: LayoutAt, beats: number): number {
  const atLeftStop = (q: number): number => lensPointAt(layout(q, STOP_PX), q);
  const atRightStop = (q: number): number => lensPointAt(layout(q, -STOP_PX), q);
  let q = clamp(index, 0, beats);
  if (atLeftStop(q) < x) {
    let lo = q, hi = beats;
    for (let i = 0; i < FIT_STEPS && hi - lo > FIT_EPS; i++) {
      const mid = (lo + hi) / 2;
      if (atLeftStop(mid) < x) lo = mid; else hi = mid;
    }
    q = hi;
  } else if (atRightStop(q) > x) {
    let lo = 0, hi = q;
    for (let i = 0; i < FIT_STEPS && hi - lo > FIT_EPS; i++) {
      const mid = (lo + hi) / 2;
      if (atRightStop(mid) > x) hi = mid; else lo = mid;
    }
    q = lo;
  }
  return q;
}

export function lensLockAnchor(knots: readonly number[], beat: number, trackWidth: number, minWidth: number): number {
  const shown = (knots[beat + 1] as number) - (knots[beat] as number);
  const half = Math.max(shown, minWidth) / 2;
  const centre = ((knots[beat] as number) + (knots[beat + 1] as number)) / 2;
  return half * 2 >= trackWidth ? trackWidth / 2 : clamp(centre, half, trackWidth - half);
}

export function lensLockStep(knots: readonly number[], lock: number, x: number, trackWidth: number): number {
  const n = knots.length - 2;
  if (n < 1) return -1;
  let held = lock >= 0 && lock < n ? lock : -1;
  if (held >= 0) {
    const before = held > 0 ? ((knots[held] as number) - (knots[held - 1] as number)) / 2 : 0;
    const after = ((knots[held + 2] as number) - (knots[held + 1] as number)) / 2;
    const inside = x >= (knots[held] as number) - Math.min(LOCK_MARGIN_PX, before) && x < (knots[held + 1] as number) + Math.min(LOCK_MARGIN_PX, after);
    if (!inside) held = -1;
  }
  if (held < 0) held = Math.min(n - 1, Math.floor(lensIndexAt(knots, x)));
  if (x >= trackWidth - LOCK_EDGE_PX && held < n - 1 && (knots[held + 1] as number) >= trackWidth - LOCK_HIDDEN_PX) held++;
  else if (x <= LOCK_EDGE_PX && held > 0 && (knots[held] as number) <= LOCK_HIDDEN_PX) held--;
  return held;
}
