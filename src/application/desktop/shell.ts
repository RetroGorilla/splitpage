export interface DesktopOpenedFile {
  readonly id: string;
  readonly name: string;
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

export interface DesktopShell {
  readonly launchIntent?: { readonly type: string };
  readonly onOpenFile: (cb: (entry: DesktopOpenedFile) => void) => void;
  readonly onRestoreNotice: (cb: (notice: DesktopRestoreNotice) => void) => void;
  readonly onReassignDocId?: (cb: (msg: DesktopReassign | null) => void) => void;
  readonly onMenuCommand: (cb: (command: string) => void) => void;
  readonly onDraftFlush?: (cb: (request: { readonly keep: boolean }) => unknown) => void;
  readonly openPrompterInBrowser: () => Promise<DesktopAnswer | null>;
  readonly openPrompterInChromium: () => Promise<DesktopAnswer | null>;
}

export interface PrompterElsewhere {
  readonly ok: boolean;
  readonly message: string;
}

export interface DesktopHandOff {
  readonly openPrompterInBrowser: () => Promise<PrompterElsewhere>;
}
