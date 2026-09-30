import type { Availability } from "../application/actions.ts";

export interface MenuItemState {
  readonly hidden: boolean;
  readonly disabled: boolean;
  readonly reason: string;
}

export function itemAvailability(state: MenuItemState): Availability {
  const visible = !state.hidden;
  if (state.disabled) return { enabled: false, visible, reason: state.reason };
  return visible ? { enabled: true } : { enabled: true, visible };
}

export function shownWhen(shown: boolean): Availability {
  return shown ? { enabled: true } : { enabled: true, visible: false };
}
