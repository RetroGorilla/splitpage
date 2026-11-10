import * as Y from "yjs";
import type { CollabIdentity } from "../model.ts";
import type { ReplicaCaretAnchor } from "../reader.ts";

export type SequenceType = Y.Text | Y.Array<unknown>;
export type StoredAttributes = Record<string, unknown>;

export interface IdentityPoint {
  id: CollabIdentity | null;
  assoc: number;
  container?: unknown;
}

export interface SelectionRecord {
  start: IdentityPoint;
  end?: IdentityPoint;
}

export interface StoredContent {
  id: CollabIdentity;
  insert: unknown;
  attributes: StoredAttributes;
}

export interface ResolvedIdentity {
  type: SequenceType;
  index: number;
  live: boolean;
}

export function identityKey(id: CollabIdentity): string {
  return `${id.client}:${id.clock}`;
}

export function sameIdentity(left: CollabIdentity, right: CollabIdentity): boolean {
  return left.client === right.client && left.clock === right.clock;
}

function sequence(type: unknown): SequenceType {
  if (type instanceof Y.Text || type instanceof Y.Array) return type as SequenceType;
  throw new Error("Identity is not in a text or array");
}

export function itemAt(type: SequenceType, index: number): CollabIdentity | null {
  if (index < 0 || index >= type.length) return null;
  const item = Y.createRelativePositionFromTypeIndex(type, index, 0).item;
  return item ? { client: item.client, clock: item.clock } : null;
}

function pointOf(position: Y.RelativePosition): IdentityPoint {
  if (position.item) return { id: { client: position.item.client, clock: position.item.clock }, assoc: position.assoc };
  return { id: null, assoc: position.assoc, container: Y.relativePositionToJSON(position) };
}

export function pointAt(type: SequenceType, index: number, assoc: number): IdentityPoint {
  const position = Y.createRelativePositionFromTypeIndex(type, index, assoc);
  if (position.item || index === 0) return pointOf(position);
  return pointOf(Y.createRelativePositionFromTypeIndex(type, index, -1));
}

export function resolveIdentity(doc: Y.Doc, id: CollabIdentity): ResolvedIdentity | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON({ item: id, assoc: 0 }), doc, false);
  if (!absolute) return null;
  const type = sequence(absolute.type);
  const here = itemAt(type, absolute.index);
  return { type, index: absolute.index, live: here !== null && sameIdentity(here, id) };
}

export function contentAt(type: SequenceType, index: number): { insert: unknown; attributes: StoredAttributes } {
  if (type instanceof Y.Array) return { insert: type.get(index), attributes: {} };
  let start = 0;
  for (const delta of type.toDelta() as { insert: unknown; attributes?: StoredAttributes }[]) {
    const length = typeof delta.insert === "string" ? delta.insert.length : 1;
    if (index < start + length) {
      return { insert: typeof delta.insert === "string" ? delta.insert.charAt(index - start) : delta.insert, attributes: { ...delta.attributes } };
    }
    start += length;
  }
  throw new Error(`No content at ${index}`);
}

export function storedContent(doc: Y.Doc, id: CollabIdentity): StoredContent {
  const at = resolveIdentity(doc, id);
  if (!at?.live) throw new Error(`Cannot record absent identity ${identityKey(id)}`);
  return { id, ...contentAt(at.type, at.index) };
}

export function insertContent(type: SequenceType, index: number, content: StoredContent): CollabIdentity {
  if (type instanceof Y.Array) type.insert(index, [content.insert]);
  else if (typeof content.insert === "string") type.insert(index, content.insert, { ...content.attributes });
  else type.insertEmbed(index, content.insert as Record<string, unknown>, { ...content.attributes });
  const created = itemAt(type, index);
  if (!created) throw new Error("Restored content has no identity");
  return created;
}

export function anchorOf(point: IdentityPoint): Y.RelativePosition {
  return Y.createRelativePositionFromJSON(point.id ? { item: point.id, assoc: point.assoc } : point.container);
}

export function selectionOf(anchor: ReplicaCaretAnchor): SelectionRecord {
  return { start: pointOf(anchor.position), ...(anchor.selectionEnd ? { end: pointOf(anchor.selectionEnd) } : {}) };
}
