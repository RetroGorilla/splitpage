import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { loopback, openLink } from "../../src/native-relay/link.ts";
import { openCopy, openRelay, readSyncFrame, until } from "../../src/native-relay/relay.ts";
import type { RelayPacket } from "../../src/native-relay/relay.ts";
import { addTagText, pressUndo, recordWrites, relayTagKey, scanPackets, seedTagHistory, tagDelta, tagText, tagWriter } from "../../src/native-relay/trace.ts";

const key = relayTagKey("per-application");
type TextSpan = { insert: string; attributes?: Record<string, unknown> };
const delta = (doc: Y.Doc) => tagText(doc).toDelta() as TextSpan[];
const tagged = (doc: Y.Doc) => delta(doc).some(part => part.attributes?.[key] === true);
const assertDeltas = (docs: Y.Doc[], expected = tagDelta(key)) => {
  for (const doc of docs) assert.deepEqual(delta(doc), expected);
};
type Copy = ReturnType<typeof openCopy>;

async function usingRelay(run: (kit: ReturnType<typeof createRig>) => Promise<void>, seed?: Uint8Array, flushDelay?: false) {
  const rig = createRig(seed, flushDelay);
  try { await rig.start(); await run(rig); } finally { await rig.close(); }
}

function createRig(initial = seedTagHistory(), flushDelay?: false) {
  let saved = initial;
  let server: Awaited<ReturnType<typeof openRelay>>;
  let document: Y.Doc;
  let stores = 0;
  let loads = 0;
  const copies = new Set<Copy>();
  const links: Awaited<ReturnType<typeof openLink>>[] = [];
  const upstream: (RelayPacket & { name: string })[] = [];
  return {
    upstream,
    get document() { return document; },
    get stores() { return stores; },
    get loads() { return loads; },
    get port() { return server.address.port; },
    async start() {
      server = await openRelay({
        ...(flushDelay === false ? { flushDelay } : {}),
        async onLoadDocument() { loads++; return saved; },
        async afterLoadDocument({ document: loaded }) { document = loaded; },
        async onStoreDocument({ document: current }) { saved = Y.encodeStateAsUpdate(current); stores++; },
        async beforeSync({ connection, type, payload }) {
          if (type === messageYjsSyncStep2 || type === messageYjsUpdate) {
            upstream.push({ type, payload, name: new URL(connection.request.url).searchParams.get("copy") ?? "" });
          }
        }
      });
    },
    async link() {
      const link = await openLink(server.address.port);
      links.push(link);
      return link;
    },
    copy(id: number, url = server.webSocketURL, doc?: Y.Doc) {
      const copy = openCopy(`${url}/?copy=${id}`, id, {}, doc);
      copies.add(copy);
      copy.connect();
      return copy;
    },
    remove(copy: Copy) { copies.delete(copy); copy.close(); },
    stop() { return server.destroy(); },
    async close() {
      try { for (const copy of copies) copy.close(); }
      finally {
        try { await Promise.all(links.map(link => link.close())); }
        finally { await server?.destroy(); }
      }
    }
  };
}

function synced(...copies: Copy[]) {
  return until(() => copies.every(copy => copy.provider.synced && !copy.provider.hasUnsyncedChanges), "initial sync and positive status");
}

function marks(t: TestContext, copy: Copy, from = 0) {
  const events = copy.signals.slice(from);
  t.diagnostic(`signals ${copy.doc.clientID} ${events.map((event, index) => {
    if (event.name !== "pending") return `${event.name}(${Number(event.synced)},${event.count})`;
    return events.length <= 45 || index < 9 || index >= events.length - 9 ? `${event.count}` : "";
  }).filter(Boolean).join(" ")} [${events.length} events, ${events.filter(e => e.name === "pending" && e.count === 0).length} zeros]`);
}

