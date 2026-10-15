export type RootRoute<E> = (event: E) => boolean;

export interface RootRouter<Slot extends string, E> {
  readonly handle: (event: E) => void;
  readonly route: (slot: Slot, handler: RootRoute<E>) => () => void;
  readonly routed: () => readonly Slot[];
}

export function createRootRouter<Slot extends string, E>(order: readonly Slot[], gate?: (event: E) => boolean): RootRouter<Slot, E> {
  if (new Set(order).size !== order.length) throw new Error("a root route slot is listed twice");
  const handlers = new Map<Slot, RootRoute<E>>();
  return {
    handle: (event) => {
      if (gate && gate(event)) return;
      for (const slot of order) {
        const handler = handlers.get(slot);
        if (handler && handler(event)) return;
      }
    },
    route: (slot, handler) => {
      if (!order.includes(slot)) throw new Error(`there is no root route slot ${slot}`);
      if (handlers.has(slot)) throw new Error(`the root route ${slot} is already taken`);
      handlers.set(slot, handler);
      return () => {
        if (handlers.get(slot) === handler) handlers.delete(slot);
      };
    },
    routed: () => order.filter((slot) => handlers.has(slot))
  };
}

export const ROOT_CLICK_ORDER = [
  "rows-add",
  "toolbar",
  "video",
  "comments",
  "tags-jump",
  "comments-jump",
  "tags",
  "history-restore",
  "rows-scene",
  "rows-menu",
  "media-picker",
  "gallery",
  "media-link"
] as const;

export type RootClickSlot = (typeof ROOT_CLICK_ORDER)[number];

export const ROOT_MOUSEDOWN_ORDER = ["tags-anchor"] as const;

export type RootMouseDownSlot = (typeof ROOT_MOUSEDOWN_ORDER)[number];
