import { tagComposerActions } from "./wiring/production-tags.ts";
import { prompterActions } from "./wiring/prompter.ts";
import { importActions } from "./wiring/imports.ts";
import { commandMenuActions } from "./wiring/command-menu.ts";
import { tagPanelActions } from "./wiring/production.ts";
import { appDataActions } from "./wiring/settings.ts";
import { brollPanelActions } from "./wiring/broll.ts";
import { onboardingActions } from "./wiring/onboarding.ts";
import { commentsPanelActions, commentsHelpActions, commentsOpenActions } from "./wiring/comments.ts";
import type { ActionRegistry, ActionSource, Refusal } from "../application/actions.ts";
import { registerAll } from "../application/actions.ts";
import { mountShortcuts } from "../features/shortcuts/mount.ts";
import { showRefusal } from "./wiring/save-status.ts";
import { runMenuCommandsWith } from "../application/desktop/menu-commands.ts";
import { editorOpenActions } from "../legacy/editor-open-actions.ts";
import { videoFiles } from "./wiring/video-files.ts";
import { fileMenuActions } from "./wiring/file-menu.ts";
import { toggleFileMenu } from "./wiring/file-menu-controls.ts";
import { helpMenuActions } from "../legacy/help-actions.ts";
import { nativeMenuRunner } from "../legacy/native-menu.ts";
import { shareActions } from "../legacy/share-actions.ts";
import { historyActions } from "./wiring/history-panel.ts";
import { targetActions } from "./wiring/title-chrome.ts";
import { writerActions } from "../bootstrap/wiring/writer.ts";
import { rowsActions } from "./wiring/editor.ts";
import { rundownMinimizeActions, rundownSceneActions } from "./wiring/rundown.ts";
import { scriptZoomActions } from "./wiring/script-zoom.ts";
import { helpActions } from "./wiring/help.ts";
import { updateActions } from "./wiring/update.ts";
import { galleryActions } from "./wiring/gallery.ts";
import { findActions } from "./wiring/find.ts";
import { fileMenuExportActions } from "./wiring/file-menu-export.ts";
import { hideShotActions } from "./wiring/hide-shot.ts";
import { desktopActions } from "./wiring/desktop.ts";

let running: (() => void) | null = null;

export function presentRefusal(refusal: Refusal, source: ActionSource): void {
  if (source !== "shortcut") showRefusal(refusal);
}

export function startActions(registry: ActionRegistry, keyTarget: EventTarget): () => void {
  if (running) throw new Error("the actions are already started; stop them first");
  const steps: readonly (() => () => void)[] = [
    () => registry.presentRefusals(presentRefusal),
    () => registerAll(registry, [...hideShotActions(), ...rundownMinimizeActions(), ...historyActions(), ...findActions()]),
    () => {
      const menu = fileMenuActions();
      return registerAll(registry, [...menu.slice(0, 3), ...fileMenuExportActions().slice(0, 1), ...commandMenuActions(), ...menu.slice(3, 4)]);
    },
    () => {
      const views = writerActions();
      return registerAll(registry, [...tagPanelActions(), ...brollPanelActions(), ...commentsPanelActions(), ...views, ...prompterActions()]);
    },
    () => {
      const menu = helpMenuActions();
      return registerAll(registry, [...menu, ...helpActions(), ...fileMenuActions().slice(6), ...onboardingActions(), ...updateActions(), ...commentsHelpActions(), ...appDataActions()]);
    },
    () => {
      const share = shareActions();
      const file = fileMenuActions();
      return registerAll(registry, [...share.slice(0, 2), ...file.slice(4, 5), ...share.slice(2, 3), ...file.slice(5, 6), ...importActions(), ...share.slice(3, 7), ...fileMenuExportActions().slice(1), ...targetActions(), ...desktopActions()]);
    },
    () => registerAll(registry, scriptZoomActions()),
    () => {
      const openers = editorOpenActions(videoFiles.openGallery);
      return registerAll(registry, [...rundownSceneActions(), ...galleryActions(), ...openers.slice(0, 1), ...commentsOpenActions(), ...tagComposerActions()]);
    },
    () => registerAll(registry, rowsActions()),
    () => runMenuCommandsWith(nativeMenuRunner(registry, presentRefusal, () => { toggleFileMenu(false); })),
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
