import type { ActionDefinition, ActionSource, Availability } from "../../application/actions.ts";

export interface ScriptZoomControls {
  readonly scriptViewActive: () => boolean;
  readonly stepScriptScale: (direction: number) => void;
  readonly resetScriptScale: () => void;
}

export function scriptZoomActions(current: () => ScriptZoomControls | null): ActionDefinition[] {
  const availability = (source: ActionSource): Availability => {
    const zoom = current();
    return { enabled: zoom !== null && (source !== "shortcut" || zoom.scriptViewActive()), visible: false };
  };
  const zoom = (id: string, label: string, run: (owner: ScriptZoomControls) => void): ActionDefinition => ({
    id, label, group: "View", icon: "i-search", words: "zoom script size bigger smaller text", availability,
    run: () => {
      const owner = current();
      if (owner) run(owner);
    }
  });
  return [
    zoom("script-zoom-in", "Zoom the script in", (owner) => { owner.stepScriptScale(1); }),
    zoom("script-zoom-out", "Zoom the script out", (owner) => { owner.stepScriptScale(-1); }),
    zoom("script-zoom-reset", "Script at actual size", (owner) => { owner.resetScriptScale(); })
  ];
}
