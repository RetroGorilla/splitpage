import type { Availability } from "../application/actions.ts";

export type Blocker = "loading" | "prompter" | "writer" | "dialog" | "launcher" | "tour";

export interface ScreenState {
  readonly loading: boolean;
  readonly prompter: boolean;
  readonly writer: boolean;
  readonly tour: boolean;
}

const REASONS: Readonly<Record<Blocker, string>> = {
  loading: "Still loading…",
  prompter: "Close Present first",
  writer: "Close the Writer first",
  dialog: "Close the open dialog first",
  launcher: "Close the open dialog first",
  tour: "Finish or skip the tour first"
};

let launcherAsking = false;

export function askingFromLauncher<T>(read: () => T): T {
  launcherAsking = true;
  try {
    return read();
  } finally {
    launcherAsking = false;
  }
}

export function dialogOpen(): boolean {
  return document.querySelector(".modal-backdrop:not([hidden])") !== null;
}

function launcherOpen(): boolean {
  return !launcherAsking && document.querySelector(".cmdk-backdrop:not([hidden])") !== null;
}

function blocked(blocker: Blocker, screen: ScreenState): boolean {
  if (blocker === "dialog") return dialogOpen();
  if (blocker === "launcher") return launcherOpen();
  return screen[blocker];
}

export function availableUnless(blockers: readonly Blocker[], screen: ScreenState, checked?: boolean): Availability {
  const hit = blockers.find((b) => blocked(b, screen));
  const base: Availability = hit ? { enabled: false, reason: REASONS[hit] } : { enabled: true };
  return checked === undefined ? base : { ...base, checked };
}
