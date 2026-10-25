export interface DesktopOpenedFile {
  readonly id: string;
  readonly name: string;
}

export interface DesktopServerDoc {
  readonly serverDocId?: string;
  readonly serverUrl?: unknown;
  readonly token?: unknown;
  readonly tunnel?: unknown;
}

export interface DesktopRestoreNotice {
  readonly skipped?: readonly { readonly name?: string; readonly reason?: string }[];
}

export interface DesktopReassign {
  readonly toId: string;
}

export interface DesktopAnswer {
  readonly ok?: boolean;
  readonly code?: string;
  readonly [key: string]: unknown;
}

export interface DesktopServerRoute {
  readonly kind: "server";
  readonly serverDocId: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly tunnel: unknown;
}

export interface DesktopShell {
  readonly launchIntent?: { readonly type: string };
  readonly onOpenFile: (cb: (entry: DesktopOpenedFile) => void) => void;
  readonly onOpenServerDoc: (cb: (payload: DesktopServerDoc) => void) => void;
  readonly onRestoreNotice: (cb: (notice: DesktopRestoreNotice) => void) => void;
  readonly onReassignDocId?: (cb: (msg: DesktopReassign | null) => void) => void;
  readonly onMenuCommand: (cb: (command: string) => void) => void;
  readonly onDraftFlush?: (cb: (request: { readonly keep: boolean }) => unknown) => void;
  readonly getSessionInfo: () => Promise<{ readonly hosting?: boolean; readonly [key: string]: unknown } | null>;
  readonly openPrompterInBrowser: () => Promise<DesktopAnswer | null>;
  readonly openPrompterInChromium: () => Promise<DesktopAnswer | null>;
  readonly routeOpen: (request: DesktopServerRoute) => Promise<{ readonly where?: string } | null>;
}

export interface PrompterElsewhere {
  readonly ok: boolean;
  readonly message: string;
}

export interface DesktopHandOff {
  readonly renderShareInfo: () => Promise<void>;
  readonly openPrompterInBrowser: () => Promise<PrompterElsewhere>;
}
