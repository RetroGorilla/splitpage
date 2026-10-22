import { startActions } from "./actions.ts";
import { beginStartup } from "./startup.ts";
import type { Wiring } from "./wiring.ts";
import { whenDocumentReady } from "./startup/dom-ready.ts";
import { mountBrollFeature, stopBrollFeature } from "../js/08d-broll-panel.js";
import {
  mountClipboardFeature,
  mountCompositionFeature,
  mountFocusFeature,
  mountMediaFeature,
  mountMergeBannerFeature,
  mountRowsEditingFeature,
  mountRowsFeature,
  mountTitlesFeature,
  mountToolbarFeature,
  mountUndoFeature,
  mountVideoFeature,
  mountWriterFeature,
  stopClipboardFeature,
  stopCompositionFeature,
  stopFocusFeature,
  stopMediaFeature,
  stopMergeBannerFeature,
  stopRowsEditingFeature,
  stopRowsFeature,
  stopTitlesFeature,
  stopToolbarFeature,
  stopUndoFeature,
  stopVideoFeature,
  stopWriterFeature
} from "./wiring/editor.ts";
import { mountFindFeature, mountTagsFeature, stopFindFeature, stopTagsFeature } from "./wiring/production.ts";
import { mountCommentsFeature, stopCommentsFeature } from "./wiring/comments.ts";
import {
  mountAppearanceFeature,
  mountConflictsFeature,
  mountDriveFeature,
  mountFileMenuFeature,
  mountGdocFeature,
  mountHistoryFeature,
  mountHistoryGalleryFeature,
  mountIdentityFeature,
  mountImportsFeature,
  mountNoticesFeature,
  mountPanelsFeature,
  mountPrompterFeature,
  mountPrompterOpenFeature,
  mountPrompterVisibilityFeature,
  mountSaveFeature,
  mountSaveRecoveryFeature,
  mountServerFeature,
  mountWriterCloseFeature,
  mountWriterNavigationFeature,
  mountWriterOpenFeature,
  stopViewFeature
} from "./wiring/views.ts";
import { mountOverlayFeature, stopOverlayFeature } from "./wiring/overlay.ts";
import { openInitialDocument, startupPorts } from "./wiring/startup.ts";

let running: (() => void) | null = null;

function view(key: string, mount: () => unknown): [() => unknown, () => void] {
  return [mount, () => stopViewFeature(key)];
}

let appearanceMountedEarly = false;

function stopAppearance(): void {
  stopViewFeature("mountAppearance");
}

export function startApp(wiring: Wiring): () => void {
  if (running) throw new Error("the app is already started; stop it first");
  const stops: (() => void)[] = [wiring.dispose];
  const stopAll = (): unknown[] => {
    const failures: unknown[] = [];
    while (stops.length) {
      try {
        stops.pop()?.();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };
  const run = ([mount, stop]: [() => unknown, () => void]): void => {
    stops.push(stop);
    mount();
  };
  try {
    const appearance = appearanceMountedEarly;
    appearanceMountedEarly = false;
    if (appearance) stops.push(stopAppearance);
    stops.push(startActions(wiring.actions, wiring.keyTarget));
    const startup = beginStartup(startupPorts());
    stops.push(startup.dispose);
    if (!appearance) run([mountAppearanceFeature, stopAppearance]);
    run(view("mountNotices", mountNoticesFeature));
    run([mountTagsFeature, stopTagsFeature]);
    run(view("mountPrompterVisibility", mountPrompterVisibilityFeature));
    stops.push(openInitialDocument(startup));
    const comments = mountCommentsFeature();
    stops.push(stopCommentsFeature);
    run([mountVideoFeature, stopVideoFeature]);
    run([mountToolbarFeature, stopToolbarFeature]);
    const overlay = mountOverlayFeature();
    stops.push(stopOverlayFeature);
    run([mountRowsFeature, stopRowsFeature]);
    run([mountRowsEditingFeature, stopRowsEditingFeature]);
    run(view("mountIdentity", mountIdentityFeature));
    run([mountFindFeature, stopFindFeature]);
    run(view("mountHistoryGallery", mountHistoryGalleryFeature));
    run(view("mountHistory", mountHistoryFeature));
    overlay.mountToolbar();
    run([mountBrollFeature, stopBrollFeature]);
    run(view("mountServer", mountServerFeature));
    run(view("mountDrive", mountDriveFeature));
    run(view("mountSaveRecovery", mountSaveRecoveryFeature));
    run([mountMergeBannerFeature, stopMergeBannerFeature]);
    run(view("mountConflicts", mountConflictsFeature));
    comments.mountRoots();
    run(view("mountPanels", mountPanelsFeature));
    comments.mountControls();
    overlay.mountCommentsEscape();
    run([mountMediaFeature, stopMediaFeature]);
    run([mountTitlesFeature, stopTitlesFeature]);
    run(view("mountSave", mountSaveFeature));
    run(view("mountPrompterOpen", mountPrompterOpenFeature));
    run(view("mountFileMenu", mountFileMenuFeature));
    run(view("mountImports", mountImportsFeature));
    run(view("mountGdoc", mountGdocFeature));
    run(view("mountPrompter", mountPrompterFeature));
    run(view("mountWriterOpen", mountWriterOpenFeature));
    run([mountUndoFeature, stopUndoFeature]);
    run([mountClipboardFeature, stopClipboardFeature]);
    run([mountFocusFeature, stopFocusFeature]);
    run([mountCompositionFeature, stopCompositionFeature]);
    run([mountWriterFeature, stopWriterFeature]);
    run(view("mountWriterNavigation", mountWriterNavigationFeature));
    overlay.mountWriterBar();
    run(view("mountWriterClose", mountWriterCloseFeature));
    overlay.mountWriterFocus();
    startup.finish();
  } catch (error) {
    const failures = stopAll();
    if (failures.length) throw new AggregateError([error, ...failures], "the app failed to start, and stopping what had started also failed", { cause: error });
    throw error;
  }
  const stop = (): void => {
    let failures: unknown[];
    try {
      failures = stopAll();
    } finally {
      if (running === stop) running = null;
    }
    if (failures.length) throw new AggregateError(failures, `${failures.length} of the app's cleanup steps failed; the rest still ran`);
  };
  running = stop;
  return stop;
}

let cancelReady: (() => void) | null = null;

export function stopApp(): void {
  const cancel = cancelReady;
  cancelReady = null;
  cancel?.();
  running?.();
}

export function startAppWhenReady(doc: Document, wiring: Wiring): void {
  if (running || cancelReady) throw new Error("the app is already started or waiting to start; stop it first");
  mountAppearanceFeature();
  appearanceMountedEarly = true;
  let started = false;
  const cancel = whenDocumentReady(doc, () => {
    started = true;
    cancelReady = null;
    startApp(wiring);
  });
  if (!started) {
    cancelReady = () => {
      try {
        cancel();
      } finally {
        appearanceMountedEarly = false;
        try {
          stopAppearance();
        } finally {
          wiring.dispose();
        }
      }
    };
  }
}
