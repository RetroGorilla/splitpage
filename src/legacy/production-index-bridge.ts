import { createProductionIndex } from "../application/production/production-index.ts";
import type { Seal } from "../core/document/freeze.ts";
import type { ProductionIndexOwner } from "../core/production/index.ts";
import type { ProductionReaders } from "../core/production/ports.ts";

let started: ProductionIndexOwner | null = null;

export function startProductionIndex(readers: ProductionReaders, seal: Seal): () => void {
  if (started) throw new Error("The production index is already started; stop it first");
  const mine = createProductionIndex(readers, seal);
  started = mine;
  return () => {
    if (started !== mine) return;
    started = null;
  };
}

export function productionIndex(): ProductionIndexOwner {
  if (!started) throw new Error("The production index is not started yet");
  return started;
}