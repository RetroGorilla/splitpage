import type { ViewFlags } from "./preferences/view-flags.ts";
import type { TimerPort } from "./session/ports.ts";

export const SHOT_HIDE_GRACE_MS = 1400;

export interface ShotRow {
  readonly id: string;
  readonly status?: unknown;
}

export interface ShotStrip {
  readonly strip: readonly string[];
}

export interface ShownRow<R extends ShotRow> {
  readonly row: R;
  readonly index: number;
}

export type ShotGroup<R extends ShotRow> = ShotStrip | ShownRow<R>;

export interface ShotHidingPorts {
  readonly flags: Pick<ViewFlags, "hideShot" | "setHideShot">;
  readonly remember: (on: boolean) => void;
  readonly rows: () => readonly ShotRow[] | null;
  readonly timers: Pick<TimerPort, "start" | "stop">;
}

export interface ShotHiding {
  readonly on: () => boolean;
  readonly set: (on: boolean) => boolean;
  readonly hidden: (row: ShotRow) => boolean;
  readonly groups: <R extends ShotRow>(rows: readonly R[]) => ShotGroup<R>[];
  readonly armGrace: (rowId: string) => void;
  readonly clearGrace: (rowId: string) => void;
  readonly reveal: (rowId: string) => void;
  readonly expand: (ids: readonly string[]) => void;
  readonly onHiding: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

export function createShotHiding(ports: ShotHidingPorts): ShotHiding {
  let expanded = new Set<string>();
  const timers = new Map<string, unknown>();
  const listeners: (() => void)[] = [];

  function on(): boolean {
    return ports.flags.hideShot();
  }

  function announce(): void {
    listeners.slice().forEach(function (listener) { listener(); });
  }

  function hidden(row: ShotRow): boolean {
    return on() && row.status === "shot" && !expanded.has(row.id);
  }

  function stopTimer(rowId: string): void {
    if (!timers.has(rowId)) return;
    ports.timers.stop(timers.get(rowId));
    timers.delete(rowId);
  }

  return Object.freeze({
    on: on,
    set: function (next: boolean): boolean {
      const want = !!next;
      if (want === on()) return false;
      ports.flags.setHideShot(want);
      if (want) expanded = new Set<string>();
      ports.remember(want);
      announce();
      return true;
    },
    hidden: hidden,
    groups: function <R extends ShotRow>(rows: readonly R[]): ShotGroup<R>[] {
      const items: ShotGroup<R>[] = [];
      let i = 0;
      while (i < rows.length) {
        const row = rows[i] as R;
        if (hidden(row)) {
          const ids: string[] = [];
          let j = i;
          for (let next = rows[j]; next !== undefined && hidden(next); next = rows[++j]) ids.push(next.id);
          items.push({ strip: ids });
          i = j;
        } else {
          items.push({ row: row, index: i });
          i++;
        }
      }
      return items;
    },
    armGrace: function (rowId: string): void {
      expanded.add(rowId);
      stopTimer(rowId);
      timers.set(rowId, ports.timers.start(function () {
        timers.delete(rowId);
        expanded.delete(rowId);
        announce();
      }, SHOT_HIDE_GRACE_MS));
    },
    clearGrace: stopTimer,
    reveal: function (rowId: string): void {
      const rows = ports.rows();
      if (!on() || !rows) return;
      const idx = rows.findIndex(function (row) { return row.id === rowId; });
      const target = rows[idx];
      if (target === undefined || !hidden(target)) return;
      let start = idx, end = idx;
      while (start > 0 && rows[start - 1]?.status === "shot") start--;
      while (end < rows.length - 1 && rows[end + 1]?.status === "shot") end++;
      for (let i = start; i <= end; i++) expanded.add((rows[i] as ShotRow).id);
      announce();
    },
    expand: function (ids: readonly string[]): void {
      ids.forEach(function (id) { if (id) expanded.add(id); });
      announce();
    },
    onHiding: function (listener: () => void): () => void {
      listeners.push(listener);
      return function () {
        const at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    dispose: function (): void {
      Array.from(timers.keys()).forEach(stopTimer);
      expanded = new Set<string>();
      listeners.length = 0;
    }
  });
}
