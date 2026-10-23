import type { TimerPort } from "../session/ports.ts";
import type { AutoSaveTarget } from "./status.ts";

export interface AutoSaveWhereInput {
  readonly onServer: boolean;
  readonly signedOut: boolean;
  readonly linkOff: boolean;
  readonly file: { readonly handle: unknown; readonly format: string | null } | null;
}

export interface AutoSaveWhenInput {
  readonly on: boolean;
  readonly halted: string;
  readonly target: AutoSaveTarget;
}

export function autoSaveWhere(input: AutoSaveWhereInput): AutoSaveTarget {
  if (input.signedOut || (input.linkOff && input.onServer)) return null;
  if (input.onServer) return "server";
  const file = input.file;
  if (!file || !file.handle) return null;
  if (file.format === "html") return null;
  return "file";
}

export function autoSaveMay(input: AutoSaveWhenInput): boolean {
  return input.on && !input.halted && input.target !== null;
}

export interface AutoSaveTiming {
  idle: number;
  hostedIdle: number;
  max: number;
}

export type AutoSaveChange = "enabled" | "halt";

export interface AutoSavePolicyPorts {
  readonly timers: Pick<TimerPort, "start" | "stop">;
  readonly enabledAtStart: () => boolean;
  readonly due: () => void;
  readonly changed: (what: AutoSaveChange) => void;
}

export interface AutoSavePolicy {
  readonly timing: AutoSaveTiming;
  readonly enabled: () => boolean;
  readonly setEnabled: (on: boolean) => void;
  readonly halted: () => string;
  readonly halt: (reason: string) => void;
  readonly resume: () => boolean;
  readonly may: (target: AutoSaveTarget) => boolean;
  readonly idleFor: (target: AutoSaveTarget) => number;
  readonly schedule: (target: AutoSaveTarget) => void;
  readonly clear: () => void;
  readonly dueNow: () => void;
  readonly pending: () => boolean;
  readonly scheduled: () => number;
  readonly stop: () => void;
}

export const DEFAULT_AUTOSAVE_TIMING: Readonly<AutoSaveTiming> = Object.freeze({ idle: 2000, hostedIdle: 5000, max: 15000 });

export const HALTED_BY_DEFAULT = "Autosave is paused — press Save to try again.";

export function createAutoSavePolicy(ports: AutoSavePolicyPorts): AutoSavePolicy {
  const timing: AutoSaveTiming = { ...DEFAULT_AUTOSAVE_TIMING };
  let on: boolean | null = null;
  let halt = "";
  let idleTimer: unknown = null;
  let maxTimer: unknown = null;
  let arms = 0;
  let stopped = false;

  function isOn(): boolean {
    if (on === null) on = !!ports.enabledAtStart();
    return on;
  }

  function idleFor(target: AutoSaveTarget): number {
    return target === "server" ? timing.hostedIdle : timing.idle;
  }

  function clear(): void {
    if (idleTimer !== null) { ports.timers.stop(idleTimer); idleTimer = null; }
    if (maxTimer !== null) { ports.timers.stop(maxTimer); maxTimer = null; }
  }

  function due(): void {
    clear();
    ports.due();
  }

  function may(target: AutoSaveTarget): boolean {
    return autoSaveMay({ on: isOn(), halted: halt, target: target });
  }

  return Object.freeze({
    timing: timing,
    enabled: isOn,
    setEnabled: function (next: boolean) {
      on = !!next;
      if (!on) clear();
      ports.changed("enabled");
    },
    halted: function () { return halt; },
    halt: function (reason: string) {
      clear();
      halt = reason || HALTED_BY_DEFAULT;
      ports.changed("halt");
    },
    resume: function () {
      if (!halt) return false;
      halt = "";
      ports.changed("halt");
      return true;
    },
    may: may,
    idleFor: idleFor,
    schedule: function (target: AutoSaveTarget) {
      if (stopped || !may(target)) return;
      if (idleTimer !== null) ports.timers.stop(idleTimer);
      idleTimer = ports.timers.start(due, idleFor(target));
      arms += 1;
      if (maxTimer === null) maxTimer = ports.timers.start(due, timing.max);
    },
    clear: clear,
    dueNow: function () {
      if (!stopped) due();
    },
    pending: function () { return idleTimer !== null || maxTimer !== null; },
    scheduled: function () { return arms; },
    stop: function () {
      stopped = true;
      clear();
    }
  });
}
