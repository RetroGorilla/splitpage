import type { ActionDefinition, Availability } from "../../application/actions.ts";
import { availableUnless, firstRefusal } from "../../application/screen.ts";
import type { Blocker } from "../../application/screen.ts";
import type { DesktopActionPorts, DesktopMount } from "./ports.ts";

const NO_DIALOG: readonly Blocker[] = ["loading", "dialog", "launcher"];

export function desktopActions(current: () => DesktopMount | null, ports: DesktopActionPorts): ActionDefinition[] {
  const shownWhen = (shown: boolean): Availability => (shown ? { enabled: true } : { enabled: true, visible: false });
  const loaded = (own: Availability): Availability => firstRefusal(availableUnless(NO_DIALOG, ports.screen()), own);
  return [
    {
      id: "prompter-open-in-browser",
      label: "Present in browser…",
      group: "This document",
      icon: "i-present",
      keys: () => (ports.running() ? ["mod+shift+p"] : []),
      bindKeys: () => false,
      words: "teleprompter browser follow my voice present speech recognition chrome edge",
      availability: () => current() ? loaded(shownWhen(ports.canOpenPrompterInBrowser())) : { enabled: false },
      run: async () => { await current()?.openPrompterInBrowser(); }
    }
  ];
}
