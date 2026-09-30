import type { ActionDefinition, ActionRegistry, ActionSource, Availability } from "../application/actions.ts";
import { resetScriptScale, scriptViewActive, stepScriptScale } from "../js/05s-script-zoom.js";

function zoomAvailability(source: ActionSource): Availability {
  return source !== "shortcut" || scriptViewActive() ? { enabled: true, visible: false } : { enabled: false, visible: false };
}

function zoom(id: string, label: string, run: () => void): ActionDefinition {
  return { id, label, group: "View", icon: "i-search", words: "zoom script size bigger smaller text", availability: zoomAvailability, run };
}

export function registerZoomActions(registry: ActionRegistry): () => void {
  const definitions: ActionDefinition[] = [
    zoom("script-zoom-in", "Zoom the script in", () => { stepScriptScale(1); }),
    zoom("script-zoom-out", "Zoom the script out", () => { stepScriptScale(-1); }),
    zoom("script-zoom-reset", "Script at actual size", () => { resetScriptScale(); })
  ];
  const disposers = definitions.map((d) => registry.register(d));
  return () => { for (const dispose of disposers) dispose(); };
}
