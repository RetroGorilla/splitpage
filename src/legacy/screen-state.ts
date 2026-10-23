import { currentDocument } from "./session-bridge.ts";
import { prompterIsOpen } from "../application/prompter-state.ts";
import { brollPageOpen } from "../js/08d-broll-panel.js";
import { viewFlags } from "./preferences-bridge.ts";
import { dialogOpen, launcherOpen } from "./screen.ts";
import type { ScreenState } from "./screen.ts";
import { saveBusy } from "./save-bridge.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";

export function screenNow(): ScreenState {
  return {
    loading: !currentDocument(),
    dialog: dialogOpen(),
    launcher: launcherOpen(),
    tour: viewFlags().tourOpen(),
    prompter: prompterIsOpen(),
    writer: viewFlags().writerOpen(),
    shotlist: brollPageOpen()
  };
}

export function inDesktopApp(): boolean {
  return runningOnDesktop();
}

export function saveInProgress(): boolean {
  return saveBusy();
}
