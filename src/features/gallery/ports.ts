import type { UndoEntry, UndoState } from "../../application/editing/undo/history.ts";
import type { Step } from "../../core/text/steps.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { DesktopPresence } from "../../application/desktop-presence.ts";
import type { DesktopVideo } from "../../application/media/desktop-video.ts";
import type { VideoFiles } from "../../application/media/video-files.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { Operations } from "../../application/session/operation.ts";
import type { BundleSaveWindow } from "../../application/save/file-saving-ports.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { Slot, VideoLink } from "../../core/document/gallery.ts";
import type { ImageRef } from "../../core/document/ports.ts";

export interface GalleryPorts {
  readonly document: Pick<DocumentReader, "current" | "read" | "numbering">;
  readonly notices: Pick<NoticePort, "show">;
  readonly pictures: Pick<PictureStore, "ensureBytes" | "urlFor" | "intern" | "persist">;
  readonly ownership: Operations;
  readonly cells: Pick<CellEditing<Element>, "editGallery">;
}

export interface GalleryControls {
  readonly openAnnotator: (rowId: string, at: number) => boolean;
  readonly refreshAnnotator: () => void;
}

export interface GalleryMount extends GalleryControls {
  readonly dispose: () => void;
}

interface GallerySlotRender {
  readonly slotPictureHtml: (slot: Slot) => string;
  readonly badgeHtml: (big: boolean) => string;
}

interface GalleryVideo {
  readonly embedRefusal: (video: unknown) => string;
  readonly playerSrc: (video: unknown) => { readonly src: string; readonly real: string } | null;
  readonly thumbnailsAllowed: () => boolean;
  readonly fetchThumbnail: (href: string) => Promise<ImageRef | null>;
  readonly hostLabel: (link: VideoLink) => string;
}

interface SessionVideos {
  readonly has: (link: VideoLink | null | undefined) => boolean;
  readonly url: (link: VideoLink) => string | null;
}

export interface GalleryOverlayPorts {
  readonly document: Pick<DocumentReader, "current" | "read" | "numbering">;
  readonly notices: Pick<NoticePort, "show" | "showAction">;
  readonly ownership: Operations;
  readonly cells: Pick<CellEditing<Element>, "editGallery">;
  readonly undo: Pick<UndoControl, "breakCoalescing" | "last" | "undo">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly changes: PreferenceChanges;
  readonly pickPicture: (rowId: string) => void;
  readonly render: GallerySlotRender;
  readonly video: GalleryVideo;
  readonly sessionVideos: SessionVideos;
  readonly desktop: DesktopPresence["running"];
}

export interface GalleryOverlayMount {
  readonly dispose: () => void;
}

interface UndoFold {
  readonly fold: (entry: UndoEntry | null | undefined, touches: (step: Step) => boolean, change: (draft: UndoState) => boolean) => boolean;
}

export interface DroppedVideo {
  readonly name: string;
  readonly size: number;
  readonly path: string;
}

export interface VideoBundlePorts {
  readonly window: Window;
  readonly script: () => string | null;
  readonly files: Pick<VideoFiles, "bundle" | "cancelBundle">;
  readonly carries: DesktopVideo["onCarry"];
  readonly saves: { readonly plan: DesktopVideo["planSave"]; readonly choose: DesktopVideo["chooseSave"] };
  readonly exports: { readonly plan: DesktopVideo["planExport"]; readonly pick: DesktopVideo["pickExport"]; readonly run: DesktopVideo["exportBundle"] };
  readonly notices: Pick<NoticePort, "show">;
  readonly ownership: Operations;
  readonly undo: UndoFold;
  readonly document: Pick<DocumentReader, "read">;
  readonly cells: Pick<CellEditing<Element>, "editGallery">;
  readonly viewer: { readonly refresh: () => void };
}

export interface VideoBundleMount {
  readonly offerAfterDrop: (rowId: string, videos: readonly DroppedVideo[], entry: UndoEntry | null) => void;
  readonly beginSave: () => BundleSaveWindow;
  readonly exportPlan: (body: string) => ReturnType<DesktopVideo["planExport"]>;
  readonly exportWithFiles: (zipName: string, scriptName: string, body: string) => Promise<boolean>;
  readonly dispose: () => void;
}

export interface GalleryVideoPorts {
  readonly document: Pick<DocumentReader, "current" | "read" | "numbering">;
  readonly pictures: Pick<PictureStore, "intern" | "persist">;
  readonly ownership: Operations;
  readonly undo: UndoFold;
  readonly thumbnailsAllowed: () => boolean;
  readonly desktop: Pick<DesktopVideo, "present" | "thumbnail">;
  readonly cells: Pick<CellEditing<Element>, "editGallery">;
  readonly viewer: { readonly refresh: () => void };
  readonly bundles: VideoBundlePorts;
}

export interface GalleryVideoMount extends Omit<GalleryVideo, "hostLabel">, Omit<VideoBundleMount, "dispose"> {
  readonly thumbnailsAfterPaste: (rowId: string | null, hrefs: readonly unknown[] | null | undefined, entry: unknown) => void;
  readonly thumbnailsOnBeatClick: (rowId: string | null) => void;
  readonly dispose: () => void;
}
