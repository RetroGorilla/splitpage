import type { TimerPort } from "../session/ports.ts";

export type SectionBoundaryKey = "Backspace" | "Delete" | "Alt+ArrowUp" | "Alt+ArrowDown" | "Alt+Shift+ArrowUp" | "Alt+Shift+ArrowDown";

export interface SectionBoundaryRemoval {
  readonly press: (id: string, key: SectionBoundaryKey) => boolean;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

interface BoundaryRemovalPorts {
  readonly timers: TimerPort;
  readonly hint: (id: string | null, text: string) => void;
  readonly remove: (id: string, key: SectionBoundaryKey) => void;
}

export function createSectionBoundaryRemoval(ports: BoundaryRemovalPorts): SectionBoundaryRemoval {
  let pending: { id: string; key: SectionBoundaryKey; until: number; timer: unknown } | null = null;
  let disposed = false;
  function cancel(): void {
    if (!pending) return;
    ports.timers.stop(pending.timer);
    pending = null;
    ports.hint(null, "");
  }
  return {
    press(id, key) {
      if (disposed) return false;
      const confirms = pending?.id === id && pending.key === key && ports.timers.now() < pending.until;
      cancel();
      if (confirms) { ports.remove(id, key); return true; }
      pending = { id, key, until: ports.timers.now() + 2000, timer: ports.timers.start(cancel, 2000) };
      ports.hint(id, key.startsWith("Alt+") ? "Press again to remove the section header" : "Press " + key + " again to remove the section header");
      return false;
    },
    cancel,
    dispose() { cancel(); disposed = true; }
  };
}
