import * as Y from "yjs";
import type { CollabIdentity, CollabMarks } from "./model.ts";
import type { IdentityBook } from "./model.ts";

export type SchemaCandidate = "A" | "B";

export interface SeedBeat {
  id: string;
  text: string;
  lengthSeconds?: number;
  kind?: "heading";
}

export interface LocatedCharacter {
  identity: CollabIdentity;
  value: string;
  beat: string;
  text: Y.Text;
  index: number;
}

export interface BeatLocation {
  text: Y.Text;
  start: number;
  end: number;
}

export interface UndoIdentityAnchor {
  notation: string;
  position: Y.RelativePosition;
}

export function mapValue(value: unknown): Y.Map<unknown> {
  if (!(value instanceof Y.Map)) throw new Error("Expected a shared map");
  return value as Y.Map<unknown>;
}

export function textValue(value: unknown): Y.Text {
  if (!(value instanceof Y.Text)) throw new Error("Expected shared text");
  return value;
}

export function identityAt(text: Y.Text, index: number): CollabIdentity {
  const identity = Y.createRelativePositionFromTypeIndex(text, index, 0).item;
  if (!identity) throw new Error(`No identity at ${index}`);
  return { client: identity.client, clock: identity.clock };
}

export class SchemaReplica {
  readonly doc: Y.Doc;
  readonly localOrigin = {};
  readonly candidate: SchemaCandidate;
  readonly identities: IdentityBook;

  constructor(candidate: SchemaCandidate, client: number, identities: IdentityBook) {
    this.doc = new Y.Doc();
    this.doc.clientID = client;
    this.candidate = candidate;
    this.identities = identities;
  }

  private texts(): { text: Y.Text; head: string | null }[] {
    if (this.candidate === "A") return [{ text: this.doc.getText("flow"), head: null }];
    const segments = this.doc.getMap("segments");
    return [...new Set(this.doc.getArray<string>("order").toArray())].map(id => {
      const segment = mapValue(segments.get(id));
      const head = segment.get("head") as { b?: string; h?: string };
      return { text: textValue(segment.get("text")), head: head.b ?? head.h ?? null };
    });
  }

  characters(): LocatedCharacter[] {
    const result: LocatedCharacter[] = [];
    for (const { text, head } of this.texts()) {
      let beat = head;
      let index = 0;
      for (const delta of text.toDelta()) {
        const insert: unknown = delta.insert;
        if (typeof insert === "string") {
          for (let offset = 0; offset < insert.length; offset++) {
            if (!beat) throw new Error("Character outside a beat");
            result.push({ identity: identityAt(text, index + offset), value: insert.charAt(offset), beat, text, index: index + offset });
          }
          index += insert.length;
        } else {
          if (typeof insert !== "object" || insert === null) {
            throw new Error("Unsupported feasibility atom");
          }
          beat = "b" in insert ? String(insert.b) : "h" in insert ? String(insert.h) : null;
          index++;
        }
      }
    }
    return result;
  }

  locate(beatId: string): BeatLocation {
    for (const { text, head } of this.texts()) {
      let beat = head;
      let start = 0;
      let index = 0;
      for (const delta of text.toDelta()) {
        const insert: unknown = delta.insert;
        if (typeof insert === "string") {
          index += insert.length;
        } else {
          if (beat === beatId) return { text, start, end: index };
          if (typeof insert !== "object" || insert === null) {
            throw new Error("Unsupported feasibility atom");
          }
          beat = "b" in insert ? String(insert.b) : "h" in insert ? String(insert.h) : null;
          start = ++index;
        }
      }
      if (beat === beatId) return { text, start, end: index };
    }
    throw new Error(`Missing beat ${beatId}`);
  }

  private addBeat(id: string, lengthSeconds?: number): void {
    const beat = new Y.Map<unknown>();
    this.doc.getMap("beats").set(id, beat);
    beat.set("joins", new Y.Map<unknown>());
    beat.set("removals", new Y.Map<unknown>());
    if (lengthSeconds !== undefined) beat.set("lengthSeconds", lengthSeconds);
  }

  seed(beats: readonly SeedBeat[]): void {
    let serial = 1;
    this.doc.transact(() => {
      for (const beat of beats) {
        let text: Y.Text;
        if (this.candidate === "A") {
          text = this.doc.getText("flow");
          text.insertEmbed(text.length, beat.kind === "heading" ? { h: beat.id } : { b: beat.id }, {});
        } else {
          const segment = new Y.Map<unknown>();
          this.doc.getMap("segments").set(`seg-${beat.id}`, segment);
          text = new Y.Text();
          segment.set("text", text);
          segment.set("head", beat.kind === "heading" ? { h: beat.id } : { b: beat.id });
          this.doc.getArray<string>("order").push([`seg-${beat.id}`]);
        }
        const start = text.length;
        text.insert(start, beat.text, {});
        for (let offset = 0; offset < beat.text.length; offset++) {
          this.identities.bind(`s${serial++}`, identityAt(text, start + offset));
        }
      }
      for (const beat of beats) this.addBeat(beat.id, beat.lengthSeconds);
    }, "seed");
  }

