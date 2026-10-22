import type { OverlayPorts } from "../../features/overlay/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { mountOverlay } from "../../features/overlay/mount.ts";
import { paintingScreen } from "../../js/05-render.js";
import { closeRowMenus } from "../../js/06-rows.js";
import { clearProductionSelection, hideTagGhost, selectedKeys, tagGhost } from "../../js/07-production-tags.js";
import { renderProduction } from "../../js/08-production-panels.js";
import { closeCommentComposer, closeCommentsPanel } from "../../js/10-comments.js";
import { closeWriter } from "../../js/19-writer.js";
import { viewFlags } from "../../legacy/preferences-bridge.ts";

const overlay = owned<ReturnType<typeof mountOverlay>>();

export function mountOverlayFeature(): ReturnType<typeof mountOverlay> {
  return overlay.replace(function () {
    const ports: OverlayPorts = {
      closeRowMenus: closeRowMenus,
      selectedKeys: selectedKeys,
      clearProductionSelection: clearProductionSelection,
      renderProduction: renderProduction,
      closeCommentComposer: closeCommentComposer,
      closeCommentsPanel: closeCommentsPanel,
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
