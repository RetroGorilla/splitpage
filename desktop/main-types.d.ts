import type * as Electron from "electron";
import type { DesktopWireLaunch } from "../shared/desktop-contract.d.ts";

export interface DesktopLookupMap<K, V> extends Map<K, V> {
  get: (key: unknown) => V | undefined;
  has: (key: unknown) => boolean;
  delete: (key: unknown) => boolean;
}

export interface DesktopMainTab {
  id: string;
  windowId: string;
  title: string;
  dirty: boolean;
  pristine: boolean;
  docId: string | null;
  fileId: string | null | undefined;
  source: { kind: "file"; absPath: unknown } | { kind: "blank" };
  ready: boolean;
  webContentsId: number;
  reloadTimes: number[];
  keepDraftOnClose?: boolean;
  keepHolders?: Set<object>;
  crashedNotReloaded?: boolean;
  closeKeepingDraft?: boolean;
  pendingPayload: { kind: "open-file"; absPath: unknown } | null;
  launchIntent: DesktopWireLaunch;
  firstTabOfLaunch?: boolean;
  view: Electron.WebContentsView;
}

export interface DesktopMainWindow {
  id: string;
  win: Electron.BrowserWindow;
  activeTabId: string | null;
  tabIds: string[];
  lastFocusedAt: number;
  boundsSaveTimer: ReturnType<typeof setTimeout> | null;
  bounds: Electron.Rectangle | null;
  maximized: boolean;
  closeKeepingDrafts?: boolean;
}

