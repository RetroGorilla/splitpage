import type { ActionRegistry, InvokeOutcome } from "../../application/actions.ts";
import { bindShortcuts } from "./bind-shortcuts.ts";

export interface ShortcutsMount {
  readonly target: EventTarget;
  readonly registry: ActionRegistry;
  readonly onOutcome?: (outcome: InvokeOutcome) => void;
}

export function mountShortcuts(mount: ShortcutsMount): () => void {
  let dispose: (() => void) | null = bindShortcuts(mount.target, mount.registry, mount.onOutcome ? { onOutcome: mount.onOutcome } : {});
  return () => {
    dispose?.();
    dispose = null;
  };
}
