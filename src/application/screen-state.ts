import type { ScreenState } from "./screen.ts";
import type { ViewFlags } from "./preferences/view-flags.ts";

export interface ScreenStatePorts {
  readonly document: { readonly current: () => unknown };
  readonly flags: () => Pick<ViewFlags, "tourOpen" | "writerOpen" | "brollPageOpen">;
  readonly prompterOpen: () => boolean;
  readonly page: {
    readonly dialogShown: () => boolean;
    readonly launcherShown: () => boolean;
  };
}

export interface ScreenStateOwner {
  readonly screenNow: () => ScreenState;
  readonly askingFromLauncher: <T>(read: () => T) => T;
  readonly launcherShown: () => boolean;
}

export function createScreenState(ports: ScreenStatePorts): ScreenStateOwner {
  let launcherAsking = false;
  const launcherOpen = (): boolean => !launcherAsking && ports.page.launcherShown();
  return {
    screenNow: () => ({
      loading: !ports.document.current(),
      dialog: ports.page.dialogShown(),
      launcher: launcherOpen(),
      tour: ports.flags().tourOpen(),
      prompter: ports.prompterOpen(),
      writer: ports.flags().writerOpen(),
      shotlist: ports.flags().brollPageOpen()
    }),
    askingFromLauncher: <T>(read: () => T): T => {
      launcherAsking = true;
      try {
        return read();
      } finally {
        launcherAsking = false;
      }
    },
    launcherShown: () => ports.page.launcherShown()
  };
}
