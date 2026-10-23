import type { ActionDefinition } from "../../application/actions.ts";
import { galleryActions as definitions } from "../../features/gallery/actions.ts";
import { __init as mountGallery } from "../../features/gallery/annotate.js";
import { __init as mountOverlay } from "../../features/gallery/overlay.js";
import { __init as mountVideo } from "../../features/gallery/video.js";
import type { GalleryMount, GalleryOverlayMount, GalleryOverlayPorts, GalleryPorts, GalleryVideoMount, GalleryVideoPorts } from "../../features/gallery/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { videoHostLabel } from "../../adapters/formats/video-host.ts";
import { galleryBadgeHtml, gallerySlotPictureHtml } from "../../js/05-render.js";
import { hasSessionVideo, sessionVideoUrl } from "../../js/06-rows.js";
import { foldIntoEdit } from "../../js/12a-undo.js";
import { cellEditing, pickPictureFor } from "../../legacy/editor-bridge.ts";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { desktopVideo } from "./desktop-video.ts";
import { sharedPorts } from "./shared-ports.ts";

const gallery = owned<GalleryMount>();

export function mountGalleryFeature(): GalleryMount {
  return gallery.replace(() => {
    const shared = sharedPorts();
    const ports: GalleryPorts = {
      document: shared.document,
      review: shared.review,
      notices: shared.notices,
      pictures: shared.pictures,
      ownership: shared.ownership,
      cells: { editGallery: (...a) => cellEditing().editGallery(...a) }
    };
    return mountGallery(ports);
  });
}

export const stopGalleryFeature = gallery.stop;

export function galleryActions(): ActionDefinition[] {
  return definitions(gallery.owner);
}

const overlay = owned<GalleryOverlayMount>();

export function mountGalleryOverlayFeature(): GalleryOverlayMount {
  return overlay.replace(() => {
    const shared = sharedPorts();
    const ports: GalleryOverlayPorts = {
      document: shared.document,
      review: shared.review,
      notices: shared.notices,
      ownership: shared.ownership,
      cells: { editGallery: (...a) => cellEditing().editGallery(...a) },
      undo: shared.undo,
      actions: shared.actions,
      changes: shared.changes,
      pickPicture: pickPictureFor,
      render: { slotPictureHtml: gallerySlotPictureHtml, badgeHtml: galleryBadgeHtml },
      video: {
        embedRefusal: (v) => video.owner()?.embedRefusal(v) ?? "",
        playerSrc: (v) => video.owner()?.playerSrc(v) ?? null,
        thumbnailsAllowed: () => video.owner()?.thumbnailsAllowed() ?? false,
        fetchThumbnail: (href) => video.owner()?.fetchThumbnail(href) ?? Promise.resolve(null),
        hostLabel: videoHostLabel
      },
      sessionVideos: { has: hasSessionVideo, url: sessionVideoUrl }
    };
    return mountOverlay(ports);
  });
}

export const stopGalleryOverlayFeature = overlay.stop;

const video = owned<GalleryVideoMount>();

export function mountGalleryVideoFeature(): GalleryVideoMount {
  return video.replace(() => {
    const shared = sharedPorts();
    const ports: GalleryVideoPorts = {
      document: shared.document,
      pictures: shared.pictures,
      ownership: shared.ownership,
      undo: { fold: foldIntoEdit },
      thumbnailsAllowed: () => preferences().videoThumbs(),
      desktop: desktopVideo
    };
    return mountVideo(ports);
  });
}

export const stopGalleryVideoFeature = video.stop;

export function thumbnailsAfterPaste(rowId: string | null, hrefs: readonly unknown[] | null | undefined, entry: unknown): void {
  video.owner()?.thumbnailsAfterPaste(rowId, hrefs, entry);
}
