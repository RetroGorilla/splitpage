import { commentsPanelActions, commentsHelpActions, commentsOpenActions } from "./wiring/comments.ts";
import type { ActionRegistry, ActionSource, Refusal } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { mountShortcuts } from "../features/shortcuts/mount.ts";
import { showRefusal } from "../js/12-dirty-toast.js";
import { runMenuCommandsWith } from "../js/20f-desktop.js";
import { editorOpenActions } from "../legacy/editor-open-actions.ts";
import { registerFileActions } from "../legacy/file-actions.ts";
import { helpMenuActions } from "../legacy/help-actions.ts";
import { nativeMenuRunner } from "../legacy/native-menu.ts";
import { registerShareActions } from "../legacy/share-actions.ts";
import { hideShotActions, thisDocumentActions } from "../legacy/this-document-actions.ts";
import { viewActions } from "../legacy/view-actions.ts";
import { rowsActions } from "./wiring/editor.ts";
import { rundownMinimizeActions, rundownSceneActions } from "./wiring/rundown.ts";
import { scriptZoomActions } from "./wiring/script-zoom.ts";
import { helpActions } from "./wiring/help.ts";
import { galleryActions } from "./wiring/gallery.ts";

let running: (() => void) | null = null;

export function presentRefusal(refusal: Refusal, source: ActionSource): void {
  if (source !== "shortcut") showRefusal(refusal);
}

export function startActions(registry: ActionRegistry, keyTarget: EventTarget): () => void {
  if (running) throw new Error("the actions are already started; stop them first");
  const steps: readonly (() => () => void)[] = [
    () => registry.presentRefusals(presentRefusal),
    () => registerAll(registry, [...hideShotActions(), ...rundownMinimizeActions(), ...thisDocumentActions()]),
    () => registerFileActions(registry),
    () => {
      const views = viewActions();
      return registerAll(registry, [...views.slice(0, 3), ...commentsPanelActions(), ...views.slice(3)]);
    },
    () => {
      const menu = helpMenuActions();
      return registerAll(registry, [...menu.slice(0, 3), ...helpActions(), ...menu.slice(3, 6), ...commentsHelpActions(), ...menu.slice(6)]);
    },
    () => registerShareActions(registry),
    () => registerAll(registry, scriptZoomActions()),
    () => {
      const openers = editorOpenActions();
      return registerAll(registry, [...rundownSceneActions(), ...galleryActions(), ...openers.slice(0, 1), ...commentsOpenActions(), ...openers.slice(1)]);
    },
    () => registerAll(registry, rowsActions()),
    () => runMenuCommandsWith(nativeMenuRunner(registry, presentRefusal)),
    () => mountShortcuts({ target: keyTarget, registry })
  ];
  const disposers: (() => void)[] = [];
  const undo = (): void => {
    while (disposers.length) disposers.pop()?.();
  };
  try {
    for (const step of steps) disposers.push(step());
  } catch (error) {
    undo();
    throw error;
  }
  const stop = (): void => {
    undo();
    if (running === stop) running = null;
  };
  running = stop;
  return stop;
}

export function stopActions(): void {
  running?.();
}
