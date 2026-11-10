import type * as Y from "yjs";
import type { CollabModel, IdentityBook } from "./model.ts";
import type { SchemaCandidate } from "./schema.ts";
import { readerCarets, readerStructure } from "./readers/structure.ts";

export interface ReplicaCaretAnchor {
  position: Y.RelativePosition;
  selectionEnd?: Y.RelativePosition;
}

export type ReplicaCarets = ReadonlyMap<string, ReplicaCaretAnchor>;

export function readReplica(doc: Y.Doc, candidate: SchemaCandidate, identities: IdentityBook, anchors: ReplicaCarets = new Map()): CollabModel {
  const { model, spans, destinations } = readerStructure(doc, candidate, identities, false);
  readerCarets(model, spans, destinations, doc, anchors);
  return model;
}
