import * as Y from "yjs";
import type { SharedRecordCollection, SharedStatusEvent } from "../../core/collab/operations.ts";
import { projectSharedBlocks } from "../../core/collab/projection/blocks.ts";
import { sharedJoinGlueRegisterField } from "../../core/collab/projection/join-glue.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { readProjectionBeatStructure, readProjectionFields, readProjectionStream } from "./projection-reader.ts";
import { readProjectionUnits } from "./projection-text-reader.ts";
import { readStoredSharedRecord } from "./record-codec.ts";
import { sortSharedRecordReadings } from "./record-reader.ts";
import { readNativeSharedStatus } from "./status.ts";
import { sharedStatusTargetVersion } from "./status-index.ts";
import { collabState } from "./state.ts";
import { SharedProjectionCache } from "./projection-cache.ts";
import type { CollabRoots } from "./roots.ts";
import type { SharedDocumentHandle } from "./types.ts";

export class SharedProjectionSource {
  readonly cache: SharedProjectionCache;
  readonly roots: CollabRoots;
  private input: SharedDocumentHandle;
  private inputRoots: CollabRoots;
  private readonly versions = new Map<string, number>();
  private readonly keyVersions = new Map<string, number>();
  private readonly joinFields = new Map<string, readonly string[]>();
  private readonly joinReaders = new Map<string, Set<string>>();
  private ownership = "";
  readonly handle: SharedDocumentHandle;

  constructor(handle: SharedDocumentHandle, cache = new SharedProjectionCache()) {
    this.handle = handle;
    this.roots = collabState(handle).roots;
    this.input = handle; this.inputRoots = this.roots;
    this.cache = cache;
  }

  begin(): void { this.cache.begin(); this.ownership = this.structureToken(); }

  normalizedInput(handle: SharedDocumentHandle): void { this.input = handle; this.inputRoots = collabState(handle).roots; }

  changed(name: keyof CollabRoots, events: readonly Y.YEvent<Y.AbstractType<unknown>>[]): void {
    this.versions.set(name, this.version(name) + 1);
    for (const event of events) {
      const path = event.path;
      const keys = path.length ? [String(path[0])] : event instanceof Y.YMapEvent
        ? [...event.keysChanged].filter((key: unknown): key is string => typeof key === "string") : [];
      for (const key of keys) {
        const slot = JSON.stringify([name, key]);
        this.keyVersions.set(slot, (this.keyVersions.get(slot) ?? 0) + 1);
        if (name === "beats") this.unindexJoins(key);
        if (name === "meta") {
          for (const id of this.joinReaders.get(key) ?? []) {
            const scope = JSON.stringify(["join-glue", id]); this.versions.set(scope, this.version(scope) + 1);
          }
          if (key !== "title" && key !== "titleMarks" && !key.startsWith(sharedJoinGlueRegisterField("")))
            this.versions.set("meta-fields", this.version("meta-fields") + 1);
        }
      }
      if (!path.length && event instanceof Y.YMapEvent && [...event.changes.keys.values()].some(change => change.action !== "update")) {
        const slot = name + ":keys";
        this.versions.set(slot, this.version(slot) + 1);
      }
    }
  }

  private version(name: string): number { return this.versions.get(name) ?? 0; }
  private keyVersion(name: string, key: string): number { return this.keyVersions.get(JSON.stringify([name, key])) ?? 0; }

  private keys(name: Exclude<keyof CollabRoots, "order">): readonly string[] {
    return this.cache.read(["keys", name], [this.version(name + ":keys")], () => [...this.inputRoots[name].keys()].sort());
  }

  fields(scope: "document" | "beat" | "heading", key = ""): Record<string, unknown> | null {
    const name = scope === "document" ? "meta" : scope === "beat" ? "beats" : "headings";
    return this.cache.read(["fields", name, key], [scope === "document" ? this.version("meta-fields") : this.keyVersion(name, key)],
      () => readProjectionFields(scope === "document" ? this.inputRoots.meta : this.inputRoots[name].get(key), scope));
  }

  title(): string {
    return this.cache.read(["title"], [this.keyVersion("meta", "title")], () => {
      const title: unknown = this.inputRoots.meta.get("title");
      return title instanceof Y.Text ? title.toString() : "";
    });
  }

