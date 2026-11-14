import * as Y from "yjs";

const OWNED = new Set(["visuals", "gallery"]);

function ownedRoot(type: Y.AbstractType<unknown>): boolean {
  if (type._item !== null || !type.doc) return false;
  for (const [name, root] of type.doc.share) if (root === type) return OWNED.has(name);
  return false;
}

// why: an undone split watches every visual and gallery record that was ever its new beat's, so a deleted record keeps
// itself and its beat field through garbage collection; its other fields and its text are collected as usual.
export function collectSharedAttachmentItem(item: Y.Item): boolean {
  const parent = item.parent;
  if (!(parent instanceof Y.AbstractType)) return true;
  if (ownedRoot(parent)) return false;
  const record = parent._item, root = record?.parent;
  return !(item.parentSub === "beat" && root instanceof Y.AbstractType && ownedRoot(root));
}

export function readSharedAttachmentOwner(item: Y.Item): unknown {
  const content = item.content;
  if (!(content instanceof Y.ContentType) || !(content.type instanceof Y.Map)) return null;
  const owner = content.type._map.get("beat");
  if (!owner) return null;
  const value = owner.content;
  return value instanceof Y.ContentAny ? value.getContent()[0] : null;
}
