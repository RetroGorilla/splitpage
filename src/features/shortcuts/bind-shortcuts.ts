import type { ActionRegistry, InvokeOutcome } from "../../application/actions.ts";
import type { KeyInput } from "../../application/shortcuts.ts";
import { actionForKey } from "../../application/shortcuts.ts";

export interface ShortcutBindingOptions {
  readonly onOutcome?: (outcome: InvokeOutcome) => void;
}

export function bindShortcuts(target: EventTarget, registry: ActionRegistry, options: ShortcutBindingOptions = {}): () => void {
  const onKeyDown = (event: Event): void => {
    if (event.defaultPrevented) return;
    const id = actionForKey(registry.shortcuts(), event as unknown as KeyInput);
    if (id === null) return;
    const outcome = registry.invoke(id, "shortcut");
    if (outcome.kind === "ran") event.preventDefault();
    options.onOutcome?.(outcome);
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
