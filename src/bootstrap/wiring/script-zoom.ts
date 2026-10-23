import type { ActionDefinition, ActionRegistry, ActionSource, Availability } from "../../application/actions.ts";
import { registerAll } from "../../application/actions.ts";
import { prompterIsOpen } from "../../application/prompter-state.ts";
import { owned } from "../../features/routing/owned.ts";
import type { ScriptZoomPorts } from "../../features/script-zoom/ports.ts";
import { __init as mountScriptZoom, resetScriptScale, scriptViewActive, stepScriptScale } from "../../features/script-zoom/script-zoom.js";
import { appActions } from "../../legacy/app-actions.ts";
import { PREF_EVENT, preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { currentDocument } from "../../legacy/session-bridge.ts";

export { scriptScale, setScriptScale } from "../../features/script-zoom/script-zoom.js";

const scriptZoom = owned<ReturnType<typeof mountScriptZoom>>();

export function mountScriptZoomFeature(): ReturnType<typeof mountScriptZoom> {
  return scriptZoom.replace(function () {
    const ports: ScriptZoomPorts = {
      currentDocument: currentDocument,
      prompterIsOpen: prompterIsOpen,
      runAction: (id, source) => appActions.invoke(id, source),
      scriptScale: () => preferences().scriptScale(),
      setScriptScale: (scale) => preferences().setScriptScale(scale),
      clearScriptScale: () => preferences().clearScriptScale(),
      isScriptScaleKey: (key) => key !== null && preferences().nameOf(key) === "scriptScale",
      preferenceEvent: PREF_EVENT,
      writerOpen: () => viewFlags().writerOpen(),
      hideShot: () => viewFlags().hideShot()
    };
    return mountScriptZoom(ports);
  });
}

export const stopScriptZoomFeature = scriptZoom.stop;

export function __init(): void {
  mountScriptZoomFeature();
}

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
  return registerAll(registry, definitions);
}
