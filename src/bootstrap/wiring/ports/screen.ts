import { dialogShown, launcherShown as launcherBackdropShown } from "../../../adapters/page/overlays.ts";
import { prompterIsOpen } from "../../../application/prompter-state.ts";
import type { ScreenState } from "../../../application/screen.ts";
import { createScreenState } from "../../../application/screen-state.ts";
import { documentReader } from "./document.ts";
import { screenFlags } from "./preferences.ts";

const screenState = createScreenState({
  document: documentReader,
  flags: screenFlags,
  prompterOpen: prompterIsOpen,
  page: { dialogShown, launcherShown: launcherBackdropShown }
});

export const screen = (): ScreenState => screenState.screenNow();

export function askingFromLauncher<T>(read: () => T): T {
  return screenState.askingFromLauncher(read);
}

export function launcherShown(): boolean {
  return screenState.launcherShown();
}
