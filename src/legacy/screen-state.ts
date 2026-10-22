import { S } from "../js/_state.js";
import { prompterIsOpen } from "../application/prompter-state.ts";
import { brollPageOpen } from "../js/08d-broll-panel.js";
import { viewFlags } from "./preferences-bridge.ts";
import { tourShowing } from "../js/20c-help.js";
import { dialogOpen, launcherOpen } from "./screen.ts";
import type { ScreenState } from "./screen.ts";
import { saveBusy } from "./save-bridge.ts";

export function screenNow(): ScreenState {
  return {
    loading: !S.state,
    dialog: dialogOpen(),
    launcher: launcherOpen(),
    tour: tourShowing(),
    prompter: prompterIsOpen(),
    writer: viewFlags().writerOpen(),
    shotlist: brollPageOpen()
  };
}

export function inDesktopApp(): boolean {
  return Boolean(S.DESKTOP);
}

export function saveInProgress(): boolean {
  return saveBusy();
}
