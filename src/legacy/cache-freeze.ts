import { deepFreeze, noFreeze } from "../core/document/freeze.ts";
import type { Seal } from "../core/document/freeze.ts";

export const FREEZE_CACHES_PARAM = "freeze-caches";

export function freezeCachesAsked(search: string): boolean {
  return new URLSearchParams(search).get(FREEZE_CACHES_PARAM) === "1";
}

function askedAtStart(): boolean {
  try {
    return freezeCachesAsked(location.search);
  } catch {
    return false;
  }
}

export const cacheSeal: Seal = askedAtStart() ? deepFreeze : noFreeze;