function report(t: TestContext, name: string, scan: ReturnType<typeof scanPackets>) {
  const frames = scan.frames.map(frame => `${frame.kind === "state" ? "S" : "U"}:${frame.labels.join("+") || "-"}`);
  t.diagnostic(`${name} ${frames.length} frames ${frames.join(" ")}${scan.violations.length ? `; ${scan.violations.join(", ")}` : ""}`);
}

function healthy(t: TestContext, name: string, packets: RelayPacket[], tape: ReturnType<typeof recordWrites>, order: string[]) {
  const scan = scanPackets(packets, tape.writes, order);
  report(t, name, scan);
  assert.deepEqual(scan.missing, [], `${name} missing writes`);
  assert.deepEqual(scan.violations, [], `${name} order`);
  return scan;
}

async function tagStart(writer: Copy, readers: Copy[], value = "vr") {
  await synced(writer, ...readers);
  const actions = tagWriter(writer.doc, key, value.length);
  try {
    actions.format();
    await until(() => readers.every(reader => tagged(reader.doc)) && !writer.provider.hasUnsyncedChanges, "starting tag on both sides");
    assertDeltas([writer.doc, ...readers.map(reader => reader.doc)], tagDelta(key, true, value));
    return actions;
  } catch (error) {
    actions.undo.destroy();
    throw error;
  }
}

test("control: E3b loses the tag on every raw copy only in reversed delivery", t => {
  let used = 0, effective = 0, failed = 0;
  for (const scheme of ["plain", "per-application", "per-action"] as const) {
    for (const delivery of ["forward", "merged", "reverse"] as const) {
      const [a, writer, c] = [1, 2, 3].map(id => {
        const doc = new Y.Doc();
        doc.clientID = id;
        Y.applyUpdate(doc, seedTagHistory());
        return doc;
      }) as [Y.Doc, Y.Doc, Y.Doc];
      const selected = relayTagKey(scheme);
      const actions = tagWriter(writer, selected);
      try {
        actions.format();
        for (const peer of [a, c]) Y.applyUpdate(peer, Y.encodeStateAsUpdate(writer), "remote");
        assertDeltas([a, writer, c], tagDelta(selected));
        const tape = recordWrites();
        const undo = tape.command(writer, ["undo"], actions.back);
        const redo = tape.command(writer, ["redo"], actions.forward);
        assertDeltas([writer], tagDelta(selected));
        const cleanup: Uint8Array[] = [];
        c.on("update", (update, origin) => { if (origin === null) cleanup.push(update); });
        const batch = [...undo, ...redo];
        const sent = delivery === "merged" ? [Y.mergeUpdates(batch)] : delivery === "reverse" ? [...redo, ...undo] : batch;
        for (const update of sent) Y.applyUpdate(c, update, "remote");
        for (const update of [...cleanup, ...batch]) Y.applyUpdate(a, update, "remote");
        for (const dst of [a, writer, c]) Y.applyUpdate(dst, Y.encodeStateAsUpdate(c), "remote");
        if (delivery === "reverse") {
          used++;
          assert.equal(cleanup.length, 1);
          effective++;
          for (const doc of [a, writer, c]) assert.notDeepEqual(delta(doc), tagDelta(selected));
          assertDeltas([a, writer, c], tagDelta(selected, false));
          failed++;
        } else {
          assert.equal(cleanup.length, 0);
          assertDeltas([a, writer, c], tagDelta(selected));
        }
      } finally { actions.undo.destroy(); a.destroy(); writer.destroy(); c.destroy(); }
    }
  }
  assert.deepEqual({ used, effective, failed }, { used: 3, effective: 3, failed: 3 });
  t.diagnostic(`raw reverse used/effective/failed ${used}/${effective}/${failed}`);
});

