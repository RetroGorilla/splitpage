import type { DeleteTimerPort } from "./delete-confirm.ts";

export interface ProductionSelection {
  readonly selectedKeys: () => string[];
  readonly selected: (key: string) => boolean;
  readonly anchorKey: () => string | null;
  readonly toggle: (key: string) => void;
  readonly select: (key: string, order: readonly string[], shift: boolean) => boolean;
  readonly prune: (entries: readonly { readonly key: string }[]) => void;
  readonly clear: () => void;
  readonly armed: () => boolean;
  readonly arm: (expired: () => void) => void;
  readonly disarm: () => void;
}

export function createProductionSelection(timers: DeleteTimerPort): ProductionSelection {
  let selection: Record<string, boolean> = {};
  let anchor: string | null = null;
  let armed = false;
  let timer: unknown = null;
  function disarm(): void {
    timers.stop(timer);
    armed = false;
  }
  function unselect(key: string): void {
    Reflect.deleteProperty(selection, key);
  }
  function toggle(key: string): void {
    if (selection[key]) unselect(key);
    else selection[key] = true;
    anchor = key;
  }
  return {
    selectedKeys: () => Object.keys(selection),
    selected: (key) => !!selection[key],
    anchorKey: () => anchor,
    toggle,
    select(key, order, shift): boolean {
      const here = order.indexOf(key);
      if (here === -1) return false;
      const at = anchor ? order.indexOf(anchor) : -1;
      if (shift && at !== -1) {
        const lo = Math.min(at, here), hi = Math.max(at, here);
        for (const item of order.slice(lo, hi + 1)) selection[item] = true;
      } else toggle(key);
      return true;
    },
    prune(entries): void {
      const live: Record<string, boolean> = {};
      entries.forEach((entry) => { live[entry.key] = true; });
      let dropped = false;
      Object.keys(selection).forEach((key) => {
        if (!live[key]) { unselect(key); dropped = true; }
      });
      if (dropped) disarm();
      if (anchor && !live[anchor]) anchor = null;
    },
    clear(): void {
      selection = {};
      anchor = null;
      disarm();
    },
    armed: () => armed,
    arm(expired): void {
      armed = true;
      timers.stop(timer);
      timer = timers.start(() => {
        armed = false;
        expired();
      }, 2800);
    },
    disarm
  };
}