import { dialogShown, launcherShown } from "../../adapters/page/overlays.ts";
import { prompterIsOpen } from "../../application/prompter-state.ts";
import { createScreenState } from "../../application/screen-state.ts";
import type { ScreenStateOwner, ScreenStatePorts } from "../../application/screen-state.ts";
import { documentReader } from "./ports/document.ts";
import { screenFlags } from "./ports/preferences.ts";

let started: ScreenStateOwner | null = null;

export function screenStateOwner(): ScreenStateOwner {
  if (!started) throw new Error("The screen state is not started yet");
  return started;
}

export function screenStatePorts(): ScreenStatePorts {
  return {
    document: documentReader,
    flags: screenFlags,
    prompterOpen: prompterIsOpen,
    page: { dialogShown, launcherShown }
  };
}

export function mountScreenStateOwner(ports: ScreenStatePorts = screenStatePorts()): ScreenStateOwner {
  const mine = createScreenState(ports);
  started = mine;
  return mine;
}

export function stopScreenStateOwner(): void {
  started = null;
}
