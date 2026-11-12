import type { SharedSegmentCreate } from "../../core/collab/operations.ts";
import type { SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import { sharedRecordFieldAccepted, readSharedNestedInput } from "./record-codec.ts";
import { SharedStructurePreparationError, sharedStructureIdentity, reserveSharedStructureIdentity } from "./structure-identity.ts";
import type { SharedStructureIdentityReservations } from "./structure-identity.ts";
import { sharedCreatedAttachments } from "./structure-content.ts";

export function prepareSharedInitialGallery(operation: SharedSegmentCreate, view: SharedPreparationView, beat: string, identities: SharedStructureIdentityReservations): SharedPreparedWrite[] {
  const fields = operation.fields, slots: Record<string, unknown>[] = [], more = fields.moreImages;
  if (fields.visualImage !== undefined && fields.visualImage !== null && fields.visualImage !== "") throw new SharedStructurePreparationError("legacy-image-required");
  const first: Record<string, unknown> = {};
  for (const [source, target] of [["imageRef", "imageRef"], ["imageName", "name"], ["imageAnnotation", "annotation"]]) if (source && target && fields[source] !== undefined) first[target] = fields[source];
  slots.push({ ...first, links: fields.imageLinks ?? [] });
  if (more !== undefined && more !== null && !Array.isArray(more)) throw new SharedStructurePreparationError("invalid-initial-gallery");
  const additional: readonly unknown[] = Array.isArray(more) ? more : [];
  for (let index = 0; index < additional.length; index++) {
    const slot = additional[index];
    if (!slot || typeof slot !== "object" || Array.isArray(slot) || Object.keys(slot).some(key => !["imageRef", "name", "annotation", "links"].includes(key))) throw new SharedStructurePreparationError("invalid-initial-gallery");
    slots.push(slot as Record<string, unknown>);
  }
  const writes: SharedPreparedWrite[] = [];
  slots.forEach((slot, index) => {
    const { links = [], ...picture } = slot;
    if (!sharedRecordFieldAccepted("gallery", "picture", picture)) throw new SharedStructurePreparationError("invalid-initial-gallery");
    const entries = readSharedNestedInput("links", links ?? []);
    if (!entries) throw new SharedStructurePreparationError("invalid-initial-gallery");
    if (slots.length === 1 && !picture.imageRef && !picture.name && !picture.annotation && !entries.length) return;
    const record = sharedStructureIdentity(view.writer, operation.id, "gallery", index), path = ["gallery", record];
    reserveSharedStructureIdentity(view, record, identities);
    if (view.has(path)) throw new SharedStructurePreparationError("existing-identity");
    writes.push({ kind: "map", path }, { kind: "set", path: [...path, "beat"], value: beat }, { kind: "set", path: [...path, "rank"], value: String(index).padStart(10, "0") },
      { kind: "set", path: [...path, "picture"], value: picture }, { kind: "set", path: [...path, "extra"], value: "{}" }, { kind: "map", path: [...path, "links"] });
    entries.forEach(([key, value], rank) => {
      const link = [...path, "links", key]; writes.push({ kind: "map", path: link });
      for (const [field, item] of Object.entries(value)) writes.push({ kind: "set", path: [...link, field], value: item });
      writes.push({ kind: "set", path: [...link, "rank"], value: String(rank).padStart(10, "0") }, { kind: "set", path: [...link, "extra"], value: "{}" });
    });
    sharedCreatedAttachments(view).push({ collection: "gallery", beat, html: null, record });
  });
  return writes;
}
