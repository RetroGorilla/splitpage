export interface DeleteTimerPort {
  readonly start: (run: () => void, ms: number) => unknown;
  readonly stop: (handle: unknown) => void;
}

export type DeleteArea = "row" | "tag" | "comment";

export interface DeleteConfirm {
  readonly armedId: (area: DeleteArea) => string | null;
  readonly arm: (area: DeleteArea, id: string, expired: () => void, show?: () => void, timers?: DeleteTimerPort) => void;
  readonly disarm: (area: DeleteArea) => void;
  readonly dispose: () => void;
}

interface Confirmation {
  id: string | null;
  timer: unknown;
  timers: DeleteTimerPort;
}

export function createDeleteConfirm(timers: DeleteTimerPort): DeleteConfirm {
  const confirmations: Record<DeleteArea, Confirmation> = {
    row: { id: null, timer: null, timers },
    tag: { id: null, timer: null, timers },
    comment: { id: null, timer: null, timers }
  };
  function disarm(area: DeleteArea): void {
    const held = confirmations[area];
    held.timers.stop(held.timer);
    held.id = null;
  }
  return {
    armedId: (area) => confirmations[area].id,
    arm(area, id, expired, show, clock = timers): void {
      const held = confirmations[area];
      held.id = id;
      show?.();
      held.timers.stop(held.timer);
      held.timers = clock;
      held.timer = clock.start(() => {
        held.id = null;
        expired();
      }, 2800);
    },
    disarm,
    dispose(): void {
      const failures: unknown[] = [];
      for (const area of ["row", "comment", "tag"] as const) {
        try {
          disarm(area);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Delete confirmation timers failed to stop");
    }
  };
}