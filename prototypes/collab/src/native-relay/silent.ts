import assert from "node:assert/strict";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { openLink } from "./link.ts";
import { openCopy, openRelay, until } from "./relay.ts";
import { recordWrites, relayTagKey, scanPackets, seedTagHistory, tagDelta, tagText, tagWriter } from "./trace.ts";
import { StateFirstProvider } from "./state-first.ts";

export async function silentReconnect(window?: number, wrapped = false) {
  const arrivals: { type: number; payload: Uint8Array; at: number }[] = [];
  const applied: Uint8Array[] = [];
  let serverDoc: Y.Doc | undefined;
  const server = await openRelay({
    async onLoadDocument() { return seedTagHistory("v"); },
    async afterLoadDocument({ document }) { serverDoc = document; },
    async beforeSync({ type, payload, connection }) {
      if (new URL(connection.request.url).searchParams.has("writer") && type !== 0) arrivals.push({ type, payload, at: performance.now() });
    },
    async onChange({ update }) { applied.push(update); }
  });
  try {
    const link = await openLink(server.address.port);
    try {
      const writer = openCopy(`${link.url}/?writer`, 2, window ? { messageReconnectTimeout: window } : {},
        undefined, wrapped ? { Provider: StateFirstProvider } : {});
      const reader = openCopy(server.webSocketURL, 1);
      try {
        const key = relayTagKey("per-application");
        const delta = (doc: Y.Doc) => tagText(doc).toDelta() as unknown;
        await syncCopies();
        const actions = tagWriter(writer.doc, key, 1);
        try {
          const tape = recordWrites();
          const [original] = tape.command(writer.doc, ["tag"], actions.format);
          assert(original);
          tape.writes.length = 0;
          await until(() => JSON.stringify(delta(reader.doc)) === JSON.stringify(tagDelta(key, true, "v")) &&
            !writer.provider.hasUnsyncedChanges, "tag acknowledged before silence");
          const offset = arrivals.length, integrated = applied.length, signals = writer.signals.length;
          const start = performance.now();
          link.silence();
          tape.command(writer.doc, ["undo"], actions.back);
          assert.equal(writer.status(), "connected");
          await until(() => writer.closeEvents.length, "watchdog", Math.ceil((window ?? 30_000) * 1.4 + 2_000));
          const first = writer.closeEvents[0];
          assert.equal(first?.code, 4408);
          assert.equal(writer.provider.synced, true);
          assert.equal(writer.signals.slice(signals).some(event => event.name === "close"), false);
          assert.equal(arrivals.length, offset);
          assert.deepEqual(delta(reader.doc), tagDelta(key, true, "v"));
          const [redo] = tape.command(writer.doc, ["redo"], actions.forward);
          assert(redo);
          await until(() => arrivals.length >= offset + (wrapped ? 1 : 2), "reconnect state reply");
          const late = openCopy(server.webSocketURL, 4);
          try {
            late.connect();
            await until(() => late.provider.synced && !late.provider.hasUnsyncedChanges, "silent-link late join");
            assert(serverDoc);
            const expected = tagDelta(key, wrapped, "v");
            await until(() => [serverDoc, writer.doc, reader.doc, late.doc].every(doc => doc &&
              JSON.stringify(delta(doc)) === JSON.stringify(expected)), "expected tag on every copy");
            const observed = arrivals.slice(offset);
            const scan = scanPackets(observed, tape.writes, ["undo", "redo"]);
            assert.deepEqual(observed.map(packet => packet.type), wrapped ? [messageYjsSyncStep2] : [messageYjsUpdate, messageYjsSyncStep2]);
            assert.deepEqual(scan.frames.map(frame => frame.labels), wrapped ? [["undo", "redo"]] : [["redo"], ["undo", "redo"]]);
            assert.deepEqual(scan.violations, wrapped ? [] : ["redo before undo"]);
            const formatStart = (update: Uint8Array) => Y.decodeUpdate(update).structs.find(item => item instanceof Y.Item &&
              item.content instanceof Y.ContentFormat && item.content.key === key && item.content.value === true);
            const removed = (update: Uint8Array, item: Y.Item) => Y.decodeUpdate(update).ds.clients.get(item.id.client)?.some(range =>
              range.clock <= item.id.clock && item.id.clock < range.clock + range.len) === true;
            if (!wrapped) {
              const existing = formatStart(original), replacement = formatStart(redo);
              const [appliedRedo, cleanup, appliedUndo] = applied.slice(integrated);
              assert(existing instanceof Y.Item && replacement instanceof Y.Item && appliedRedo && cleanup && appliedUndo);
              assert.deepEqual(formatStart(appliedRedo)?.id, replacement.id);
              assert.equal(removed(cleanup, replacement), true);
              assert.equal(removed(appliedUndo, existing), true);
            }
            assert(first && observed[0]);
            return { silentMs: first.at - start, code: first.code, redoLeadMs: observed[1] ? observed[1].at - observed[0].at : null,
              frames: scan.frames, appliedUpdates: applied.length - integrated,
              events: writer.signals.slice(signals).map(event => [event.name, event.synced, event.count]),
              final: delta(writer.doc) };
          } finally { late.close(); }
        } finally { actions.undo.destroy(); }
      } finally { writer.close(); reader.close(); }
      async function syncCopies() {
        reader.connect();
        writer.connect();
        await until(() => [reader, writer].every(copy => copy.provider.synced && !copy.provider.hasUnsyncedChanges), "initial silent-link copies");
      }
    } finally { await link.close(); }
  } finally { await server.destroy(); }
}
