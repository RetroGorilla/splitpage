import { createExportRegistry } from "../application/export/registry.ts";
import { createAppActions, installAppActions } from "../legacy/app-actions.ts";
import { installExportFormats } from "../legacy/export-formats.ts";
import { startPageEffects } from "../bootstrap/effects.ts";
import { effectsStarted } from "../legacy/effects-bridge.ts";
import { registerBuiltInExporters } from "../js/14e-export-formats.js";

export function wireRegistries() {
  if (!effectsStarted()) startPageEffects(window);
  const actions = createAppActions();
  const exports = createExportRegistry();
  const drops = [installAppActions(actions), installExportFormats(exports), registerBuiltInExporters(exports)];
  return {
    actions,
    exports,
    dispose() {
      while (drops.length) drops.pop()();
    }
  };
}
