import { createExportRegistry } from "../application/export/registry.ts";
import { createAppActions, installAppActions } from "../legacy/app-actions.ts";
import { installExportFormats } from "../bootstrap/wiring/export-registry.ts";
import { startPageEffects } from "../bootstrap/effects.ts";
import { effectsStarted } from "../bootstrap/wiring/effects-owner.ts";
import { registerBuiltInExporters } from "../bootstrap/wiring/exporters.ts";

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
