import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import * as Y from "yjs";
import { deleteNativeRows } from "../../src/native-delete/delete.ts";
import { NativeHeadingReplica } from "../../src/native/headings.ts";
import { joinUp } from "../../src/native/rows.ts";
import type { NativeDeltaItem, NativeField } from "../../src/native/variant.ts";
import { blocks, need, visible } from "./model.ts";
import type { DeleteCommand, Marker, StoredReading, VisibleEntry } from "./model.ts";

export class DeleteReplica extends NativeHeadingReplica {
  constructor(client: number) {
    super(client, "flag");
    this.keepCreated = false;
  }

  insertBeat(before: string, id: string, value: string): void {
    const segment = this.block(before).segment;
    this.transact(() => {
      this.addSegment(`seg-b-${id}`, { b: id }, [{ text: value, marks: {} }], this.order.toArray().indexOf(segment));
      const record = new Y.Map<unknown>();
      this.beats.set(id, record);
      record.set("status", "new");
      this.visuals.set(id, new Y.Text());
    });
  }
}

const marker = ({ id, kind }: Marker): Record<string, string> => ({ [kind]: id });
const field = (name: "audio" | "visual"): NativeField => name === "audio" ? "audioText" : "visualText";
export const plain = (delta: readonly NativeDeltaItem[]): string => delta.map(item => {
  if (typeof item.insert !== "string") throw new Error("Unexpected visible embed");
  return item.insert;
}).join("");

export function seed(stored: StoredReading): DeleteReplica {
  const replica = new DeleteReplica(900);
  replica.doc.transact(() => {
    for (const [id, data] of Object.entries(stored.segments)) {
      const record = new Y.Map<unknown>(), text = new Y.Text();
      replica.segments.set(id, record);
      if (data.head) record.set("head", marker(data.head));
      record.set("text", text);
      let at = 0;
      for (const token of data.units) {
        if (typeof token === "string") text.insert(at, token);
        else text.insertEmbed(at, marker(token));
        at += typeof token === "string" ? token.length : 1;
      }
    }
    replica.order.push(stored.order);
    for (const [id, data] of Object.entries(stored.beats)) {
      const record = new Y.Map<unknown>();
      replica.beats.set(id, record);
      for (const [key, value] of Object.entries(data)) record.set(key, value);
    }
    for (const [id, value] of Object.entries(stored.visuals)) replica.visuals.set(id, new Y.Text(value));
    for (const [id, data] of Object.entries(stored.headings)) {
      const record = new Y.Map<unknown>();
      replica.headings.set(id, record);
      for (const [key, value] of Object.entries(data)) record.set(key, value);
    }
  }, "hydration");
  return replica;
}

export function load(bytes: Uint8Array, client: number): DeleteReplica {
  const replica = new DeleteReplica(client);
  Y.applyUpdate(replica.doc, bytes, "remote");
  return replica;
}

export function exchange(left: DeleteReplica, right: DeleteReplica): void {
  const leftBytes = left.encode(), rightBytes = right.encode();
  Y.applyUpdate(left.doc, rightBytes, "remote");
  Y.applyUpdate(right.doc, leftBytes, "remote");
}

function readMarker(value: unknown): Marker {
  if (value && typeof value === "object") {
    if ("b" in value && typeof value.b === "string") return { kind: "b", id: value.b };
    if ("h" in value && typeof value.h === "string") return { kind: "h", id: value.h };
  }
  throw new Error("Unexpected stored marker");
}

export function readStored(replica: DeleteReplica): StoredReading {
  return {
    order: replica.order.toArray(),
    segments: Object.fromEntries([...replica.segments].map(([id, record]) => {
      const head = record.get("head"), text = record.get("text") as Y.Text | undefined;
      const units = ((text?.toDelta() ?? []) as NativeDeltaItem[]).flatMap<string | Marker>(item =>
        typeof item.insert === "string" ? [...item.insert] : [readMarker(item.insert)]);
      return [id, { head: head === undefined ? null : readMarker(head), units }];
    })),
    beats: Object.fromEntries([...replica.beats].map(([id, record]) => [id, record.toJSON()])),
    visuals: Object.fromEntries([...replica.visuals].map(([id, text]) => [id, text.toString()])),
    headings: Object.fromEntries([...replica.headings].map(([id, record]) => [id, record.toJSON()]))
  };
}

