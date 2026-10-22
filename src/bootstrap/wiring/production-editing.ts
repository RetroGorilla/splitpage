import type { DeleteTimerPort } from "../../application/editing/delete-confirm.ts";
import { startProductionEditing } from "../../legacy/production-editing-bridge.ts";

export function wireProductionEditing(timers: DeleteTimerPort): () => void {
  return startProductionEditing(timers);
}