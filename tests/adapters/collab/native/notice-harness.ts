import assert from "node:assert/strict";
import * as Y from "yjs";
import { tagStack } from "../../../../src/core/text/runs.ts";
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

function witness(copy: NoticeTestSession) {
  return readNativeOnce(declareNativeRoots(copy.ydoc), reader => {
    const names = new Map(reader.outline().flatMap(entry => entry.kind === "heading" ? [[entry.id, entry.name] as const] : []));
    return reader.rankedOrder().map(block =>
      block.kind === "beat" ? { id: block.id, kind: block.kind, beat: reader.noticeBeat(block.id) } :
        { id: block.id, kind: block.kind, name: names.get(block.id) });
  });
}

type Reading = ReturnType<typeof witness>;

export function noticeCommandWitness() {
  const backwards: Reading[] = [], forwards: Reading[] = [];
  return (copy: NoticeTestSession, command: NoticeHistoryCommand, ids: Map<string, string>, play = playNoticeCommand) => {
    const before = witness(copy), outcome = play(copy, command, ids), after = witness(copy);
    const key = (id: string) => ids.get(id) ?? id;
    const at = (reading: Reading, id: string, kind: "beat" | "heading" = "beat") =>
      reading.findIndex(block => block.kind === kind && block.id === key(id));
    const beat = (reading: Reading, id: string) => reading[at(reading, id)]?.beat;
    const name = (reading: Reading, id: string) => reading[at(reading, id, "heading")]?.name;
    const cell = (reading: Reading, id: string, field: "audio" | "visual") =>
      beat(reading, id)?.[field === "audio" ? "narration" : field] ?? [];
    const text = (reading: Reading, id: string, field: "audio" | "visual" | "name") =>
      field === "name" ? name(reading, id) : cell(reading, id, field).map(run => run.text).join("");
    const message = "issued " + command.op + " " + JSON.stringify(command);
    switch (command.op) {
      case "type":
      case "erase": {
        const old = need(text(before, command.id, command.field), "old text");
        const from = command.op === "type" ? command.at : command.from;
        const to = command.op === "type" ? command.at : command.to;
        const insert = command.op === "type" ? command.value : "";
        if (command.field !== "name") assert.ok(beat(after, command.id), message);
        assert.equal(text(after, command.id, command.field), old.slice(0, from) + insert + old.slice(to), message);
        break;
      }
      case "mark": {
        assert.equal(text(after, command.id, command.field), text(before, command.id, command.field), message);
        const tag = "t:prop:" + command.key.slice(2).toLowerCase();
        const shown = cell(after, command.id, command.field).flatMap(run =>
          Array.from({ length: run.text.length }, () => command.key === "b" ? run.marks.b === true : tagStack(run.marks).includes(tag)));
        assert.deepEqual(shown.slice(command.from, command.to), Array.from({ length: command.to - command.from }, () => true), message);
        break;
      }
      case "field":
      case "detail": {
        const field = command.op === "field" ? "status" : command.key;
        const expected = command.op === "field" && command.value === "filmed" ? "shot" : command.value;
        assert.deepEqual(beat(after, command.id)?.fields[field], expected, message);
        break;
      }
      case "split": {
        const old = need(text(before, command.id, "audio"), "parent text");
        assert.equal(text(after, command.id, "audio"), old.slice(0, command.at), message);
        assert.equal(text(after, command.created, "audio"), old.slice(command.at), message);
        assert.equal(at(after, command.created), at(after, command.id) + 1, message);
        break;
      }
      case "insert":
        assert.equal(text(after, command.created, "audio"), command.value, message);
        assert.equal(at(after, command.created) + 1, at(after, command.before), message);
        break;
      case "rows": {
        const selected = new Set(command.ids.map(key));
        for (const block of before) if (block.beat && (selected.has(block.id) || selected.has(block.beat.row))) {
          assert.equal(at(after, block.id), -1, message);
        }
        break;
      }
      case "scene": {
        const start = at(before, command.id, "heading"), end = before.findIndex((block, index) => index > start && block.kind === "heading");
        assert.ok(start >= 0, message);
        assert.equal(at(after, command.id, "heading"), -1, message);
        for (const block of before.slice(start + 1, end === -1 ? undefined : end)) assert.equal(at(after, block.id), -1, message);
        break;
      }
      case "heading":
        assert.ok(at(before, command.id, "heading") >= 0, message);
        assert.equal(at(after, command.id, "heading"), -1, message);
        break;
      case "create":
        assert.equal(name(after, command.id), command.value, message);
        assert.equal(at(after, command.id, "heading") + 1, at(after, command.above), message);
        break;
      case "join":
        assert.deepEqual(beat(after, command.id)?.joined, { into: before[at(before, command.id) - 1]?.id, glue: " " }, message);
        break;
      case "unjoin":
        assert.equal(beat(after, command.id)?.joined, null, message);
        break;
      case "move":
        assert.ok(at(after, command.after) >= 0, message);
        assert.equal(at(after, command.id), at(after, command.after) + 1, message);
        break;
      case "undo":
      case "redo": {
        const [from, to] = command.op === "undo" ? [backwards, forwards] : [forwards, backwards];
        assert.deepEqual(after, need(from.pop(), "preceding edit"), message);
        to.push(before);
        return outcome;
      }
    }
    if (outcome.kind === "written") {
      backwards.push(before);
      forwards.length = 0;
    }
    return outcome;
  };
}
