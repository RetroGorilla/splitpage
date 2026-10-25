import { askingFromLauncher as readFromLauncher, launcherShown as isLauncherShown } from "../../../legacy/screen.ts";
import type { ScreenState } from "../../../application/screen.ts";
import { screenNow } from "../../../legacy/screen-state.ts";

export const screen = (): ScreenState => screenNow();

export function askingFromLauncher<T>(read: () => T): T {
  return readFromLauncher(read);
}

export function launcherShown(): boolean {
  return isLauncherShown();
}
