import type { ActionDefinition } from "../../application/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { scriptZoomActions as definitions } from "../../features/script-zoom/actions.ts";
import type { ScriptZoomPorts } from "../../features/script-zoom/ports.ts";
import { __init as mountScriptZoom } from "../../features/script-zoom/script-zoom.js";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const scriptZoom = owned<ReturnType<typeof mountScriptZoom>>();

export function mountScriptZoomFeature(): ReturnType<typeof mountScriptZoom> {
  return scriptZoom.replace(function () {
    const shared = sharedPorts();
    const ports: ScriptZoomPorts = {
      screen: shared.screen,
      actions: shared.actions,
      scale: {
        scriptScale: () => preferences().scriptScale(),
        setScriptScale: (scale) => preferences().setScriptScale(scale),
        clearScriptScale: () => preferences().clearScriptScale()
      },
      changes: shared.changes
    };
    return mountScriptZoom(ports);
  });
}

export const stopScriptZoomFeature = scriptZoom.stop;

export function scriptZoomActions(): ActionDefinition[] {
  return definitions(() => {
    const owner = scriptZoom.owner();
    return owner?.mounted() ? owner : null;
  });
}
