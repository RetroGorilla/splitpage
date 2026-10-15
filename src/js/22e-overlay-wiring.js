import { owned } from "../features/routing/owned.ts";
import { mountOverlay } from "../features/overlay/mount.ts";
import { paintingScreen } from "./05-render.js";
import { closeRowMenus } from "./06-rows.js";
import { clearProductionSelection, hideTagGhost, selectedKeys, tagGhost } from "./07-production-tags.js";
import { renderProduction } from "./08-production-panels.js";
import { closeCommentComposer, closeCommentsPanel } from "./10-comments.js";
import { closeWriter, writerOpen } from "./19-writer.js";

var overlay = owned();

export function mountOverlayFeature() {
  return overlay.replace(function () {
    return mountOverlay({
    window: window,
    ports: {
      closeRowMenus: closeRowMenus,
      selectedKeys: selectedKeys,
      clearProductionSelection: clearProductionSelection,
      renderProduction: renderProduction,
      closeCommentComposer: closeCommentComposer,
      closeCommentsPanel: closeCommentsPanel,
      writerOpen: function () { return writerOpen; },
      paintingScreen: paintingScreen,
      hasTagGhost: function () { return !!tagGhost; },
      hideTagGhost: hideTagGhost,
      closeWriter: closeWriter,
      focus: function (target) { target.focus(); }
    }
    });
  });
}

export var stopOverlayFeature = overlay.stop;
