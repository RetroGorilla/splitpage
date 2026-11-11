import * as Y from "yjs";
import { createSharedDocument, applySharedUpdate, encodeSharedState, destroySharedDocument, transactSharedDocument } from "../../../../src/adapters/collab/document.ts";
import { createSharedAnchor, resolveSharedAnchor } from "../../../../src/adapters/collab/anchors.ts";
import { collabState } from "../../../../src/adapters/collab/state.ts";
import type { SharedDocumentHandle } from "../../../../src/adapters/collab/types.ts";
import { hydrateSharedDocument } from "../../../../src/adapters/collab/hydrate.ts";
import { typingMarks } from "../../../../src/core/text/edits.ts";
import type { Marks, Run } from "../../../../src/core/text/runs.ts";
import { validatedFixture, deliveryReplica } from "../helpers.ts";
import type { IdentityBook } from "../../../collab/checker.ts";
import type { CollabIdentity } from "../../../collab/checker.ts";
import type { DeliveryReplica } from "../../../collab/delivery.ts";
import { makeScratchEvent, readScratchEvent, readScratchAnchored, sameScratchMark, scratchEventKey, scratchMarkCode, scratchMarkOutput } from "./events.ts";
import type { ScratchBorn, ScratchMark, ScratchMarkEvent } from "./events.ts";

export type ScratchDesign = "attributes" | "records";
export interface ScratchCommand {
  readonly id: string;
  readonly kind: "add" | "remove" | "insert" | "delete";
  readonly from: number;
  readonly to: number;
  readonly mark?: ScratchMark;
  readonly text?: string;
  readonly mode?: "inherit" | "plain" | "marked";
  readonly marks?: readonly ScratchMark[];
}
export interface ScratchCharacter { readonly identity: CollabIdentity; readonly value: string; readonly marks: readonly ScratchMark[] }
type Contribution = { key: string; event: ScratchMarkEvent; from: number; to: number };

export class ScratchReplica {
  readonly handle: SharedDocumentHandle;
  readonly text: Y.Text;
  readonly events: Y.Map<unknown>;
  formatItems = 0;
  attributeWrites = 0;
  readonly writtenKeys = new Set<string>();
  readonly design: ScratchDesign;

