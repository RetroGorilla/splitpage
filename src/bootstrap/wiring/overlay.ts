import type { OverlayPorts } from "../../features/overlay/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { mountOverlay } from "../../features/overlay/mount.ts";
import { paintingScreen } from "../../js/05-render.js";
import { closeRowMenus } from "../../features/rows/row-menu.js";
import { hideTagGhost, tagGhost } from "../../features/tags/production-tags.js";
import { clearProductionSelection, selectedKeys } from "../../legacy/production-editing-bridge.ts";
import { renderProduction } from "../../features/tags/panels.js";
import { closeCommentComposer } from "../../features/comments/comments.js";
import { closeWriter } from "../../js/19-writer.js";
import { viewFlags } from "../../legacy/preferences-bridge.ts";
import { sidePanels } from "../../legacy/panels-bridge.ts";

const overlay = owned<ReturnType<typeof mountOverlay>>();

export function mountOverlayFeature(): ReturnType<typeof mountOverlay> {
  return overlay.replace(function () {
    const ports: OverlayPorts = {
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
      closeWriter: closeWriter,
      focus: function (target) { target.focus(); }
    };
    return mountOverlay({ window: window, ports: ports });
  });
}

export const stopOverlayFeature = overlay.stop;
