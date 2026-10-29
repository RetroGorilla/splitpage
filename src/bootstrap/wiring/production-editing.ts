import type { DeleteTimerPort } from "../../application/editing/delete-confirm.ts";
import { startProductionEditing } from "./production-editing-owners.ts";

export function wireProductionEditing(timers: DeleteTimerPort): () => void {
  return startProductionEditing(timers);
}