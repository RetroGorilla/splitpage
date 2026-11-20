import assert from "node:assert/strict";
import * as Y from "yjs";
import { nativeInitialRank } from "../../../../src/adapters/collab/native/convert.ts";
import { readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSessionOptions } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { encodeNativeValue } from "../../../../src/adapters/collab/native/values.ts";
import { blocks, need } from "./notice-histories.ts";
import type { NoticeFixtureStoredReading, NoticeHistoryCommand } from "./notice-histories.ts";

type NoticeTestSession = ReturnType<typeof openNativeSession>;

export function noticeSeed(stored: NoticeFixtureStoredReading): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const roots = declareNativeRoots(doc), names = new Map<string, string>();
  doc.transact(() => {
    roots.order.push(stored.order);
    for (const key of stored.order) {
      const record = new Y.Map<unknown>(), cell = new Y.Text(), { head, units } = need(stored.segments[key], key);
      roots.segments.set(key, record);
      record.set("text", cell);
      if (head) record.set("head", { [head.kind]: head.id });
      let block = head;
      for (const unit of units) {
        if (typeof unit !== "string") {
          cell.insertEmbed(cell.length, { [unit.kind]: unit.id }, {});
          block = unit;
        } else if (block?.kind === "h") names.set(block.id, (names.get(block.id) ?? "") + unit);
        else cell.insert(cell.length, unit, {});
      }
    }
    for (const [index, { kind, id }] of blocks(stored).entries()) {
      const record = new Y.Map<unknown>(), cell = new Y.Text();
      if (kind === "b") {
        roots.beats.set(id, record);
        roots.visuals.set(id, cell);
        const { status, joined } = need(stored.beats[id], id);
        if (status) record.set("status", encodeNativeValue(status));
        if (joined) record.set("joined", joined);
        cell.insert(0, stored.visuals[id] ?? "", {});
      } else {
        roots.headings.set(id, record);
        roots.names.set(id, cell);
        if (stored.headings[id]?.removed) record.set("removed", true);
        cell.insert(0, names.get(id) ?? "", {});
      }
      record.set("rank", nativeInitialRank(index));
    }
  });
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

export function noticeCopy(state: Uint8Array, client: number, journal?: NativeSessionOptions["noticeJournal"]): NoticeTestSession {
  const copy = openNativeSession({ kind: "state", state }, { actor: "writer", sanitize: html => String(html),
    ...(journal === undefined ? {} : { noticeJournal: journal }) });
  copy.ydoc.clientID = client;
  return copy;
}

export function noticeDeliver(sender: NoticeTestSession, receiver: NoticeTestSession): void {
  Y.applyUpdate(receiver.ydoc, Y.encodeStateAsUpdate(sender.ydoc, Y.encodeStateVector(receiver.ydoc)), "peer");
}

export function noticeRange(copy: NoticeTestSession, beat: string, cell: NativeTextTarget["cell"], from: number, to = from) {
  const anchored = copy.commands.anchorText({ beat, cell }, from, to);
  assert.equal(anchored.kind, "anchored", JSON.stringify({ beat, cell, from, to, anchored }));
  return anchored.range;
}

export function playNoticeCommand(copy: NoticeTestSession, command: NoticeHistoryCommand, ids: Map<string, string>) {
  const commands = copy.commands, key = (id: string) => ids.get(id) ?? id;
  const read = <T>(fn: Parameters<typeof readNativeOnce<T>>[1]) => readNativeOnce(declareNativeRoots(copy.ydoc), fn);
  const range = (id: string, field: "audio" | "visual" | "name", from: number, to = from) =>
    noticeRange(copy, key(id), field === "audio" ? "narration" : field, from, to);
  const field = (name: string, id: string, value: unknown) =>
    commands.setField({ kind: "beat", id: key(id), field: name }, value);
  switch (command.op) {
    case "type": {
      if (command.field === "name") {
        const name = read(reader => reader.outline().find(entry => entry.kind === "heading" && entry.id === key(command.id)));
        assert.equal(name?.kind, "heading");
        return commands.renameHeading(range(command.id, "name", 0, name.name.length),
          name.name.slice(0, command.at) + command.value + name.name.slice(command.at));
      }
      return commands.replaceText(range(command.id, command.field, command.at), [{ text: command.value, marks: {} }]);
    }
    case "erase": {
      if (command.field === "name") {
        const name = read(reader => reader.outline().find(entry => entry.kind === "heading" && entry.id === key(command.id)));
        assert.equal(name?.kind, "heading");
        return commands.renameHeading(range(command.id, "name", 0, name.name.length), name.name.slice(0, command.from) + name.name.slice(command.to));
      }
      return commands.deleteText(range(command.id, command.field, command.from, command.to));
    }
    case "mark": return commands.formatText(range(command.id, command.field, command.from, command.to), command.key.startsWith("t:")
      ? { kind: "tag", id: "t:prop:" + command.key.slice(2).toLowerCase(), on: true } : { kind: "plain", mark: "b", on: true });
    case "field": return field("status", command.id, command.value === "filmed" ? "shot" : command.value);
    case "detail": return field(command.key, command.id, command.value);
    case "split": {
      const result = commands.splitRow(range(command.id, "audio", command.at));
      if (result.kind === "written") ids.set(command.created, result.created);
      return result;
    }
    case "insert": {
      const scene = read(reader => {
        const order = reader.rankedOrder(), at = order.findIndex(entry => entry.kind === "beat" && entry.id === key(command.before));
        return order.slice(0, at).findLast(entry => entry.kind === "heading")?.id ?? null;
      });
      const result = commands.putBack({
        id: command.created, narration: [{ text: command.value, marks: {} }], visual: [], fields: {},
        placement: { scene, left: null, right: key(command.before), sceneOrder: [command.created, key(command.before)] }
      });
      if (result.kind === "written") ids.set(command.created, result.created);
      return result;
    }
    case "rows": {
      const members = read(reader => command.ids.flatMap(id => reader.row(key(id))?.members ?? [key(id)]));
      return commands.removeRows(members);
    }
    case "scene": {
      const members = read(reader => {
        const outline = reader.outline(), at = outline.findIndex(entry => entry.kind === "heading" && entry.id === key(command.id));
        const end = outline.findIndex((entry, index) => index > at && entry.kind === "heading");
        return outline.slice(at + 1, end === -1 ? undefined : end).flatMap(entry => reader.row(entry.id)?.members ?? []);
      });
      assert.equal(commands.removeHeading(key(command.id)).kind, "written");
      return commands.removeRows(members);
    }
    case "heading": return commands.removeHeading(key(command.id));
    case "create": return commands.createHeading(range(command.above, "audio", 0), command.id, command.value);
    case "join": {
      const into = read(reader => {
        const order = reader.rankedOrder(), at = order.findIndex(entry => entry.kind === "beat" && entry.id === key(command.id));
        return order[at - 1]?.id;
      });
      return commands.joinRow(key(command.id), need(into, "join neighbour"), " ");
    }
    case "unjoin": return commands.unjoinRow(key(command.id));
    case "move": {
      const drop = read(reader => {
        const order = reader.rankedOrder(), at = order.findIndex(entry => entry.kind === "beat" && entry.id === key(command.after));
        return order[at + 1] ?? null;
      });
      return commands.moveBlocks([{ kind: "beat", id: key(command.id) }], drop);
    }
    case "undo": return commands.undo();
    case "redo": return commands.redo();
  }
}
