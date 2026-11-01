import type { TimerPort } from "../session/ports.ts";

export type BoundaryDeleteKey = "Backspace" | "Delete";

export interface SectionBoundaryRemoval {
  readonly press: (id: string, key: BoundaryDeleteKey) => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

interface BoundaryRemovalPorts {
  readonly timers: TimerPort;
  readonly hint: (id: string | null, text: string) => void;
  readonly remove: (id: string) => void;
}

export function createSectionBoundaryRemoval(ports: BoundaryRemovalPorts): SectionBoundaryRemoval {
  let pending: { id: string; key: BoundaryDeleteKey; until: number; timer: unknown } | null = null;
  let disposed = false;
  function cancel(): void {
    if (!pending) return;
    ports.timers.stop(pending.timer);
    pending = null;
    ports.hint(null, "");
  }
  return {
    press(id, key) {
      if (disposed) return;
      const confirms = pending?.id === id && pending.key === key && ports.timers.now() < pending.until;
      cancel();
      if (confirms) { ports.remove(id); return; }
      pending = { id, key, until: ports.timers.now() + 2000, timer: ports.timers.start(cancel, 2000) };
      ports.hint(id, "Press " + key + " again to remove the section header");
    },
    cancel,
    dispose() { cancel(); disposed = true; }
  };
}
