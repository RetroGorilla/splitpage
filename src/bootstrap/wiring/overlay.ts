import type { OverlayPorts } from "../../features/overlay/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { mountOverlay } from "../../features/overlay/mount.ts";
import { paintingScreen } from "../../features/rows/render.ts";
import { closeRowMenus } from "../../features/rows/row-menu.js";
import { hideTagGhost, tagGhost } from "../../features/tags/production-tags.ts";
import { clearProductionSelection, selectedKeys } from "./production-editing-owners.ts";
import { renderProduction } from "../../features/tags/panels.js";
import { closeCommentComposer } from "../../features/comments/comments.js";
import { connectWriter } from "./writer.ts";
import { viewFlags } from "./preferences-owner.ts";
import { sidePanels } from "./ports/panels.ts";

function inactiveWriterOverlay(): void {}

const overlay = owned<ReturnType<typeof mountOverlay>>();

export function mountOverlayFeature(): ReturnType<typeof mountOverlay> {
  return overlay.replace(function () {
    const ports: { -readonly [K in keyof OverlayPorts]: OverlayPorts[K] } = {
      closeRowMenus: closeRowMenus,
      selectedKeys: selectedKeys,
      clearProductionSelection: clearProductionSelection,
      renderProduction: renderProduction,
      closeCommentComposer: closeCommentComposer,
      closeCommentsPanel: () => { sidePanels().close("comments-panel"); },
      writerOpen: function () { return viewFlags().writerOpen(); },
      paintingScreen: paintingScreen,
      hasTagGhost: function () { return !!tagGhost; },
      hideTagGhost: hideTagGhost,
      closeWriter: inactiveWriterOverlay,
      focus: function (target) { target.focus(); }
    };
    const mounted = mountOverlay({ window: window, ports: ports });
    const disconnect = connectWriter((control) => { ports.closeWriter = control?.closeWriter ?? inactiveWriterOverlay; });
    return { ...mounted, dispose: () => { disconnect(); mounted.dispose(); } };
  });
}

export const stopOverlayFeature = overlay.stop;
