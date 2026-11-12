import type { Capability, CapabilityPort, TimerPort } from "../session/ports.ts";
import type { AutoSaveTarget } from "./status.ts";

export interface AutoSaveWhereInput {
  readonly file: { readonly handle: unknown; readonly format: string | null } | null;
}

export interface AutoSaveWhenInput {
  readonly on: boolean;
  readonly halted: string;
  readonly target: AutoSaveTarget;
}

export function autoSaveWhere(input: AutoSaveWhereInput): AutoSaveTarget {
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
  max: number;
}

export type AutoSaveChange = "enabled" | "halt";

export interface AutoSavePolicyPorts {
  readonly capability: Pick<CapabilityPort, "autosave">;
  readonly timers: Pick<TimerPort, "start" | "stop">;
  readonly enabledAtStart: () => boolean;
  readonly due: () => void;
  readonly changed: (what: AutoSaveChange) => void;
}

export interface AutoSavePolicy {
  readonly timing: AutoSaveTiming;
  readonly enabled: () => boolean;
  readonly setEnabled: (on: boolean) => Capability | undefined;
  readonly halted: () => string;
  readonly halt: (reason: string) => void;
  readonly resume: () => boolean;
  readonly may: (target: AutoSaveTarget) => boolean;
  readonly idleFor: () => number;
  readonly schedule: (target: AutoSaveTarget) => Capability | undefined;
  readonly clear: () => void;
  readonly dueNow: () => Capability | undefined;
  readonly pending: () => boolean;
  readonly scheduled: () => number;
  readonly stop: () => void;
}

export const DEFAULT_AUTOSAVE_TIMING: Readonly<AutoSaveTiming> = Object.freeze({ idle: 2000, max: 15000 });

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
    if (!ports.capability.autosave().allowed) return false;
    if (on === null) on = !!ports.enabledAtStart();
    return on;
  }

  function idleFor(): number {
    return timing.idle;
  }

  function clear(): void {
    if (idleTimer !== null) { ports.timers.stop(idleTimer); idleTimer = null; }
    if (maxTimer !== null) { ports.timers.stop(maxTimer); maxTimer = null; }
  }

  function due(): Capability | undefined {
    const can = ports.capability.autosave();
    if (!can.allowed) { clear(); return can; }
    clear();
    ports.due();
  }

  function may(target: AutoSaveTarget): boolean {
    if (!ports.capability.autosave().allowed) return false;
    return autoSaveMay({ on: isOn(), halted: halt, target: target });
  }

  return Object.freeze({
    timing: timing,
    enabled: isOn,
    setEnabled: function (next: boolean) {
      const can = ports.capability.autosave();
      if (!can.allowed) return can;
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
      const can = ports.capability.autosave();
      if (!can.allowed) return can;
      if (stopped || !may(target)) return;
      if (idleTimer !== null) ports.timers.stop(idleTimer);
      idleTimer = ports.timers.start(due, idleFor());
      arms += 1;
      if (maxTimer === null) maxTimer = ports.timers.start(due, timing.max);
    },
    clear: clear,
    dueNow: function () {
      if (!stopped) return due();
    },
    pending: function () { return idleTimer !== null || maxTimer !== null; },
    scheduled: function () { return arms; },
    stop: function () {
      stopped = true;
      clear();
    }
  });
}