  insert(beat: string, offset: number, value: string, names: readonly string[], marks: CollabMarks = {}): void {
    if (names.length !== value.length) throw new Error("One notation per UTF-16 character is required");
    this.doc.transact(() => {
      const { text, start, end } = this.locate(beat);
      if (offset < 0 || start + offset > end) throw new Error(`Offset outside ${beat}`);
      text.insert(start + offset, value, marks);
      names.forEach((name, index) => this.identities.bind(name, identityAt(text, start + offset + index)));
    }, this.localOrigin);
  }

  deleteIdentities(names: readonly string[]): void {
    const wanted = new Set(names.map(name => {
      const identity = this.identities.identity(name);
      return `${identity.client}:${identity.clock}`;
    }));
    const locations = this.characters().filter(character => wanted.has(`${character.identity.client}:${character.identity.clock}`));
    this.doc.transact(() => {
      for (const character of locations.reverse()) character.text.delete(character.index, 1);
    }, this.localOrigin);
  }

  format(beat: string, offset: number, length: number, marks: CollabMarks): void {
    this.doc.transact(() => {
      const { text, start } = this.locate(beat);
      text.format(start + offset, length, marks);
    }, this.localOrigin);
  }

  split(beat: string, offset: number, newBeat: string, name: string): void {
    this.doc.transact(() => {
      const { text, start } = this.locate(beat);
      text.insertEmbed(start + offset, { b: newBeat }, {});
      this.identities.bind(name, identityAt(text, start + offset));
      this.addBeat(newBeat);
    }, this.localOrigin);
  }

  remove(beatId: string, removalId: string, by: string, observed?: readonly CollabIdentity[]): void {
    this.doc.transact(() => {
      const beat = mapValue(this.doc.getMap("beats").get(beatId));
      mapValue(beat.get("removals")).set(removalId, true);
      const record = new Y.Map<unknown>();
      this.doc.getMap("removalRecords").set(removalId, record);
      record.set("kind", "beat");
      record.set("by", by);
      record.set("at", 0);
      record.set("beat", beatId);
      record.set("observed", (observed ?? this.characters().filter(character => character.beat === beatId).map(character => character.identity)).map(identity => ({ ...identity, len: 1 })));
      record.set("atoms", []);
      record.set("components", []);
    }, this.localOrigin);
  }

  restore(beatId: string, removalId: string): void {
    this.doc.transact(() => {
      mapValue(mapValue(this.doc.getMap("beats").get(beatId)).get("removals")).delete(removalId);
    }, this.localOrigin);
  }

  join(from: string, into: string, id: string): void {
    this.doc.transact(() => {
      const left = this.locate(into);
      const right = this.locate(from);
      const glue = left.end > left.start && right.end > right.start ? " " : "";
      mapValue(mapValue(this.doc.getMap("beats").get(from)).get("joins")).set(id, { into, glue });
    }, this.localOrigin);
  }

  undoManager(): Y.UndoManager {
    const scopes: Y.AbstractType<unknown>[] = this.candidate === "A"
      ? [this.doc.getText("flow") as Y.AbstractType<unknown>]
      : [this.doc.getMap("segments") as Y.AbstractType<unknown>];
    scopes.push(this.doc.getMap("beats") as Y.AbstractType<unknown>);
    return new Y.UndoManager(scopes, { trackedOrigins: new Set([this.localOrigin]), captureTimeout: 1000 });
  }

  captureUndoIdentities(names: readonly string[]): UndoIdentityAnchor[] {
    return names.map(notation => {
      const identity = this.identities.identity(notation);
      const character = this.characters().find(item => item.identity.client === identity.client && item.identity.clock === identity.clock);
      if (!character) throw new Error(`Cannot capture absent identity ${notation}`);
      return { notation, position: Y.createRelativePositionFromTypeIndex(character.text, character.index, 0) };
    });
  }

  bindUndoRestores(anchors: readonly UndoIdentityAnchor[]): void {
    for (const anchor of anchors) {
      const position = Y.createAbsolutePositionFromRelativePosition(anchor.position, this.doc, true);
      if (!position || !(position.type instanceof Y.Text)) throw new Error(`Undo did not restore ${anchor.notation}`);
      const identity = identityAt(position.type, position.index);
      const original = this.identities.identity(anchor.notation);
      if (identity.client === original.client && identity.clock === original.clock) throw new Error(`Undo reused ${anchor.notation}`);
      this.identities.bind(`${anchor.notation}*`, identity);
    }
  }

  destroy(): void {
    this.doc.destroy();
  }
}
