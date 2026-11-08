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

export function lensIndexFit(index: number, x: number, layout: LayoutAt, beats: number, width: number): number[] {
  const q = clamp(index, 0, beats);
  const knots = layout(q, x);
  const point = lensPointAt(knots, q);
  const left = point - (knots[0] as number);
  const right = (knots[beats + 1] as number) - point;
  // why: Moving the index to satisfy a layout stop changes the click target under a stationary pointer.
  // Grow only when translating the fixed (x, index) anchor would uncover an end of the track.
  const scale = Math.max(1, left > 0 ? x / left : 1, right > 0 ? (width - x) / right : 1);
  return knots.map((knot) => x + (knot - point) * scale);
}
