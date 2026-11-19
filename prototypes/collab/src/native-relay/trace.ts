import assert from "node:assert/strict";
import { messageYjsSyncStep2 } from "y-protocols/sync";
import * as Y from "yjs";
import type { RelayPacket } from "./relay.ts";

type Range = { client: number; clock: number; length: number };
type Coverage = { clock: Range[]; deleted: Range[] };
type RecordedWrite = { label: string; update: Uint8Array; coverage: Coverage };

function coverage(update: Uint8Array): Coverage {
  const { structs, ds } = Y.decodeUpdate(update);
  return {
    clock: structs.filter(item => !(item instanceof Y.Skip)).map(({ id, length }) => ({ ...id, length })),
    deleted: [...ds.clients].flatMap(([client, ranges]) => ranges.map(({ clock, len }) => ({ client, clock, length: len })))
  };
}

function covers(actual: Range[], expected: Range[]) {
  return expected.every(range => {
    let cursor = range.clock;
    const end = range.clock + range.length;
    for (const span of actual) {
      if (span.client === range.client && span.clock <= cursor) cursor = Math.max(cursor, span.clock + span.length);
      if (cursor >= end) return true;
    }
    return false;
  });
}

export function recordWrites() {
  const writes: RecordedWrite[] = [];
  return {
    writes,
    command(doc: Y.Doc, labels: readonly string[], run: () => void, origins?: readonly unknown[]) {
      const updates: { update: Uint8Array; origin: unknown }[] = [];
      const read = (update: Uint8Array, origin: unknown) => { updates.push({ update, origin }); };
      doc.on("update", read);
      try { run(); } finally { doc.off("update", read); }
      assert.equal(updates.length, labels.length, labels.join("+"));
      if (origins) assert.deepEqual(updates.map(item => item.origin), origins);
      for (const [index, label] of labels.entries()) {
        const entry = updates[index];
        assert(entry);
        writes.push({ label, update: entry.update, coverage: coverage(entry.update) });
      }
      return updates.map(item => item.update);
    }
  };
}

export function scanPackets(packets: RelayPacket[], writes: RecordedWrite[], expected: readonly string[]) {
  const seen = new Set<string>();
  const violations: string[] = [];
  const frames = packets.map(packet => {
    const exact = writes.find(write => Buffer.from(write.update).equals(packet.payload));
    const match = () => {
      const actual = coverage(packet.payload);
      return writes.filter(write => covers(actual.clock, write.coverage.clock) && covers(actual.deleted, write.coverage.deleted));
    };
    const labels = (exact ? [exact] : match()).map(write => write.label);
    const fresh = labels.filter(label => !seen.has(label));
    const next = expected.filter(label => !seen.has(label)).slice(0, fresh.length);
    if (fresh.some(label => !next.includes(label))) violations.push(`${fresh.join("+")} before ${next.join("+")}`);
    for (const label of labels) seen.add(label);
    return { kind: packet.type === messageYjsSyncStep2 ? "state" : "update", labels, fresh };
  });
  return { frames, violations, missing: expected.filter(label => !seen.has(label)) };
}

export function relayTagKey(scheme: "plain" | "per-application" | "per-action") {
  return scheme === "plain" ? "t:T1" : "t:T1\u001f2.0";
}

export function tagDelta(key: string, tagged = true, value = "vr") {
  return tagged ? [{ insert: value, attributes: { [key]: true } }] : [{ insert: value }];
}

export function tagText(doc: Y.Doc) {
  const text = doc.getMap<Y.Text>("cells").get("tagged");
  assert(text instanceof Y.Text);
  return text;
}

export function addTagText(doc: Y.Doc, value = "vr", attributes = {}) {
  const text = new Y.Text();
  doc.getMap<Y.Text>("cells").set("tagged", text);
  text.insert(0, value, attributes);
}

export function seedTagHistory(value = "vr") {
  const seed = new Y.Doc();
  try {
    seed.clientID = 900;
    addTagText(seed, value);
    return Y.encodeStateAsUpdate(seed);
  } finally { seed.destroy(); }
}

export function pressUndo(manager: Y.UndoManager) {
  assert(manager.undo());
}

export function tagWriter(doc: Y.Doc, key = relayTagKey("per-application"), length = 2) {
  const text = tagText(doc);
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set(["writer"]), captureTimeout: 0 });
  return {
    undo,
    format() { doc.transact(() => { text.format(0, length, { [key]: true }); }, "writer"); },
    back() { pressUndo(undo); },
    forward() { assert(undo.redo()); }
  };
}
