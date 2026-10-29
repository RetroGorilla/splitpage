import type { ScreenState } from "../../../application/screen.ts";
import { screenStateOwner } from "../screen-state.ts";

export const screen = (): ScreenState => screenStateOwner().screenNow();

export function askingFromLauncher<T>(read: () => T): T {
  return screenStateOwner().askingFromLauncher(read);
}

export function launcherShown(): boolean {
  return screenStateOwner().launcherShown();
}
