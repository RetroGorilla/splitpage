import { owned } from "../../features/routing/owned.ts";
import type { Disposable } from "../../features/routing/owned.ts";
import { legacyDesktopDocumentPorts, startDesktopDocumentState } from "../../legacy/desktop-bridge.ts";
import { __init as initDesktopGlue } from "../../js/20f-desktop.js";

const desktop = owned<Disposable>();

export function mountDesktopFeature(): void {
  desktop.replace(() => {
    const stop = startDesktopDocumentState(legacyDesktopDocumentPorts());
    try {
      initDesktopGlue();
    } catch (error) {
      stop();
      throw error;
    }
    return { dispose: stop };
  });
}

export const stopDesktopFeature = desktop.stop;
