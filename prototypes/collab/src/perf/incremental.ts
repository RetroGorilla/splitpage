import { identityEntries, identityGet, wireIdentity } from "../readers/identity.ts";
import * as Y from "yjs";
import { toDocument } from "../proj/document.ts";
import { records } from "../proj/value.ts";
import type { ProjectionBag } from "../proj/value.ts";
import type { ProjectionDelta } from "../proj/richtext.ts";
import { readDelta } from "../proj/richtext.ts";
import type { SchemaReplica } from "../schema.ts";
import { PerfBlockIndex } from "./blocks.ts";
import { readGallerySlotRecord, readVisualRecord, rootMap, sameProjectionValue } from "../readers/records.ts";

export class IncrementalProjection {
  readonly replica: SchemaReplica;
  readonly index: PerfBlockIndex;
  document: ProjectionBag;
  lastProjected: string[] = [];
  commits = 0;
  private readonly pending: { root: string; event: Y.YEvent<Y.AbstractType<unknown>>; path: (string | number)[] }[] = [];
  private readonly stops: (() => void)[] = [];
  private readonly anchors = new Map<string, { id: string; field: string }[]>();
  private readonly owners = new Map<string, string>();

  constructor(replica: SchemaReplica) {
    this.replica = replica;
    this.index = new PerfBlockIndex(replica.doc, replica.candidate);
    this.document = toDocument(replica.doc, replica.candidate);
    for (const row of records(this.document.rows)) this.updateAnchors(String(row.id));
    const roots = ["beats", "visuals", "gallery", "comments", "replies", "people", "tags", "shots", "meta", "headings", "statusEvents", "retiredStatus", "removalRecords", "retiredJoins"];
    roots.push(...(replica.candidate === "A" ? ["flow"] : ["segments", "order"]));
    for (const root of roots) {
      const type = replica.doc.share.get(root);
      if (!type) continue;
      const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
        for (const event of events) this.pending.push({ root, event, path: [...event.path] });
      };
      type.observeDeep(observe);
      this.stops.push(() => type.unobserveDeep(observe));
    }
    const after = (): void => { if (this.pending.length) this.commit(); };
    replica.doc.on("afterTransaction", after);
    this.stops.push(() => replica.doc.off("afterTransaction", after));
  }

  private updateAnchors(id: string): void {
    const found: { id: string; field: string }[] = [];
    const collect = (delta: readonly ProjectionDelta[], field: string): void => {
      for (const item of delta) for (const [key, value] of Object.entries(item.attributes ?? {})) {
        if (value && key.startsWith("c:")) found.push({ id: key.slice(2), field });
      }
    };
    const block = this.index.spans.find(span => span.block.id === id)?.block;
    for (const [key, value] of identityEntries(rootMap(this.replica.doc, "visuals"))) {
      const visual = readVisualRecord(value);
      if (!visual) { this.owners.delete(`visuals:${key}`); continue; }
      this.owners.set(`visuals:${key}`, visual.beat);
      if (visual.beat === id) collect(readDelta(visual.text), "visualText");
    }
    if (block) collect(block.delta, "audioText");
    for (const [key, value] of identityEntries(rootMap(this.replica.doc, "gallery"))) {
      const slot = readGallerySlotRecord(value);
      if (slot) this.owners.set(`gallery:${key}`, slot.beat); else this.owners.delete(`gallery:${key}`);
    }
    this.anchors.set(id, found);
  }

  private commit(): void {
    const pending = this.pending.splice(0);
    const textEvents = pending.filter(item => ["flow", "segments", "order"].includes(item.root));
    const dirty = textEvents.length ? this.index.refresh(textEvents.map(item => item.event)) : new Set<string>();
    let all = false;
    for (const { root, event, path } of pending) {
      if (root === "tags" || (root === "comments" && event instanceof Y.YMapEvent && (path.length === 0 || event.keysChanged.has("anchorId")))) all = true;
      if (!["beats", "visuals", "gallery"].includes(root)) continue;
      const ids = path.length ? [wireIdentity(String(path[0]))] : event instanceof Y.YMapEvent ? [...event.keysChanged].map(key => wireIdentity(String(key))) : [];
      for (const id of ids) {
        if (root === "beats") dirty.add(id);
        else {
          const value = identityGet(rootMap(this.replica.doc, root), id);
          const old = this.owners.get(`${root}:${id}`);
          if (old) dirty.add(old);
          const record = root === "visuals" ? readVisualRecord(value) : readGallerySlotRecord(value);
          if (record) dirty.add(record.beat);
        }
      }
    }
    if (all) for (const span of this.index.spans) dirty.add(span.block.id);
    const blocks = this.index.spans.map(span => span.block);
    const partial = toDocument(this.replica.doc, this.replica.candidate, { blocks: blocks.filter(block => block.kind === "h" || dirty.has(block.id)), sectionBlocks: blocks });
    const replacements = new Map(records(partial.rows).map(row => [String(row.id), row]));
    const old = new Map(records(this.document.rows).map(row => [String(row.id), row]));
    const rows = blocks.filter(block => block.kind === "b").flatMap(block => {
      const row = replacements.get(block.id) ?? old.get(block.id);
      if (!row) return [];
      const previous = old.get(block.id);
      return [previous && row !== previous && sameProjectionValue(row, previous) ? previous : row];
    });
    for (const id of dirty) this.updateAnchors(id);
    const first = new Map<string, { rowId: string; field: string }>();
    for (const row of rows) for (const anchor of this.anchors.get(String(row.id)) ?? []) {
      if (!first.has(anchor.id)) first.set(anchor.id, { rowId: String(row.id), field: anchor.field });
    }
    for (const comment of records(partial.comments)) {
      const anchor = typeof comment.id === "string" ? first.get(comment.id) : undefined;
      if (anchor) Object.assign(comment, anchor);
    }
    partial.rows = rows;
    this.document = partial;
    this.lastProjected = [...replacements.keys()];
    this.commits++;
  }

  destroy(): void { for (const stop of this.stops) stop(); }
}
