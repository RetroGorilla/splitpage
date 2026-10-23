import type { ActionRegistry } from "../../application/actions.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { DesktopVideo } from "../../application/media/desktop-video.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { SaveOwnershipPort } from "../../application/save/coordinator.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { Slot, VideoLink } from "../../core/document/gallery.ts";
import type { ImageRef } from "../../core/document/ports.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";

export interface GalleryPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly review: Pick<ReviewFacts, "reviewing">;
  readonly notices: Pick<NoticePort, "show">;
  readonly pictures: Pick<PictureStore, "ensureBytes" | "urlFor" | "intern" | "persist">;
  readonly ownership: SaveOwnershipPort;
  readonly cells: Pick<CellEditing<Element>, "editGallery">;
}

export interface GalleryControls {
  readonly openAnnotator: (rowId: string, at: number) => boolean;
  readonly refreshAnnotator: () => void;
}

export interface GalleryMount extends GalleryControls {
  readonly dispose: () => void;
}

export interface GallerySlotRender {
  readonly slotPictureHtml: (slot: Slot) => string;
  readonly badgeHtml: (big: boolean) => string;
}

export interface GalleryVideo {
  readonly embedRefusal: (video: unknown) => string;
  readonly playerSrc: (video: unknown) => { readonly src: string; readonly real: string } | null;
  readonly thumbnailsAllowed: () => boolean;
  readonly fetchThumbnail: (href: string) => Promise<ImageRef | null>;
  readonly hostLabel: (link: VideoLink) => string;
}

export interface SessionVideos {
  readonly has: (link: VideoLink | null | undefined) => boolean;
  readonly url: (link: VideoLink) => string | null;
}

export interface GalleryOverlayPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly review: Pick<ReviewFacts, "reviewing">;
  readonly notices: Pick<NoticePort, "show" | "showAction">;
  readonly ownership: SaveOwnershipPort;
  readonly cells: Pick<CellEditing<Element>, "editGallery">;
  readonly undo: Pick<UndoControl, "breakCoalescing" | "last" | "undo">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly changes: PreferenceChanges;
  readonly pickPicture: (rowId: string) => void;
  readonly render: GallerySlotRender;
  readonly video: GalleryVideo;
  readonly sessionVideos: SessionVideos;
}

export interface GalleryOverlayMount {
  readonly dispose: () => void;
}

export interface UndoStepView {
  readonly op: string;
  readonly rowId?: string;
  readonly key?: string;
  readonly row?: { readonly id?: string } | null;
}

export interface UndoFold {
  readonly fold: (entry: unknown, touches: (step: UndoStepView) => boolean, change: (doc: ValidatedDocument) => boolean) => boolean;
}

export interface GalleryVideoPorts {
  readonly document: Pick<DocumentReader, "current" | "read">;
  readonly pictures: Pick<PictureStore, "intern" | "persist">;
  readonly ownership: SaveOwnershipPort;
  readonly undo: UndoFold;
  readonly thumbnailsAllowed: () => boolean;
  readonly desktop: Pick<DesktopVideo, "present" | "thumbnail">;
}

export interface GalleryVideoMount extends Omit<GalleryVideo, "hostLabel"> {
  readonly thumbnailsAfterPaste: (rowId: string | null, hrefs: readonly unknown[] | null | undefined, entry: unknown) => void;
  readonly dispose: () => void;
}
