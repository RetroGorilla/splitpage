import type { ActionDefinition } from "../../application/actions.ts";
import { hideShotActions as definitions } from "../../features/rows/actions.ts";
import { createHideShot } from "../../features/rows/hide-shot.ts";
import type { HideShotControls } from "../../features/rows/hide-shot.ts";
import { owned } from "../../features/routing/owned.ts";
import { handHideShotTo } from "../../legacy/hide-shot-bridge.ts";
import { viewFlags } from "../../legacy/preferences-bridge.ts";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

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
      notices: sharedPorts().notices,
      menuItem: () => document.getElementById("menu-hide-shot")
    });
    handHideShotTo(controls);
    return { ...controls, dispose: () => { handHideShotTo(null); } };
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
    screen: sharedPorts().screen
  });
}
