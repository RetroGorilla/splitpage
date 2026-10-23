import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { CellEditing } from "../../application/editing/cell-editing.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { SaveOwnershipPort } from "../../application/save/coordinator.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";

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