export function readVisible(replica: DeleteReplica): VisibleEntry[] {
  return replica.outline().map(entry => {
    if (entry.kind === "heading") return { heading: entry.id, name: plain(entry.name) };
    const { id, members, audio, visual, fields } = entry.row;
    const status = fields.status;
    return { id, members, audio: plain(audio), visual: plain(visual), ...typeof status === "string" && { status } };
  });
}

export function readStyles(replica: DeleteReplica): unknown {
  return {
    segments: Object.fromEntries([...replica.segments].map(([id, record]) => [id, (record.get("text") as Y.Text).toDelta()])),
    visuals: Object.fromEntries([...replica.visuals].map(([id, cell]) => [id, cell.toDelta()]))
  };
}

export function check(replica: DeleteReplica, alternatives: readonly StoredReading[]): StoredReading {
  const actual = readStored(replica);
  const expected = alternatives.find(option => isDeepStrictEqual(actual, option));
  if (!expected) assert.deepEqual(actual, alternatives[0], "stored state");
  const accepted = need(expected, "expected state");
  assert.deepEqual(readVisible(replica), visible(accepted), "visible outline");
  const expectedBlocks = blocks(accepted);
  assert.deepEqual(replica.headingRecovery().map(entry => [entry.id, plain(entry.name)]),
    expectedBlocks.filter(block => block.kind === "h" && accepted.headings[block.id]?.removed).map(block => [block.id, block.text]),
    "headings in recovery");
  const placed = new Set(expectedBlocks.filter(block => block.kind === "b").map(block => block.id));
  assert.deepEqual(Object.fromEntries(replica.recovery().map(entry => {
    assert.equal(entry.reason, "unplaced");
    return [entry.beat, plain(entry.visualItems)];
  })), Object.fromEntries(Object.entries(accepted.visuals).filter(([id, value]) => value && !placed.has(id))), "unplaced visual text");
  for (const { kind, id, text, from, to } of expectedBlocks) {
    if (kind === "h") {
      const heading = replica.block(id, "h");
      assert.deepEqual([heading.start, heading.end, plain(heading.delta)], [from, to, text], `heading edit route for ${id}`);
      continue;
    }
    const cell = replica.cell(id, "audioText");
    const units = (cell.text.toDelta() as NativeDeltaItem[]).flatMap<unknown>(part =>
      typeof part.insert === "string" ? [...part.insert] : [part.insert]);
    assert.equal(units.slice(cell.start, cell.end).join(""), text, `narration edit route for ${id}`);
    assert.equal(replica.cell(id, "visualText").text.toString(), accepted.visuals[id], `visual edit route for ${id}`);
  }
  return accepted;
}

export function write(replica: DeleteReplica, command: DeleteCommand, empty: "keep" | "drop"): void {
  switch (command.op) {
    case "rows": deleteNativeRows(replica, { rows: command.ids }, empty); break;
    case "scene": deleteNativeRows(replica, { scene: command.id }, empty); break;
    case "heading": deleteNativeRows(replica, { heading: command.id, removal: command.removal }, empty); break;
    case "type":
      if (command.field === "name") replica.typeHeading(command.id, command.at, command.value);
      else replica.splice(command.id, field(command.field), command.at, command.at, [{ text: command.value, marks: {} }]);
      break;
    case "erase":
      if (command.field === "name") replica.deleteHeadingText(command.id, command.from, command.to);
      else replica.splice(command.id, field(command.field), command.from, command.to, []);
      break;
    case "mark": replica.format(command.id, field(command.field), command.from, command.to, { [command.key]: true }); break;
    case "field": replica.setField(command.id, "status", command.value); break;
    case "split": replica.split(command.id, command.at, command.created, { status: "new" }); break;
    case "insert": replica.insertBeat(command.before, command.created, command.value); break;
    case "join": assert.equal(joinUp(replica, command.id), true); break;
    case "unjoin": replica.unjoin(command.id); break;
    case "create": replica.createHeading(command.above, command.id, command.value); break;
  }
}

export function checkMark(replica: DeleteReplica, command: DeleteCommand): void {
  if (command.op !== "mark") return;
  const cell = replica.cell(command.id, field(command.field));
  const marks = (cell.text.toDelta() as NativeDeltaItem[]).flatMap(part =>
    Array.from({ length: typeof part.insert === "string" ? part.insert.length : 1 }, () => part.attributes?.[command.key] === true));
  assert.deepEqual(marks.slice(cell.start + command.from, cell.start + command.to), Array(command.to - command.from).fill(true), "marked characters");
}
