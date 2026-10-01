import type { ActionRegistry, InvokeOutcome } from "../../application/actions.ts";
import type { KeyInput } from "../../application/shortcuts.ts";
import { actionForKey, canBeShortcut } from "../../application/shortcuts.ts";

export interface ShortcutBindingOptions {
  readonly onOutcome?: (outcome: InvokeOutcome) => void;
}

export function bindShortcuts(target: EventTarget, registry: ActionRegistry, options: ShortcutBindingOptions = {}): () => void {
  const onKeyDown = (event: Event): void => {
    if (event.defaultPrevented) return;
    const input = event as unknown as KeyInput;
    if (!canBeShortcut(input)) return;
    const action = actionForKey(registry.shortcuts(), input);
    if (action === null) return;
    const outcome = registry.invoke(action.id, "shortcut");
    if (outcome.kind === "ran" || outcome.kind === "failed" || action.claim) event.preventDefault();
    options.onOutcome?.(outcome);
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
