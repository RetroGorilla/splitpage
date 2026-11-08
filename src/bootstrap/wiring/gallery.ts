import type { ActionDefinition } from "../../application/actions.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { pictures as portPictures } from "./ports/pictures.ts";
import { ownership as portOwnership } from "./ports/saving.ts";
import { undoControl as portUndo } from "./ports/editing.ts";
import { actions as portActions } from "./ports/actions.ts";
import { changes as portChanges } from "./ports/preferences.ts";
import { galleryActions as definitions } from "../../features/gallery/actions.ts";
import { startAnnotate as mountGallery } from "../../features/gallery/annotate.ts";
import { refreshGalleryOverlay, startGalleryOverlay as mountOverlay } from "../../features/gallery/overlay.ts";
import { startGalleryVideo as mountVideo } from "../../features/gallery/video.ts";
import type { GalleryMount, GalleryOverlayMount, GalleryOverlayPorts, GalleryPorts, GalleryVideoMount, GalleryVideoPorts } from "../../features/gallery/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { videoHostLabel } from "../../adapters/formats/video-host.ts";
import { galleryBadgeHtml, gallerySlotPictureHtml } from "../../features/rows/render.ts";
import { videoFiles } from "./video-files.ts";
import { undoOwner } from "./undo.ts";
import { cellEditing, pickPictureFor } from "./editor-owners.ts";
import { preferences } from "./preferences-owner.ts";
import { desktopVideo } from "./desktop-video.ts";
import { presence } from "./ports/desktop-presence.ts";
import { currentHome } from "./location-owner.ts";

const gallery = owned<GalleryMount>();

export function mountGalleryFeature(): GalleryMount {
  return gallery.replace(() => {
    const ports: GalleryPorts = {
      document: portDocument,
      notices: portNotices,
      pictures: portPictures,
      ownership: portOwnership,
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
    const ports: GalleryOverlayPorts = {
      document: portDocument,
      notices: portNotices,
      ownership: portOwnership,
      cells: { editGallery: (...a) => cellEditing().editGallery(...a) },
      undo: portUndo,
      actions: portActions,
      changes: portChanges,
      pickPicture: pickPictureFor,
      render: { slotPictureHtml: gallerySlotPictureHtml, badgeHtml: galleryBadgeHtml },
      video: {
        embedRefusal: (v) => video.owner()?.embedRefusal(v) ?? "",
        playerSrc: (v) => video.owner()?.playerSrc(v) ?? null,
        thumbnailsAllowed: () => video.owner()?.thumbnailsAllowed() ?? false,
        fetchThumbnail: (href) => video.owner()?.fetchThumbnail(href) ?? Promise.resolve(null),
        hostLabel: videoHostLabel
      },
      sessionVideos: { has: videoFiles.has, url: videoFiles.url },
      desktop: presence.running
    };
    return mountOverlay(ports);
  });
}

export const stopGalleryOverlayFeature = overlay.stop;

const video = owned<GalleryVideoMount>();

export function mountGalleryVideoFeature(): GalleryVideoMount {
  return video.replace(() => {
    const ports: GalleryVideoPorts = {
      document: portDocument,
      pictures: portPictures,
      ownership: portOwnership,
      undo: { fold: (entry, touches, change) => undoOwner().foldIntoEdit(entry, touches, change) },
      thumbnailsAllowed: () => preferences().videoThumbs(),
      desktop: desktopVideo,
      cells: { editGallery: (...a) => cellEditing().editGallery(...a) },
      viewer: { refresh: refreshGalleryOverlay },
      bundles: {
        window: window,
        script: scriptOnDisk,
        files: { bundle: videoFiles.bundle, move: videoFiles.move, cancelBundle: videoFiles.cancelBundle },
        carries: desktopVideo.onCarry,
        saves: { plan: desktopVideo.planSave, choose: desktopVideo.chooseSave },
        exports: { plan: desktopVideo.planExport, pick: desktopVideo.pickExport, run: desktopVideo.exportBundle },
        notices: portNotices,
        ownership: portOwnership,
        undo: { fold: (entry, touches, change) => undoOwner().foldIntoEdit(entry, touches, change) },
        document: portDocument,
        cells: { editGallery: (...a) => cellEditing().editGallery(...a) },
        viewer: { refresh: refreshGalleryOverlay }
      }
    };
    return mountVideo(ports);
  });
}

function scriptOnDisk(): string | null {
  if (!presence.running()) return null;
  const home = currentHome();
  const handle = home.handle as { readonly _desktopId?: unknown; readonly name?: unknown } | null | undefined;
  return home.kind === "file" && handle && handle._desktopId && typeof handle.name === "string" && handle.name ? handle.name : null;
}

export function offerBundleAfterDrop(...args: Parameters<GalleryVideoMount["offerAfterDrop"]>): void {
  video.owner()?.offerAfterDrop(...args);
}

export function beginBundleSave(): ReturnType<GalleryVideoMount["beginSave"]> {
  const owner = video.owner();
  return owner ? owner.beginSave() : { drained: null, ask: () => Promise.resolve([]), end: () => {} };
}

export function exportFilesPlan(body: string, script: unknown): ReturnType<GalleryVideoMount["exportPlan"]> {
  const owner = video.owner();
  return owner ? owner.exportPlan(body, script) : Promise.resolve(null);
}

export function exportScriptWithFiles(zipName: string, scriptName: string, body: string, script: unknown): Promise<boolean> {
  const owner = video.owner();
  return owner ? owner.exportWithFiles(zipName, scriptName, body, script) : Promise.resolve(false);
}

export const stopGalleryVideoFeature = video.stop;

export function thumbnailsAfterPaste(rowId: string | null, hrefs: readonly unknown[] | null | undefined, entry: unknown): void {
  video.owner()?.thumbnailsAfterPaste(rowId, hrefs, entry);
}

export function thumbnailsOnBeatClick(rowId: string | null): void {
  video.owner()?.thumbnailsOnBeatClick(rowId);
}
