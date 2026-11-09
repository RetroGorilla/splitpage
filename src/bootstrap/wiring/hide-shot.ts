import type { ActionDefinition } from "../../application/actions.ts";
import { runFromButton } from "./ports/actions.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { hideShotActions as definitions } from "../../features/rows/actions.ts";
import { createHideShot, mountHideShotSwitch } from "../../features/rows/hide-shot.ts";
import type { HideShotControls } from "../../features/rows/hide-shot.ts";
import { owned } from "../../features/routing/owned.ts";
import { viewFlags } from "./preferences-owner.ts";
import { shotHiding } from "./shot-hiding.ts";

type HideShotMount = HideShotControls & { readonly dispose: () => void };

const hideShot = owned<HideShotMount>();

export function mountHideShotFeature(): HideShotMount {
  return hideShot.replace(() => {
    const controls = createHideShot({
      shots: {
        on: () => shotHiding().on(),
        set: (on) => shotHiding().set(on),
        expand: (ids) => { shotHiding().expand(ids); },
        groups: (rows) => shotHiding().groups(rows)
      },
      notices: portNotices,
      switchButton: () => document.getElementById("hide-shot-toggle")
    });
    const unmount = mountHideShotSwitch(document.getElementById("hide-shot-toggle"), () => { runFromButton("toggle-hide-shot"); });
    return { ...controls, dispose: unmount };
  });
}

export const stopHideShotFeature = hideShot.stop;

export function updateHideShotSwitch(): void {
  hideShot.owner()?.updateSwitch();
}

export function expandHiddenShotStrip(idsAttr: string | null | undefined): void {
  hideShot.owner()?.expand(idsAttr);
}

export function hideShotActions(): ActionDefinition[] {
  return definitions({
    toggle: () => { hideShot.owner()?.toggle(); },
    hidden: () => viewFlags().hideShot(),
    screen: portScreen
  });
}

export function setHideShotBeats(on: boolean): void {
  hideShot.owner()?.set(on);
}

export const currentHideShot = hideShot.owner;
