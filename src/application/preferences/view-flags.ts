export type ViewFlagName = "findOpen" | "hideShot" | "writerOpen" | "brollPageOpen";

export interface ViewFlagChange {
  readonly flag: ViewFlagName;
  readonly value: boolean;
}

export interface ViewFlagsPorts {
  readonly hideShot: () => boolean;
}

export interface ViewFlags {
  readonly findOpen: () => boolean;
  readonly setFindOpen: (open: boolean) => void;
  readonly writerOpen: () => boolean;
  readonly setWriterOpen: (open: boolean) => void;
  readonly brollPageOpen: () => boolean;
  readonly setBrollPageOpen: (open: boolean) => void;
  readonly hideShot: () => boolean;
  readonly setHideShot: (on: boolean) => void;
  readonly onChange: (listener: (change: ViewFlagChange) => void) => () => void;
}

export function createViewFlags(ports: ViewFlagsPorts): ViewFlags {
  const state: Record<ViewFlagName, boolean> = { findOpen: false, hideShot: !!ports.hideShot(), writerOpen: false, brollPageOpen: false };
  const listeners = new Set<(change: ViewFlagChange) => void>();

  function set(flag: ViewFlagName, value: boolean): void {
    const next = !!value;
    if (state[flag] === next) return;
    state[flag] = next;
    Array.from(listeners).forEach(function (listener) { listener({ flag: flag, value: next }); });
  }

  return Object.freeze({
    findOpen: function (): boolean { return state.findOpen; },
    setFindOpen: function (open: boolean): void { set("findOpen", open); },
    writerOpen: function (): boolean { return state.writerOpen; },
    setWriterOpen: function (open: boolean): void { set("writerOpen", open); },
    brollPageOpen: function (): boolean { return state.brollPageOpen; },
    setBrollPageOpen: function (open: boolean): void { set("brollPageOpen", open); },
    hideShot: function (): boolean { return state.hideShot; },
    setHideShot: function (on: boolean): void { set("hideShot", on); },
    onChange: function (listener: (change: ViewFlagChange) => void): () => void {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
  });
}
