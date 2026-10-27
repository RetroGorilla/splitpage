import type { ActionDefinition } from "../../application/actions.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { hideShotActions as definitions } from "../../features/rows/actions.ts";
import { createHideShot } from "../../features/rows/hide-shot.ts";
import type { HideShotControls } from "../../features/rows/hide-shot.ts";
import { owned } from "../../features/routing/owned.ts";
import { viewFlags } from "../../legacy/preferences-bridge.ts";
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
      menuItem: () => document.getElementById("menu-hide-shot")
    });
    return { ...controls, dispose: () => {} };
  });
}

export const stopHideShotFeature = hideShot.stop;

export function updateHideShotMenu(): void {
  hideShot.owner()?.updateMenu();
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

export function setHideShotScenes(on: boolean): void {
  hideShot.owner()?.set(on);
}

export const currentHideShot = hideShot.owner;