test("steady undo and redo, immediate undo-redo, fast formatting, and a late join", async t => {
  await usingRelay(async kit => {
    const writer = kit.copy(2), a = kit.copy(1), c = kit.copy(3);
    const actions = await tagStart(writer, [a, c]);
    try {
      const remote = [kit.document, a.doc, c.doc];
      const offsets = [kit.upstream.length, writer.incoming.length, a.incoming.length, c.incoming.length];
      const tape = recordWrites();
      tape.command(writer.doc, ["u1"], actions.back);
      await until(() => remote.every(doc => !tagged(doc)), "steady undo");
      assertDeltas([...remote, writer.doc], tagDelta(key, false));
      tape.command(writer.doc, ["r1"], actions.forward);
      await until(() => remote.every(tagged), "steady redo");
      tape.command(writer.doc, ["u2"], actions.back);
      tape.command(writer.doc, ["r2"], actions.forward);
      const text = writer.doc.getText("typing");
      const order = ["u1", "r1", "u2", "r2"];
      for (const [index, letter] of [..."format"].entries()) {
        const label = `k${index + 1}`;
        order.push(label);
        tape.command(writer.doc, [label], () => text.insert(index, letter, index < 3 ? {} : { b: true }));
      }
      const bold = [{ insert: "for" }, { insert: "mat", attributes: { b: true } }];
      await until(() => remote.every(doc => doc.getText("typing").length === 6) && !writer.provider.hasUnsyncedChanges, "burst tail");
      const late = kit.copy(4);
      await synced(late);
      assertDeltas([...remote, writer.doc, late.doc]);
      for (const doc of [...remote, writer.doc, late.doc]) assert.deepEqual(doc.getText("typing").toDelta(), bold);
      const server = healthy(t, "server", kit.upstream.slice(offsets[0]).filter(p => p.name === "2"), tape, order);
      assert.deepEqual(server.frames.flatMap(frame => frame.fresh), order);
      assert.equal(server.frames.length, order.length);
      for (const [index, peer] of [writer, a, c].entries()) {
        healthy(t, `peer ${peer.doc.clientID}`, peer.incoming.slice(offsets[index + 1]), tape, order);
        marks(t, peer);
      }
      const lateScan = healthy(t, "late", late.incoming, tape, order);
      assert.equal(lateScan.frames.filter(frame => frame.fresh.length).length, 1);
      assert.equal(lateScan.frames.find(frame => frame.fresh.length)?.kind, "state");
      marks(t, late);
    } finally { actions.undo.destroy(); }
  });
});

async function droppedUndo(t: TestContext, flushDelay?: false) {
  const value = "v";
  const before = tagDelta(key, true, value), after = tagDelta(key, false, value);
  await usingRelay(async kit => {
    const link = await kit.link();
    const writer = kit.copy(2, link.url), a = kit.copy(1), c = kit.copy(3);
    const actions = await tagStart(writer, [a, c], value);
    try {
      const offsets = [kit.upstream.length, writer.incoming.length, a.incoming.length, c.incoming.length];
      const tape = recordWrites();
      const release = link.hold("upload");
      tape.command(writer.doc, ["undo"], actions.back);
      assertDeltas([writer.doc], after);
      link.cut();
      release();
      await until(() => writer.closeEvents.length, "drop with unsent undo");
      assert.equal(writer.provider.synced, false);
      assert.equal(writer.provider.unsyncedChanges, 1);
      assertDeltas([a.doc, c.doc], before);
      tape.command(writer.doc, ["redo"], actions.forward);
      assertDeltas([writer.doc], before);
      await until(() => writer.provider.synced && kit.upstream.slice(offsets[0]).some(packet => packet.name === "2" && packet.type === messageYjsSyncStep2), "automatic reconnect and upload step 2");
      const late = kit.copy(4);
      await synced(late);
      const order = ["undo", "redo"];
      const scan = scanPackets(kit.upstream.slice(offsets[0]).filter(p => p.name === "2"), tape.writes, order);
      report(t, "reconnect server", scan);
      for (const [index, peer] of [writer, a, c].entries()) {
        const read = () => scanPackets(peer.incoming.slice(offsets[index + 1]), tape.writes, order);
        await until(() => read().missing.length === 0, "both reconnect writes received");
        report(t, `reconnect peer ${peer.doc.clientID}`, read());
        marks(t, peer);
      }
      healthy(t, "reconnect late", late.incoming, tape, order);
      assertDeltas([kit.document, writer.doc, a.doc, c.doc, late.doc], after);
      assert.equal(link.connections, 2);
      assert.deepEqual(scan.missing, []);
      assert.deepEqual(scan.violations, ["redo before undo"]);
    } finally { actions.undo.destroy(); }
  }, seedTagHistory(value), flushDelay);
}

