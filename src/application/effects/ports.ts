export type NoticeKind = "" | "ok" | "warn" | "error";

export interface Notice {
  readonly isConnected: boolean;
  readonly dismiss: () => void;
  readonly removeEventListener: (type: "click", listener: () => void) => void;
}

export interface NoticePort {
  readonly show: (message: string, kind?: NoticeKind, sticky?: boolean) => Notice;
  readonly showAction: (message: string, kind: NoticeKind | undefined, label: string, onAction: () => void, sticky?: boolean) => Notice;
}

export interface MenuItemPort<Item> {
  readonly setLabel: (item: Item | null | undefined, text: string) => void;
  readonly setReason: (item: Item | null | undefined, reason: string) => void;
}

export interface ClipboardPort {
  readonly copyText: (text: string) => Promise<boolean>;
}

export interface EffectPorts<Item> {
  readonly notices: NoticePort;
  readonly menuItems: MenuItemPort<Item>;
  readonly clipboard: ClipboardPort;
}
