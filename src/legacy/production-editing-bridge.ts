import { resetTagPanel } from "../application/tag-panel-state.ts";
import { createDeleteConfirm } from "../application/editing/delete-confirm.ts";
import type { DeleteConfirm, DeleteTimerPort } from "../application/editing/delete-confirm.ts";
import { createProductionSelection } from "../application/editing/production-selection.ts";
import type { ProductionSelection } from "../application/editing/production-selection.ts";

interface Started {
  readonly confirmation: DeleteConfirm;
  readonly selection: ProductionSelection;
}

let started: Started | null = null;

function running(): Started {
  if (!started) throw new Error("The production editing owners are not started yet");
  return started;
}

export function startProductionEditing(timers: DeleteTimerPort): () => void {
  if (started) throw new Error("The production editing owners are already started; stop them first");
  const mine: Started = {
    confirmation: createDeleteConfirm(timers),
    selection: createProductionSelection(timers)
  };
  started = mine;
  return () => {
    if (started !== mine) return;
    started = null;
    try {
      mine.confirmation.dispose();
    } finally {
      mine.selection.clear();
    }
  };
}

export function productionEditingStarted(): boolean {
  return started !== null;
}

export function deleteConfirmation(): DeleteConfirm {
  return running().confirmation;
}

export function productionSelection(): ProductionSelection {
  return running().selection;
}

export function selectedKeys(): string[] {
  return productionSelection().selectedKeys();
}

export function bulkDeleteArmed(): boolean {
  return productionSelection().armed();
}

export function disarmBulkDelete(): void {
  productionSelection().disarm();
}

export function clearProductionSelection(): void {
  productionSelection().clear();
}

export function pruneProductionSelection(entries: readonly { readonly key: string }[]): void {
  productionSelection().prune(entries);
}
export function resetProductionPanelState(): void {
  resetTagPanel();
  deleteConfirmation().disarm("tag");
  clearProductionSelection();
}