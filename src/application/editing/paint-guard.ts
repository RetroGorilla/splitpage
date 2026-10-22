export interface PaintGuard {
  readonly whilePainting: <T>(draw: () => T) => T;
  readonly painting: () => boolean;
  readonly afterThisPaint: (fn: () => void, ifFailed?: () => void) => void;
  readonly whileShown: <T>(edit: () => T) => T;
  readonly shown: () => boolean;
  readonly afterShown: (fn: () => void) => void;
}

interface Queued {
  readonly fn: () => void;
  readonly ifFailed: (() => void) | undefined;
}

export function createPaintGuard(): PaintGuard {
  let depth = 0;
  let queued: Queued[] = [];
  let showing = 0;
  let afterShowing: (() => void)[] = [];

  function settle(drawn: boolean): void {
    const taken = queued;
    if (drawn) {
      queued = [];
      taken.forEach((entry) => { entry.fn(); });
      return;
    }
    queued = taken.filter((entry) => !entry.ifFailed);
    taken.forEach((entry) => { if (entry.ifFailed) entry.ifFailed(); });
  }

  return {
    whilePainting<T>(draw: () => T): T {
      depth++;
      let drawn = false;
      try {
        const out = draw();
        drawn = true;
        return out;
      } finally {
        depth--;
        if (!depth) settle(drawn);
      }
    },
    painting: () => depth > 0,
    afterThisPaint(fn: () => void, ifFailed?: () => void): void {
      if (depth) queued.push({ fn: fn, ifFailed: ifFailed });
      else fn();
    },
    whileShown<T>(edit: () => T): T {
      showing++;
      try {
        return edit();
      } finally {
        showing--;
        if (!showing) {
          const taken = afterShowing;
          afterShowing = [];
          taken.forEach((fn) => { fn(); });
        }
      }
    },
    shown: () => showing > 0,
    afterShown(fn: () => void): void {
      if (showing) afterShowing.push(fn);
      else fn();
    }
  };
}

export interface UndoGuard {
  readonly whileApplying: <T>(redraw: () => T) => T;
  readonly applying: () => boolean;
}

export function createUndoGuard(): UndoGuard {
  let applying = false;
  return {
    whileApplying<T>(redraw: () => T): T {
      applying = true;
      try {
        return redraw();
      } finally {
        applying = false;
      }
    },
    applying: () => applying
  };
}
