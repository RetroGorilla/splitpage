import { identityEntries } from "./readers/identity.ts";
import type * as Y from "yjs";
import type { CollabModel, CollabRow, IdentityBook } from "./model.ts";
import type { ReplicaCarets } from "./reader.ts";
import type { SchemaCandidate } from "./schema.ts";
import { projectComments, projectStructuralMarks } from "./marks/projection.ts";
import { readerCarets, readerStructure } from "./readers/structure.ts";
import { readGalleryRecord, readVisualRecord, rootMap } from "./readers/records.ts";
import { readerCharacters } from "./readers/spans.ts";
import { compareCodeUnits } from "./readers/order.ts";

export function readStructure(doc: Y.Doc, candidate: SchemaCandidate, book: IdentityBook, carets: ReplicaCarets = new Map()): CollabModel {
  const { model, spans, destinations } = readerStructure(doc, candidate, book, true);
  const order = new Map(spans.map((span, index) => [span.row.id, index]));
  const visuals = identityEntries(rootMap(doc, "visuals")).flatMap(([id, raw]) => { const value = readVisualRecord(raw); return value ? [{ id, ...value }] : []; });
  visuals.sort((a, b) => (order.get(a.beat) ?? spans.length) - (order.get(b.beat) ?? spans.length)
    || compareCodeUnits(a.rank, b.rank) || compareCodeUnits(a.id, b.id));
  for (const component of visuals) {
    const target = destinations.get(component.beat)?.row; if (!target) continue;
    const visual: CollabRow = { id: component.id, characters: [] };
    let index = 0;
    for (const delta of component.text.toDelta()) {
      const insert: unknown = delta.insert;
      if (typeof insert === "string") visual.characters.push(...readerCharacters(component.text, index, insert, delta.attributes, component.id, book));
      index += typeof insert === "string" ? insert.length : 1;
    }
    (target.visuals ??= []).push(visual);
    target.visualText = target.visuals.filter(row => row.characters.length).map(row => row.characters.map(character => character.value).join("")).join("<br>");
  }
  const gallery = identityEntries(rootMap(doc, "gallery")).flatMap(([id, raw]) => { const value = readGalleryRecord(id, raw); return value ? [value] : []; });
  gallery.sort((a, b) => (order.get(a.beat) ?? spans.length) - (order.get(b.beat) ?? spans.length)
    || compareCodeUnits(a.rank, b.rank) || compareCodeUnits(a.id, b.id));
  for (const item of gallery) {
    const target = destinations.get(item.beat)?.row; if (!target) continue;
    const items = (target.gallery ??= []) as { ref: string; name: string; annotation: string; links: { href: string; poster?: string }[] }[];
    const existing = item.ref ? items.find(entry => entry.ref === item.ref) : undefined;
    if (!existing) items.push({ ref: item.ref, name: item.name, annotation: item.annotation, links: item.links.map(link => ({ ...link })) });
    else {
      existing.name ||= item.name; existing.annotation ||= item.annotation;
      for (const link of item.links) {
        const old = existing.links.find(entry => entry.href === link.href);
        if (!old) existing.links.push({ ...link });
        else if (!old.poster && link.poster) old.poster = link.poster;
      }
    }
  }
  if (gallery.length) model.records = { gallery: Object.fromEntries(gallery.sort((a, b) => compareCodeUnits(a.id, b.id)).map(item => [item.id, item.data])) };
  readerCarets(model, spans, destinations, doc, carets, visuals);
  projectStructuralMarks(model, doc); projectComments(model, doc);
  return model;
}
