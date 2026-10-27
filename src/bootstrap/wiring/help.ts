import type { ActionDefinition } from "../../application/actions.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { actions as portActions } from "./ports/actions.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { helpActions as definitions } from "../../features/help/actions.ts";
import { startHelp as mountHelp } from "../../features/help/help.js";
import type { HelpMount, HelpPorts } from "../../features/help/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { sidePanels } from "../../legacy/panels-bridge.ts";
import { preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { inDesktopApp } from "../../legacy/screen-state.ts";
import { handTourPauseTo } from "../../legacy/tour-pause.ts";

const help = owned<HelpMount>();

export function mountHelpFeature(): HelpMount {
  return help.replace(() => {
    const ports: HelpPorts = {
      document: portDocument,
      actions: portActions,
      notices: portNotices,
      preferences: { tourFinished: () => preferences().tourFinished() },
      viewFlags: { setTourOpen: (open) => viewFlags().setTourOpen(open) },
      sidePanels: { closeAll: () => sidePanels().closeAll() }
    };
    const mounted: HelpMount = mountHelp(ports);
    handTourPauseTo(mounted.tour);
    return mounted;
  });
}

export const stopHelpFeature = help.stop;

export function helpActions(): ActionDefinition[] {
  return definitions(help.owner, { screen: portScreen, desktop: inDesktopApp });
}