  constructor(design: ScratchDesign, client: number, initial?: string, state?: Uint8Array) {
    this.design = design;
    this.handle = createSharedDocument();
    const { doc } = collabState(this.handle);
    doc.clientID = client;
    doc.on("beforeObserverCalls", transaction => {
      const update = Y.decodeUpdate(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(transaction.beforeState)));
      this.formatItems += update.structs.filter(item => item instanceof Y.Item && item.content instanceof Y.ContentFormat).length;
      if (design === "records" && this.formatItems !== 0) throw new Error("Design 2 created a formatting item");
    });
    if (state) {
      if (!applySharedUpdate(this.handle, state).ok) throw new Error("Invalid fixture state");
    } else hydrateSharedDocument(this.handle, validatedFixture({ rows: [{ id: "R1", audioText: initial ?? "" }] }));
    const segment = collabState(this.handle).roots.segments.get("b:R1");
    if (!(segment instanceof Y.Map)) throw new Error("Missing segment");
    const text: unknown = segment.get("text");
    if (!(text instanceof Y.Text)) throw new Error("Missing text");
    this.text = text;
    if (!state && design === "records") transactSharedDocument(this.handle, "local-command", () => segment.set("markRecords", new Y.Map<unknown>()));
    const events: unknown = segment.get("markRecords");
    this.events = design === "records" && events instanceof Y.Map ? events : new Y.Map<unknown>();
  }

  queuePort(): DeliveryReplica<Uint8Array> { return deliveryReplica(this.handle); }
  state(): Uint8Array { return encodeSharedState(this.handle); }
  destroy(): void { destroySharedDocument(this.handle); }

  identity(index: number): CollabIdentity {
    const id = Y.createRelativePositionFromTypeIndex(this.text, index).item;
    if (!id) throw new Error("Missing text identity");
    return { client: id.client, clock: id.clock };
  }

  contributions(): Contribution[] {
    const result: Contribution[] = [];
    if (this.design === "records") {
      for (const key of [...this.events.keys()].sort()) {
        const record = readScratchAnchored(key, this.events.get(key));
        if (!record) continue;
        const start = resolveSharedAnchor(this.handle, record.start), end = resolveSharedAnchor(this.handle, record.end);
        if (start !== "gone" && end !== "gone" && start.segment === "b:R1" && end.segment === "b:R1" && end.offset > start.offset) {
          result.push({ key, event: record.event, from: start.offset, to: end.offset });
        }
      }
    } else {
      let offset = 0;
      for (const delta of this.text.toDelta()) {
        const insert: unknown = delta.insert, length = typeof insert === "string" ? insert.length : 1;
        const attributes = (delta.attributes ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(attributes).sort()) {
          const event = readScratchEvent(key, attributes[key]);
          if (event) result.push({ key, event, from: offset, to: offset + length });
        }
        offset += length;
      }
    }
    return result;
  }

  read(): ScratchCharacter[] {
    const contributions = this.contributions(), result: ScratchCharacter[] = [];
    const value = this.text.toDelta().map((delta: { insert: unknown }) => typeof delta.insert === "string" ? delta.insert : "\uFFFC").join("");
    for (let index = 0; index < value.length; index++) {
      const identity = this.identity(index), relevant = contributions.filter(item => item.from <= index && item.to > index && bornContains(item.event.born, identity));
      const excluded = new Set(relevant.filter(item => item.event.type !== "add").flatMap(item => [...item.event.observed]));
      const marks = new Map<string, ScratchMark>();
      for (const item of relevant) if (item.event.type === "add" && item.event.mark && !excluded.has(item.key)) {
        marks.set(scratchMarkCode(item.event.mark), scratchMarkOutput(item.event.mark));
      }
      result.push({ identity, value: value.charAt(index), marks: [...marks.keys()].sort().map(key => marks.get(key) as ScratchMark) });
    }
    return result;
  }

  readNamed(book: IdentityBook) {
    return this.read().map(character => ({ id: book.notation(character.identity), value: character.value, marks: character.marks }));
  }

  private write(event: ScratchMarkEvent, from: number, to: number): void {
    const key = scratchEventKey(event);
    if (this.writtenKeys.has(key)) throw new Error("A command rewrote an event key");
    this.writtenKeys.add(key);
    if (this.design === "attributes") {
      this.attributeWrites++;
      this.text.format(from, to - from, { [key]: event });
    } else {
      const start = createSharedAnchor(this.handle, "b:R1", from, "after"), end = createSharedAnchor(this.handle, "b:R1", to, "before");
      if (!start || !end) throw new Error("Missing event anchor");
      this.events.set(key, { event, start, end });
    }
  }

  execute(command: ScratchCommand): void {
    const { from, to } = command;
    if (from < 0 || to < from || to > this.text.length) throw new Error("Command outside text");
    const contributions = this.contributions(), present = this.read();
    const allAdds = [...new Set(contributions.filter(item => item.event.type === "add").map(item => item.key))].sort();
    transactSharedDocument(this.handle, "local-command", () => {
      if (command.kind === "delete") { this.text.delete(from, to - from); return; }
      if (command.kind === "insert") {
        const text = command.text ?? "", marks = command.mode === "inherit" ? inheritedMarks(present, from) : command.marks ?? [];
        // why: Passing explicit attributes resets other commands' keys; inherited insertion leaves those keys alone.
        this.text.insert(from, text);
        if (!text.length) return;
        const first = this.identity(from), last = this.identity(from + text.length - 1);
        if (first.client !== last.client || last.clock !== first.clock + text.length - 1) throw new Error("Noncontiguous inserted identity range");
        const born = { client: first.client, clock: first.clock, length: text.length };
        let observed = allAdds;
        if (this.design === "records") {
          const after = this.contributions(), inserted = this.read();
          observed = after.filter(item => item.event.type === "add" && additionVisible(item, after, inserted, from, from + text.length)).map(item => item.key);
        }
        this.write(makeScratchEvent("birth", command.id, null, [...new Set(observed)].sort(), born), from, from + text.length);
        marks.forEach((mark, index) => this.write(makeScratchEvent("add", command.id + ":" + index, mark, [], born), from, from + text.length));
        return;
      }
      if (!command.mark) throw new Error("Missing command mark");
      if (command.kind === "add") this.write(makeScratchEvent("add", command.id, command.mark), from, to);
      else {
        const observed = contributions.filter(item => item.event.type === "add" && item.event.mark && sameScratchMark(item.event.mark, command.mark as ScratchMark)
          && item.from < to && item.to > from && additionVisible(item, contributions, present, from, to)).map(item => item.key);
        this.write(makeScratchEvent("remove", command.id, { ...command.mark, value: null }, [...new Set(observed)].sort()), from, to);
      }
    });
  }
}

function bornContains(born: ScratchBorn | null, identity: CollabIdentity): boolean {
  return born === null || born.client === identity.client && born.clock <= identity.clock && identity.clock < born.clock + born.length;
}

function additionVisible(item: Contribution, all: readonly Contribution[], characters: readonly ScratchCharacter[], from: number, to: number): boolean {
  for (let index = Math.max(from, item.from); index < Math.min(to, item.to); index++) {
    const character = characters[index];
    if (!character || !bornContains(item.event.born, character.identity)) continue;
    if (!all.some(other => other.from <= index && other.to > index && other.event.type !== "add" && bornContains(other.event.born, character.identity) && other.event.observed.includes(item.key))) return true;
  }
  return false;
}

function inheritedMarks(characters: readonly ScratchCharacter[], offset: number): ScratchMark[] {
  const runs: Run[] = characters.map(character => {
    const marks: Marks = {};
    for (const mark of character.marks) if (!("id" in mark) && mark.value === true) marks[mark.kind] = true;
    return { text: character.value, marks };
  });
  return Object.entries(typingMarks(runs, offset)).flatMap(([kind, value]) => value === true ? [{ kind: kind as "b", value: true as const }] : []);
}
