import type { ActionRegistry } from "../application/actions.ts";
import { mountShortcuts } from "../features/shortcuts/mount.ts";
import { registerFileActions } from "../legacy/file-actions.ts";
import { registerHelpActions } from "../legacy/help-actions.ts";
import { registerShareActions } from "../legacy/share-actions.ts";
import { registerThisDocumentActions } from "../legacy/this-document-actions.ts";
import { registerViewActions } from "../legacy/view-actions.ts";
import { registerZoomActions } from "../legacy/zoom-actions.ts";

let running: (() => void) | null = null;

export function startActions(registry: ActionRegistry, keyTarget: EventTarget): () => void {
  if (running) throw new Error("the actions are already started; stop them first");
  const disposers = [
    registerThisDocumentActions(registry),
    registerFileActions(registry),
    registerViewActions(registry),
    registerHelpActions(registry),
    registerShareActions(registry),
    registerZoomActions(registry),
    mountShortcuts({ target: keyTarget, registry })
  ];
  const stop = (): void => {
    while (disposers.length) disposers.pop()?.();
    if (running === stop) running = null;
  };
  running = stop;
  return stop;
}

export function stopActions(): void {
  running?.();
}
