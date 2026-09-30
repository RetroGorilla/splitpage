import type { ActionSource, Availability } from "../application/actions.ts";

export interface MenuItemState {
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly reason: string;
}

export function greyedOut(reason: string, source: ActionSource): Availability {
  return { enabled: false, reason: source === "native-menu" ? "" : reason };
}

export function itemAvailability(state: MenuItemState, source: ActionSource): Availability {
  const visible = !state.hidden;
  if (state.disabled) return { ...greyedOut(state.reason, source), visible };
  return visible ? { enabled: true } : { enabled: true, visible };
}

export function shownWhen(shown: boolean): Availability {
  return shown ? { enabled: true } : { enabled: true, visible: false };
}
