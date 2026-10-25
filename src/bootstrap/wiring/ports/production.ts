import { deleteConfirmation } from "../../../legacy/production-editing-bridge.ts";
import type { ProductionIndexOwner } from "../../../core/production/index.ts";
import { productionIndex } from "../../../legacy/production-index-bridge.ts";
import type { TagPanelState } from "../../../application/tag-panel-state.ts";
import * as tagPanelStateOwner from "../../../application/tag-panel-state.ts";

export const tagPanelState: TagPanelState = {
  tagRenamingKey: () => tagPanelStateOwner.tagRenamingKey(),
  setTagRenaming: (key) => { tagPanelStateOwner.setTagRenaming(key); },
  tagExpandedKey: () => tagPanelStateOwner.tagExpandedKey(),
  setTagExpanded: (key) => { tagPanelStateOwner.setTagExpanded(key); },
  tagAddingPersonKey: () => tagPanelStateOwner.tagAddingPersonKey(),
  setTagAddingPerson: (key) => { tagPanelStateOwner.setTagAddingPerson(key); },
  productionGroupBy: () => tagPanelStateOwner.productionGroupBy(),
  setProductionGroupBy: (group) => { tagPanelStateOwner.setProductionGroupBy(group); },
  gearGroupBy: () => tagPanelStateOwner.gearGroupBy(),
  setGearGroupBy: (group) => { tagPanelStateOwner.setGearGroupBy(group); },
  resetTagPanel: () => { tagPanelStateOwner.resetTagPanel(); }
};

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
