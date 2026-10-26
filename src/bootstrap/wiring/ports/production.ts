import { deleteConfirmation, resetProductionPanelState } from "../../../legacy/production-editing-bridge.ts";
import type { ProductionIndexOwner } from "../../../core/production/index.ts";
import { productionIndex } from "../../../legacy/production-index-bridge.ts";

export const production: ProductionIndexOwner = {
  entries: (doc) => productionIndex().entries(doc),
  current: (doc) => productionIndex().current(doc),
  derived: () => productionIndex().derived(),
  resetDerived: () => { productionIndex().resetDerived(); },
  recordsPlan: (doc, viewed) => productionIndex().recordsPlan(doc, viewed)
};

export const deletion = {
  armedId: (...args: Parameters<ReturnType<typeof deleteConfirmation>["armedId"]>) => deleteConfirmation().armedId(...args),
  arm: (...args: Parameters<ReturnType<typeof deleteConfirmation>["arm"]>) => deleteConfirmation().arm(...args),
  disarm: (...args: Parameters<ReturnType<typeof deleteConfirmation>["disarm"]>) => deleteConfirmation().disarm(...args)
};

export function resetProductionPanel(): void {
  resetProductionPanelState();
}
