import type { ActionDefinition } from "../../application/actions.ts";
import { galleryActions as definitions } from "../../features/gallery/actions.ts";
import { __init as mountGallery } from "../../features/gallery/annotate.js";
import type { GalleryMount, GalleryPorts } from "../../features/gallery/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { cellEditing } from "../../legacy/editor-bridge.ts";
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
