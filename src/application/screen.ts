import type { Availability } from "./actions.ts";

export type Overlay = "dialog" | "launcher" | "tour" | "prompter" | "writer" | "shotlist";

export type Blocker = "loading" | Overlay;

export type ScreenState = Readonly<Record<Blocker, boolean>>;

const IN_FRONT_FIRST: readonly Blocker[] = ["loading", "dialog", "launcher", "tour", "prompter", "writer", "shotlist"];

export const EVERY_OVERLAY: readonly Overlay[] = ["dialog", "launcher", "tour", "prompter", "writer", "shotlist"];

export const OPENS_A_DIALOG: readonly Overlay[] = ["dialog", "tour"];

const REASONS: Readonly<Record<Blocker, string>> = {
  loading: "Still loading…",
  prompter: "Close Present first",
  writer: "Close the writer first",
  shotlist: "Close the shot list first",
  dialog: "Close the open dialog first",
  launcher: "Close the open dialog first",
  tour: "Finish or skip the tour first"
};

export function everyOverlayBut(own: Overlay): readonly Overlay[] {
  return EVERY_OVERLAY.filter((o) => o !== own);
}

export function inFront(blockers: readonly Blocker[], screen: ScreenState): Blocker | undefined {
  return IN_FRONT_FIRST.find((b) => screen[b] && blockers.includes(b));
}

export function firstRefusal(screen: Availability, own: Availability): Availability {
  return screen.enabled ? own : screen;
}

export function availableUnless(blockers: readonly Blocker[], screen: ScreenState, checked?: boolean): Availability {
  const hit = inFront(blockers, screen);
  const base: Availability = hit ? { enabled: false, reason: REASONS[hit] } : { enabled: true };
  return checked === undefined ? base : { ...base, checked };
}