test("default reconnect sends redo before a lost undo and the tag disappears", t => droppedUndo(t));
test("disabling server batching still sends redo before a lost undo", t => droppedUndo(t, false));

async function offline(copy: Copy, link: Awaited<ReturnType<typeof openLink>>) {
  const before = copy.closeEvents.length;
  link.cut();
  await until(() => copy.closeEvents.length > before && !copy.provider.synced, "ordinary close");
  copy.socket.disconnect();
}

test("a long offline queue returns, and two writers return together", async t => {
  for (const together of [false, true]) await usingRelay(async kit => {
    const link1 = await kit.link(), link2 = await kit.link();
    const writer = kit.copy(2, link1.url), other = kit.copy(3, link2.url), reader = kit.copy(1);
    const actions = await tagStart(writer, [other, reader]);
    try {
      await offline(writer, link1);
      if (together) await offline(other, link2);
      const start = kit.upstream.length;
      const signalStart = writer.signals.length;
      const offsets = [writer.incoming.length, other.incoming.length, reader.incoming.length];
      const tape = recordWrites();
      const order = ["undo", "redo"];
      tape.command(writer.doc, ["undo"], actions.back);
      tape.command(writer.doc, ["redo"], actions.forward);
      const typed = "abcdefghijklmnopqrstuvwxyz".repeat(3);
      for (const [index, letter] of [...typed].entries()) {
        const label = `k${index + 1}`;
        order.push(label);
        tape.command(writer.doc, [label], () => writer.doc.getText("typing").insert(index, letter));
      }
      const otherTape = recordWrites();
      const otherOrder = ["n1", "n2"];
      otherTape.command(other.doc, ["n1"], () => other.doc.getText("other").insert(0, "other"));
      otherTape.command(other.doc, ["n2"], () => other.doc.getText("other").insert(5, " side"));
      assert.equal(writer.provider.unsyncedChanges, 80);
      assert.equal(writer.doc.getText("other").length, 0);
      assert.equal(reader.doc.getText("typing").length, 0);
      if (!together) await until(() => reader.doc.getText("other").length === 10, "online writer reached reader");
      if (!together && process.env.SPLITPAGE_E13_LONG_OFFLINE === "1") {
        await delay(70_000);
        assert.equal(writer.status(), "disconnected");
        assert.equal(writer.provider.unsyncedChanges, 80);
        t.diagnostic("kept the 80 writes offline for 70 seconds before reconnecting");
      }
      writer.connect();
      if (together) other.connect();
      const docs = [kit.document, writer.doc, other.doc, reader.doc];
      await until(() => docs.every(doc => doc.getText("typing").length === 78 && doc.getText("other").length === 10) &&
        kit.upstream.slice(start).some(packet => packet.name === "2" && packet.type === messageYjsSyncStep2) &&
        (!together || kit.upstream.slice(start).some(packet => packet.name === "3" && packet.type === messageYjsSyncStep2)), "offline tails and state replies");
      await synced(writer, other, reader);
      assertDeltas(docs);
      for (const doc of docs) {
        assert.equal(doc.getText("typing").toString(), typed);
        assert.equal(doc.getText("other").toString(), "other side");
      }
      const inbound = kit.upstream.slice(start);
      const writerServer = healthy(t, "offline writer to server", inbound.filter(p => p.name === "2"), tape, order);
      assert.equal(writerServer.frames.filter(frame => frame.kind === "update").length, 80);
      const otherServer = healthy(t, "other writer to server", inbound.filter(p => p.name === "3"), otherTape, otherOrder);
      assert.equal(otherServer.frames.filter(frame => frame.kind === "update").length, 2);
      for (const [index, copy] of [writer, other, reader].entries()) {
        await until(() => {
          const packets = copy.incoming.slice(offsets[index]);
          return scanPackets(packets, tape.writes, order).missing.length === 0 &&
            scanPackets(packets, otherTape.writes, otherOrder).missing.length === 0;
        }, "both writers covered on the wire");
        const packets = copy.incoming.slice(offsets[index]);
        healthy(t, `offline writer to ${copy.doc.clientID}`, packets, tape, order);
        healthy(t, `other writer to ${copy.doc.clientID}`, packets, otherTape, otherOrder);
        marks(t, copy, copy === writer ? signalStart : 0);
      }
    } finally { actions.undo.destroy(); }
  });
});

