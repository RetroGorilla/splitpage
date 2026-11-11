import { createMonitoredSharedDocument as createSharedDocument } from "../helpers.ts";
import * as Y from "yjs";
import { applySharedUpdate, encodeSharedState, destroySharedDocument, transactSharedDocument } from "../../../../src/adapters/collab/document.ts";
import { collabState } from "../../../../src/adapters/collab/state.ts";
import { hydrateSharedDocument } from "../../../../src/adapters/collab/hydrate.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord, readSharedMarkCharacters } from "../../../../src/adapters/collab/mark-store.ts";
import type { SharedMarkBirth } from "../../../../src/adapters/collab/mark-record.ts";
import type { SharedMarkValue, SharedTextAddress } from "../../../../src/core/collab/operations.ts";
import { readMarkChange } from "../../../../src/core/collab/read-operation.ts";
import { typingMarks } from "../../../../src/core/text/edits.ts";
import type { Marks } from "../../../../src/core/text/runs.ts";
import { validatedFixture, deliveryReplica } from "../helpers.ts";
import type { IdentityBook, CollabIdentity } from "../../../collab/checker.ts";

export interface MarkTraceCommand {
  readonly id: string; readonly kind: "add" | "remove" | "insert" | "delete"; readonly from: number; readonly to: number;
  readonly mark?: SharedMarkValue; readonly text?: string; readonly mode?: "inherit" | "plain" | "marked"; readonly marks?: readonly SharedMarkValue[];
}
export const markTraceKinds = Object.freeze(["b", "i", "u", "s", "hl", "dir", "cue", "comment", "tag", "link"] as const);
export function markTraceExample(kind: typeof markTraceKinds[number]): SharedMarkValue {
  const mark = readMarkChange({ kind: "mark", id: "example", by: "", target: { owner: "R1", segment: "b:R1", field: "audioText" }, observed: [],
    mark: kind === "comment" ? { kind, id: "C", value: true } : kind === "tag" ? { kind, id: "T", value: "P" } : kind === "link" ? { kind, id: "L", value: "https://x" } : { kind, value: true } })?.mark;
  if (!mark) throw new Error("Invalid example mark");
  return mark;
}

export class MarkTraceReplica {
  readonly handle = createSharedDocument();
  readonly text: Y.Text;
  readonly target: SharedTextAddress;
  constructor(client: number, initial?: string, state?: Uint8Array) {
    collabState(this.handle).doc.clientID = client;

    if (state) { if (!applySharedUpdate(this.handle, state).ok) throw new Error("Invalid fixture state"); }
    else hydrateSharedDocument(this.handle, validatedFixture({ rows: [{ id: "R1", audioText: initial ?? "" }] }));
    const operation = readMarkChange({ kind: "mark", id: "target", by: "", target: { owner: "R1", segment: "b:R1", field: "audioText" }, observed: [], mark: { kind: "b", value: true } });
    if (!operation) throw new Error("Invalid target");
    this.target = operation.target;
    const segment = collabState(this.handle).roots.segments.get("b:R1");
    if (!(segment instanceof Y.Map)) throw new Error("Missing segment");
    const text: unknown = segment.get("text");
    if (!(text instanceof Y.Text)) throw new Error("Missing text");
    this.text = text;
  }
  queuePort() { return deliveryReplica(this.handle); }
  state(): Uint8Array { return encodeSharedState(this.handle); }
  destroy(): void { destroySharedDocument(this.handle); }
  identity(index: number): CollabIdentity {
    const identity = Y.createRelativePositionFromTypeIndex(this.text, index).item;
    if (!identity) throw new Error("Missing identity");
    return { client: identity.client, clock: identity.clock };
  }
  read() {
    const characters = readSharedMarkCharacters(this.handle, this.target);
    if (!characters) throw new Error("Missing text");
    return characters.map(char => ({ identity: char.identity, value: char.value, marks: char.marks.flatMap(group => group.values.map(value => group.id === null
      ? { kind: group.kind, value } as SharedMarkValue : { kind: group.kind, id: group.id, value } as SharedMarkValue))
      .sort((a, b) => code(a) < code(b) ? -1 : code(a) > code(b) ? 1 : 0) }));
  }
  readNamed(book: IdentityBook) { return this.read().map(char => ({ id: book.notation(char.identity), value: char.value, marks: char.marks })); }
  execute(command: MarkTraceCommand): void {
    const { from, to } = command;
    const before = readSharedMarkCharacters(this.handle, this.target);
    if (!before) throw new Error("Missing text");
    const write = (id: string, start: number, end: number, change: Parameters<typeof prepareSharedMarkRecord>[5]): void => {
      const record = prepareSharedMarkRecord(this.handle, this.target, id, start, end, change);
      if (!record || !writeSharedMarkRecord(this.handle, this.target, id, record).ok) throw new Error("Mark write refused");
    };
    transactSharedDocument(this.handle, "local-command", () => {
      if (command.kind === "delete") { this.text.delete(from, to - from); return; }
      if (command.kind === "insert") {
        const text = command.text ?? "", runs = before.map(char => ({ text: char.value, marks: Object.fromEntries(char.marks.filter(group => group.id === null).map(group => [group.kind, true])) as Marks }));
        const marks = command.mode === "inherit" ? Object.keys(typingMarks(runs, from)).map(kind => markTraceExample(kind as "b")) : command.marks ?? [];
        this.text.insert(from, text);
        if (!text.length) return;
        const first = this.identity(from), born: SharedMarkBirth = { client: first.client, clock: first.clock, length: text.length };
        const after = readSharedMarkCharacters(this.handle, this.target);
        const observed = [...new Set(after?.slice(from, from + text.length).flatMap(char => char.marks.flatMap(group => group.additions.map(add => add.record))))].sort();
        write(command.id, from, from + text.length, { type: "birth", observed, born });
        marks.forEach((mark, index) => write(command.id + ":" + index, from, from + text.length, { type: "add", mark, born }));
      } else if (command.mark) {
        if (command.kind === "add") write(command.id, from, to, { type: "add", mark: command.mark });
        else {
          const mark = command.mark;
          const observed = [...new Set(before.slice(from, to).flatMap(char => char.marks.filter(group => group.kind === mark.kind && group.id === ("id" in mark ? mark.id : null)).flatMap(group => group.additions.map(add => add.record))))].sort();
          write(command.id, from, to, { type: "remove", observed });
        }
      }
    });
  }
}
function code(mark: SharedMarkValue): string { return JSON.stringify([mark.kind, "id" in mark ? mark.id : null, mark.value]); }
