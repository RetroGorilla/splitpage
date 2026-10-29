import type { ActionDefinition } from "../../application/actions.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { actions as portActions } from "./ports/actions.ts";
import { changes as portChanges } from "./ports/preferences.ts";
import { owned } from "../../features/routing/owned.ts";
import { scriptZoomActions as definitions } from "../../features/script-zoom/actions.ts";
import type { ScriptZoomPorts } from "../../features/script-zoom/ports.ts";
import { startScriptZoom as mountScriptZoom } from "../../features/script-zoom/script-zoom.ts";
import { preferences } from "../../legacy/preferences-bridge.ts";

const scriptZoom = owned<ReturnType<typeof mountScriptZoom>>();

export function mountScriptZoomFeature(): ReturnType<typeof mountScriptZoom> {
  return scriptZoom.replace(function () {
    const ports: ScriptZoomPorts = {
      screen: portScreen,
      actions: portActions,
      scale: {
        scriptScale: () => preferences().scriptScale(),
        setScriptScale: (scale) => preferences().setScriptScale(scale),
        clearScriptScale: () => preferences().clearScriptScale()
      },
      changes: portChanges
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