test("restart stores through the stock hook and a rehydrated writer sends one state difference", async t => {
  await usingRelay(async kit => {
    const link = await kit.link();
    const old = kit.copy(2, link.url), reader = kit.copy(1);
    const actions = await tagStart(old, [reader]);
    try {
      await offline(old, link);
      const tape = recordWrites();
      tape.command(old.doc, ["undo"], actions.back);
      tape.command(old.doc, ["redo"], actions.forward);
      tape.command(old.doc, ["typed"], () => old.doc.getText("typing").insert(0, "restart"));
      const state = Y.encodeStateAsUpdate(old.doc);
      kit.remove(reader);
      await kit.stop();
      assert.equal(kit.stores, 1);
      assert.equal(kit.loads, 1);
      await kit.start();
      link.retarget(kit.port);
      const late = kit.copy(4);
      await synced(late);
      assert.equal(kit.loads, 2);
      assertDeltas([kit.document, late.doc]);
      assert.equal(late.doc.getText("typing").length, 0);
      const offset = late.incoming.length;
      const stateDoc = new Y.Doc();
      Y.applyUpdate(stateDoc, state);
      const writer = kit.copy(5, link.url, stateDoc);
      const start = kit.upstream.length;
      await until(() => late.doc.getText("typing").length === 7 && !writer.provider.hasUnsyncedChanges, "restarted rejoin");
      const docs = [kit.document, writer.doc, late.doc, old.doc];
      assertDeltas(docs);
      for (const doc of docs) assert.equal(doc.getText("typing").toString(), "restart");
      const order = ["undo", "redo", "typed"];
      const scan = healthy(t, "restart server", kit.upstream.slice(start).filter(p => p.name === "5"), tape, order);
      assert.deepEqual(scan.frames.map(frame => [frame.kind, frame.fresh]), [["state", order]]);
      healthy(t, "restart reader", late.incoming.slice(offset), tape, order);
      await until(() => scanPackets(writer.incoming, tape.writes, order).missing.length === 0, "restart writer echo");
      healthy(t, "restart writer", writer.incoming, tape, order);
      marks(t, writer);
      marks(t, late);
    } finally { actions.undo.destroy(); }
  });
});

