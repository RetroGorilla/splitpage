import { SIDE_PANEL_IDS } from "../../application/preferences/panel-widths.ts";
import { createSidePanels } from "../../features/panels/side-panels.ts";
import { startSidePanels } from "../../legacy/panels-bridge.ts";
import { panelWidths } from "../../legacy/preferences-bridge.ts";
import { holdScriptPlace, sidePanelOpening } from "../../js/03b-side-panels.js";
import { closeNewTabPage } from "../../js/20j-newtab.js";

const PANEL_BUTTONS: readonly (readonly [string, string])[] = [
  ["production-panel", "btn-production"],
  ["gear-panel", "btn-gear"],
  ["broll-panel", "btn-broll"],
  ["comments-panel", "btn-comments"]
];

let stopSidePanels: (() => void) | null = null;

export function mountSidePanelsFeature(): void {
  stopSidePanelsFeature();
  const panels = createSidePanels(document, {
    ids: SIDE_PANEL_IDS,
    buttons: PANEL_BUTTONS,
    readWidth: (id) => panelWidths().read(id),
    holdPlace: holdScriptPlace,
    opening: sidePanelOpening
  });
  const stops = [startSidePanels(panels), panels.registerPage("newtab-page", closeNewTabPage)];
  stopSidePanels = () => {
    while (stops.length) stops.pop()?.();
  };
}

export function stopSidePanelsFeature(): void {
  const stop = stopSidePanels;
  stopSidePanels = null;
  stop?.();
}
