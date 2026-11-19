import assert from "node:assert/strict";
import * as Y from "yjs";
import { deleteNativeRows } from "../../src/native-delete/delete.ts";
import { MoveReplica, betweenRanks } from "../../src/native-moves/ranks.ts";
import { joinUp } from "../../src/native/rows.ts";
import { plainNoticeText, type NoticeReading } from "../../src/native-notice/compare.ts";
import { readNotice } from "../../src/native-notice/yjs.ts";
import { seed } from "../native-delete/kit.ts";
import type { StoredReading } from "../native-delete/model.ts";
import type { Step } from "./histories.ts";

export function replicaFrom(bytes: Uint8Array, client: number): MoveReplica {
  const replica = new MoveReplica(client, "flat");
  replica.keepCreated = false;
  Y.applyUpdate(replica.doc, bytes, "remote");
  return replica;
}

export function rankedSeed(initial: StoredReading): MoveReplica {
  const unranked = seed(initial);
  const replica = replicaFrom(unranked.encode(), 901);
  replica.initializeRanks();
  unranked.destroy();
  return replica;
}

export function deliver(from: MoveReplica, to: MoveReplica): void {
  Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
}

function insertBefore(replica: MoveReplica, before: string, id: string, value: string): void {
  const blocks = replica.blocks(), at = blocks.findIndex(block => block.kind === "b" && block.id === before);
  function rank(index: number): string | null {
    const block = blocks[index];
    if (!block) return null;
    return (block.kind === "b" ? replica.beats : replica.headings).get(block.id)?.get("e10Rank") as string;
  }
  const key = betweenRanks(rank(at - 1), rank(at), replica.doc.clientID, 0);
  replica.transact(() => {
    const segment = new Y.Map<unknown>(), record = new Y.Map<unknown>();
    segment.set("head", { b: id });
    segment.set("text", new Y.Text(value));
    replica.segments.set("seg-b-" + id, segment);
    replica.order.push(["seg-b-" + id]);
    record.set("status", "new");
    record.set("e10Rank", key);
    replica.beats.set(id, record);
    replica.visuals.set(id, new Y.Text());
  });
}

export function write(replica: MoveReplica, command: Extract<Step, { person: number }>["command"]): void {
  replica.undo.stopCapturing();
  switch (command.op) {
    case "rows": deleteNativeRows(replica, { rows: command.ids }); break;
    case "scene": deleteNativeRows(replica, { scene: command.id }); break;
    case "heading": deleteNativeRows(replica, { heading: command.id, removal: command.removal }); break;
    case "type":
      if (command.field === "name") replica.typeHeading(command.id, command.at, command.value);
      else replica.splice(command.id, command.field === "audio" ? "audioText" : "visualText", command.at, command.at,
        [{ text: command.value, marks: {} }]);
      break;
    case "erase":
      if (command.field === "name") replica.deleteHeadingText(command.id, command.from, command.to);
      else replica.splice(command.id, command.field === "audio" ? "audioText" : "visualText", command.from, command.to, []);
      break;
    case "mark":
      replica.format(command.id, command.field === "audio" ? "audioText" : "visualText", command.from, command.to, { [command.key]: true });
      break;
    case "field": replica.setField(command.id, "status", command.value); break;
    case "split": replica.split(command.id, command.at, command.created, { status: "new" }); break;
    case "insert": insertBefore(replica, command.before, command.created, command.value); break;
    case "join": assert.equal(joinUp(replica, command.id), true); break;
    case "unjoin": replica.unjoin(command.id); break;
    case "create": replica.createHeading(command.above, command.id, command.value); break;
    case "undo":
    case "redo": assert.ok(replica.undo[command.op](), "one standard undo or redo step"); break;
    case "move": assert.equal(replica.moveRefs("b:" + command.id, "b:" + command.id, "b:" + command.after), true); break;
    case "detail": replica.setField(command.id, command.key, command.value); break;
  }
  replica.undo.stopCapturing();
}

export function rowText(reading: NoticeReading, field: "narration" | "visual", id: string): string | undefined {
  const row = reading.find(beat => beat.id === id);
  return row && plainNoticeText(row[field]);
}

export function assertConverged(copies: readonly MoveReplica[]): NoticeReading {
  const source = copies[0];
  assert.ok(source);
  const first = readNotice(source);
  for (const copy of copies.slice(1)) {
    assert.deepEqual(readNotice(copy), first);
    assert.deepEqual(copy.doc.toJSON(), source.doc.toJSON());
  }
  const late = replicaFrom(source.encode(), 999);
  try {
    assert.deepEqual(readNotice(late), first);
    assert.deepEqual(late.doc.toJSON(), source.doc.toJSON());
  } finally {
    late.destroy();
  }
  return first;
}