test("synced remains true with a remote edit in transit and with unsent typing", async t => {
  await usingRelay(async kit => {
    const link = await kit.link();
    const writer = kit.copy(2, link.url), reader = kit.copy(1);
    await synced(writer, reader);
    const down = link.hold("download");
    reader.doc.getText("other").insert(0, "theirs");
    await until(() => kit.document.getText("other").length === 6 && !reader.provider.hasUnsyncedChanges, "their edit reached relay");
    assert.equal(writer.doc.getText("other").length, 0);
    assert.equal(writer.provider.synced, true);
    assert.equal(writer.provider.hasUnsyncedChanges, false);
    down();
    await until(() => writer.doc.getText("other").length === 6, "remote edit released");
    const up = link.hold("upload");
    writer.doc.getText("typing").insert(0, "mine");
    assert.equal(writer.provider.synced, true);
    assert.equal(writer.provider.hasUnsyncedChanges, true);
    assert.equal(kit.document.getText("typing").length, 0);
    await offline(writer, link);
    up();
    assert.equal(writer.provider.hasUnsyncedChanges, true);
    assert.equal(writer.provider.synced, false);
    assert.equal(writer.doc.getText("typing").toString(), "mine");
    const start = kit.upstream.length;
    writer.connect();
    await until(() => reader.doc.getText("typing").length === 4 && !writer.provider.hasUnsyncedChanges, "lost send recovered by Step2");
    assert.equal(reader.doc.getText("typing").toString(), "mine");
    assert.deepEqual(kit.upstream.slice(start).filter(p => p.name === "2").map(p => p.type), [messageYjsSyncStep2]);
    marks(t, writer);
    marks(t, reader);
  });
});

test("a single press sends both the undo update and the null-origin formatting cleanup", async t => {
  const [seed, a, b, writer] = [900, 1, 2, 3].map(id => {
    const doc = new Y.Doc();
    doc.clientID = id;
    return doc;
  }) as [Y.Doc, Y.Doc, Y.Doc, Y.Doc];
  const cell = (doc: Y.Doc) => doc.getText("double");
  const manager = new Y.UndoManager(cell(writer), { trackedOrigins: new Set(["writer"]), captureTimeout: 0 });
  try {
    addTagText(seed, "vr", { [key]: true });
    cell(seed).insert(0, "xy");
    const start = Y.encodeStateAsUpdate(seed);
    for (const doc of [a, b, writer]) {
      Y.applyUpdate(doc, start, "remote");
      cell(doc).observe(event => { void event.delta; });
    }
    const tape = recordWrites();
    const deliver = (updates: Uint8Array[], doc: Y.Doc) => {
      for (const update of updates) Y.applyUpdate(doc, update, "remote");
    };
    const mos = tape.command(b, ["mos"], () => cell(b).insert(0, "mos", {}));
    deliver(mos, writer);
    deliver(tape.command(writer, ["o"], () => cell(writer).insert(4, "o", { b: true })), a);
    const format = tape.command(writer, ["format"], () => writer.transact(() => cell(writer).format(0, 4, { b: true }), "writer"));
    const mou = tape.command(a, ["mou"], () => cell(a).insert(1, "mou", {}));
    deliver(format, a);
    deliver(mou, writer);
    deliver(mos, a);
    deliver(tape.command(a, ["l"], () => cell(a).insert(4, "l", {})), writer);
    const before = [{ insert: "mosx", attributes: { b: true } }, { insert: "l" }, { insert: "mouo", attributes: { b: true } }, { insert: "y" }];
    const after = [{ insert: "mosxl" }, { insert: "mouo", attributes: { b: true } }, { insert: "y" }];
    const style = (doc: Y.Doc) => (cell(doc).toDelta() as TextSpan[]).flatMap(part =>
      [...part.insert].map(letter => [letter, part.attributes?.b === true]));
    const expectedStyle = (parts: typeof before | typeof after) =>
      parts.flatMap(part => [...part.insert].map(letter => [letter, part.attributes?.b === true]));
    assert.deepEqual(style(writer), expectedStyle(before));
    await usingRelay(async kit => {
      const active = kit.copy(3, undefined, writer), reader = kit.copy(4);
      await synced(active, reader);
      assert.deepEqual(style(reader.doc), expectedStyle(before));
      const upstream = kit.upstream.length, peer = reader.incoming.length, own = active.incoming.length;
      const press = recordWrites();
      const order = ["undo", "cleanup"];
      press.command(writer, order, () => pressUndo(manager), [manager, null]);
      await until(() => [reader.incoming.slice(peer), active.incoming.slice(own)].every(packets =>
        scanPackets(packets, press.writes, order).missing.length === 0) && !active.provider.hasUnsyncedChanges, "two-part press fanout");
      for (const doc of [writer, reader.doc, kit.document]) assert.deepEqual(style(doc), expectedStyle(after));
      assertDeltas([writer, reader.doc, kit.document]);
      const server = healthy(t, "two-part undo server", kit.upstream.slice(upstream).filter(p => p.name === "3"), press, order);
      assert.deepEqual(server.frames.map(frame => frame.labels), [["undo"], ["cleanup"]]);
      healthy(t, "two-part undo writer", active.incoming.slice(own), press, order);
      healthy(t, "two-part undo reader", reader.incoming.slice(peer), press, order);
      marks(t, active);
    }, Y.encodeStateAsUpdate(writer));
  } finally { manager.destroy(); for (const doc of [a, b, seed, writer]) doc.destroy(); }
});