  records(collection: SharedRecordCollection) {
    const records = this.keys(collection).flatMap(key => {
      const value = this.cache.read(["record", collection, key], [this.keyVersion(collection, key)], () => {
        const fields = readStoredSharedRecord(collection, key, this.inputRoots[collection].get(key));
        return fields ? { key, fields } : null;
      }, "record");
      return value ? [value] : [];
    });
    return this.cache.read(["records", collection], records, () => sortSharedRecordReadings(collection, [...records]));
  }

  recordGroups(collection: "visuals" | "gallery") {
    const records = this.records(collection);
    return this.cache.read(["record-groups", collection], [records], () => {
      const groups = new Map<unknown, typeof records>();
      for (const record of records) { const group = groups.get(record.fields.beat) ?? []; group.push(record); groups.set(record.fields.beat, group); }
      return groups;
    });
  }

  units(collection: "segments" | "visuals", key: string) {
    return this.cache.read(["units", collection, key], [this.keyVersion(collection, key)], () => {
      const raw: unknown = this.inputRoots[collection].get(key);
      return raw instanceof Y.Map ? readProjectionUnits(this.input, raw.get("text"), raw.get("markRecords")) : [];
    }, collection === "segments" ? "segment" : "visual");
  }

  private streams(includeUnits: boolean) {
    const order = this.cache.read(["order"], [this.version("order")], () => this.inputRoots.order.toArray());
    const ordered = new Set(order), mode = includeUnits ? "text" : "fields";
    const streams = [...new Set([...ordered, ...this.keys("segments")])].flatMap(key => {
      if (typeof key !== "string" || !isStableSharedIdentity(key)) return [];
      const stream = this.cache.read(["stream", mode, key], [this.keyVersion("segments", key), ordered.has(key)], () => {
        const raw: unknown = this.inputRoots.segments.get(key);
        return raw instanceof Y.Map ? readProjectionStream(key, raw, ordered.has(key), includeUnits ? this.units("segments", key) : []) : null;
      });
      return stream ? [stream] : [];
    });
    return this.cache.array(["streams", mode], streams);
  }

  blocks(includeUnits = true) {
    const streams = this.streams(includeUnits), fields = this.keys("beats").map(id => ({ id, fields: this.fields("beat", id) }));
    const records = this.cache.read(["block-records"], fields.flatMap(value => [value.id, value.fields]), () => fields.map(({ id, fields }) =>
      ({ id, valid: fields?.id === id, segment: typeof fields?.segment === "string" ? fields.segment : null })));
    return this.cache.read(["blocks", String(includeUnits)], [streams, records], () => {
      let index = 0;
      return projectSharedBlocks(streams, records, (parts, build) => this.cache.read(["block-units", String(includeUnits), String(index++)], parts, build));
    });
  }

  private structureToken(): string {
    const streams = this.streams(false);
    return JSON.stringify([streams.map(stream => {
      let gap = false;
      const boundaries = stream.parts.flatMap(part => {
        if (!part.boundary) { gap ||= part.to > part.from; return []; }
        const value = [gap, part.boundary]; gap = false; return [value];
      });
      return [stream.segment, stream.inOrder, stream.head, boundaries];
    }),
    this.keys("beats").map(id => { const fields = this.fields("beat", id); return [id, fields?.id, fields?.segment]; })]);
  }

  status(target: SharedStatusEvent["target"]): string {
    const name = target.scope === "beat" ? "beats" : target.scope === "tag" ? "tags" : "shots";
    return this.cache.read(["status", target.scope, target.record], [this.keyVersion(name, target.record),
      sharedStatusTargetVersion(this.handle, target), target.scope === "beat" ? this.ownership : null],
    () => readNativeSharedStatus(this.handle, target));
  }

  structure(id: string) {
    return this.cache.read(["beat-structure", id], [this.keyVersion("beats", id), this.version("retiredJoins"), this.version(JSON.stringify(["join-glue", id]))], () => {
      const fields: string[] = [];
      const structure = readProjectionBeatStructure(this.inputRoots.beats.get(id), id, this.inputRoots.retiredJoins, this.inputRoots.meta, field => fields.push(field));
      this.unindexJoins(id);
      this.joinFields.set(id, fields);
      for (const field of fields) { const readers = this.joinReaders.get(field) ?? new Set<string>(); readers.add(id); this.joinReaders.set(field, readers); }
      return structure;
    });
  }

  private unindexJoins(id: string): void {
    for (const field of this.joinFields.get(id) ?? []) {
      const readers = this.joinReaders.get(field); readers?.delete(id); if (!readers?.size) this.joinReaders.delete(field);
    }
    this.joinFields.delete(id);
  }
}
