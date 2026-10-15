import type { CommentsMount } from "../features/comments/mount.ts";
import type { OverlayMount } from "../features/overlay/mount.ts";
import { beginStartup } from "./startup.ts";
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
} from "../js/22a-editor-wiring.js";
import { mountFindFeature, mountTagsFeature, stopFindFeature, stopTagsFeature } from "../js/22b-production-wiring.js";
import { mountCommentsFeature, stopCommentsFeature } from "../js/22c-comments-wiring.js";
import {
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
} from "../js/22d-views-wiring.js";
import { mountOverlayFeature, stopOverlayFeature } from "../js/22e-overlay-wiring.js";
import { openInitialDocument, startupPorts } from "../js/22f-startup-wiring.js";

let running: (() => void) | null = null;

function view(key: string, mount: () => unknown): [() => unknown, () => void] {
  return [mount, () => stopViewFeature(key)];
}

export function startApp(): () => void {
  if (running) throw new Error("the app is already started; stop it first");
  const stops: (() => void)[] = [];
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
    const startup = beginStartup(startupPorts());
    stops.push(startup.dispose);
    run(view("mountNotices", mountNoticesFeature));
    run([mountTagsFeature, stopTagsFeature]);
    run(view("mountPrompterVisibility", mountPrompterVisibilityFeature));
    openInitialDocument(startup);
    const comments = mountCommentsFeature() as CommentsMount;
    stops.push(stopCommentsFeature);
    run([mountVideoFeature, stopVideoFeature]);
    run([mountToolbarFeature, stopToolbarFeature]);
    const overlay = mountOverlayFeature() as OverlayMount;
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

export function startAppWhenReady(doc: Document): void {
  if (running || cancelReady) throw new Error("the app is already started or waiting to start; stop it first");
  let started = false;
  const cancel = whenDocumentReady(doc, () => {
    started = true;
    cancelReady = null;
    startApp();
  });
  if (!started) cancelReady = cancel;
}
