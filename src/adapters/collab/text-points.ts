import type { SharedPreparationView } from "./prepare.ts";

export function sharedTextPoints(view: SharedPreparationView, path: readonly string[]) {
  return view.scratch("text-points:" + JSON.stringify(path), () => [] as { offset: number; assoc: -1 | 0 }[]);
}
export function sharedTextPoint(view: SharedPreparationView, path: readonly string[], offset: number, assoc: -1 | 0 = 0) {
  const point = { offset, assoc }; sharedTextPoints(view, path).push(point); return point;
}