async function swappingLink(serverUrl: string) {
  const server = new WebSocketServer({ host: loopback, port: 0 });
  const sockets = new Set<WebSocket>();
  const held: Buffer[] = [];
  let armed = false;
  let swapped = 0;
  server.on("connection", client => {
    const upstream = new WebSocket(`${serverUrl}/?copy=2`);
    sockets.add(client);
    sockets.add(upstream);
    const queued: Buffer[] = [];
    for (const socket of [client, upstream]) {
      socket.on("error", () => socket.terminate());
      socket.once("close", () => sockets.delete(socket));
    }
    upstream.on("open", () => { for (const frame of queued) upstream.send(frame); });
    upstream.on("message", frame => { if (client.readyState === WebSocket.OPEN) client.send(frame); });
    client.on("message", data => {
      assert(Buffer.isBuffer(data));
      if (armed && readSyncFrame(data)?.type === messageYjsUpdate) {
        held.push(data);
        if (held.length === 2) {
          for (const frame of [...held].reverse()) upstream.send(frame);
          armed = false;
          swapped++;
        }
      } else if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else queued.push(data);
    });
  });
  await once(server, "listening");
  return {
    url: `ws://${loopback}:${(server.address() as AddressInfo).port}`,
    arm() { armed = true; },
    get used() { return held.length; },
    get effective() { return swapped; },
    async close() {
      const done = once(server, "close");
      server.close();
      await Promise.all([...sockets].map(async socket => {
        const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
        socket.terminate();
        await closed;
      }));
      await done;
    }
  };
}

test("control: two WebSocket frames swapped in transit are counted out of order", async t => {
  await usingRelay(async kit => {
    const bridge = await swappingLink(`ws://${loopback}:${kit.port}`);
    try {
      const writer = kit.copy(2, bridge.url), a = kit.copy(1);
      const actions = await tagStart(writer, [a]);
      try {
        const start = kit.upstream.length;
        const tape = recordWrites();
        bridge.arm();
        tape.command(writer.doc, ["undo"], actions.back);
        tape.command(writer.doc, ["redo"], actions.forward);
        await until(() => kit.upstream.length >= start + 2, "both swapped frames at server");
        const scan = scanPackets(kit.upstream.slice(start).filter(p => p.name === "2"), tape.writes, ["undo", "redo"]);
        report(t, "swap server", scan);
        assert.equal(bridge.used, 2);
        assert.equal(bridge.effective, 1);
        assert.deepEqual(scan.frames.map(frame => frame.labels), [["redo"], ["undo"]]);
        assert.deepEqual(scan.missing, []);
        assert.deepEqual(scan.violations, ["redo before undo"]);
        t.diagnostic(`swap used/effective/failed 1/${bridge.effective}/${scan.violations.length}`);
      } finally { actions.undo.destroy(); }
    } finally { await bridge.close(); }
  });
});
