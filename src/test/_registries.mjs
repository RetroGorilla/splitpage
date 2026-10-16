import { createExportRegistry } from "../application/export/registry.ts";
import { createAppActions, installAppActions } from "../legacy/app-actions.ts";
import { installExportFormats } from "../legacy/export-formats.ts";
import { registerBuiltInExporters } from "../js/14e-export-formats.js";

export function wireRegistries() {
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
