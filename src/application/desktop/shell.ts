import type { DesktopIpcReceiveArgs, DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

export type DesktopOpenedFile = Pick<DesktopIpcReceiveArgs<"splitpage:open-file">[0], "id" | "name">;

export interface DesktopRestoreNotice {
  readonly skipped?: readonly { readonly name?: string; readonly reason?: string }[];
}

export interface DesktopReassign {
  readonly toId: string;
}

export type DesktopAnswer = DesktopIpcResult<"splitpage:prompter-open-in-browser">;

export interface DesktopShell {
  readonly launchIntent?: { readonly type: string };
  readonly onOpenFile: (cb: (entry: DesktopOpenedFile) => void) => void;
  readonly onRestoreNotice: (cb: (notice: DesktopRestoreNotice) => void) => void;
  readonly onReassignDocId?: (cb: (msg: DesktopReassign | null) => void) => void;
  readonly onMenuCommand: (cb: (command: string) => void) => void;
  readonly onDraftFlush?: (cb: (request: { readonly keep: boolean }) => unknown) => void;
  readonly openPrompterInBrowser: () => Promise<DesktopAnswer>;
  readonly openPrompterInChromium: () => Promise<DesktopIpcResult<"splitpage:prompter-open-in-chromium">>;
}

export interface PrompterElsewhere {
  readonly ok: boolean;
  readonly message: string;
}

export interface DesktopHandOff {
  readonly openPrompterInBrowser: () => Promise<PrompterElsewhere>;
}
