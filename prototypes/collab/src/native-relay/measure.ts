import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { openLink } from "./link.ts";
import { openCopy, openRelay, until } from "./relay.ts";

const limitBytes = 15_036_020;
const rates = [1, 2, 4, 10, 50];
const longWindow = 180_000;
const seconds = (ms: number) => Number((ms / 1_000).toFixed(3));
const copySummary = (copy: ReturnType<typeof openCopy>, start: number) => {
  const elapsed = (at: number) => seconds(at - start);
  const first = (name: string) => {
    const event = copy.signals.find(signal => signal.at >= start && signal.name === name);
    return event ? elapsed(event.at) : null;
  };
  return {
    connected: first("connect"), synced: first("synced"),
    zero: copy.signals.filter(event => event.at >= start && event.name === "pending" && event.count === 0)
      .slice(0, 3).map(event => elapsed(event.at)),
    disconnects: copy.closeEvents.filter(event => event.at >= start).map(event => ({
      ...event, at: elapsed(event.at)
    })),
    downloadedStep2: copy.incoming.filter(packet => packet.type === messageYjsSyncStep2).map(packet => packet.payload.length)
  };
};

async function download(path: string, rate: number | "direct", window: "default" | "provider" | "both") {
  let decoded = 0;
  const server = await openRelay({
    ...(window === "both" ? { timeout: longWindow } : {}),
    async onLoadDocument() {
      const state = await readFile(path);
      assert.equal(state.length, limitBytes);
      return state;
    },
    async afterLoadDocument() { decoded++; }
  });
  try {
    const link = rate === "direct" ? undefined : await openLink(server.address.port, rate);
    try {
      const copy = openCopy(link?.url ?? server.webSocketURL, 3, window === "default" ? {} : { messageReconnectTimeout: longWindow });
      try {
        const start = performance.now();
        const observingRetries = window === "default" && typeof rate === "number" && rate <= 4;
        copy.connect();
        await until(() => copy.incoming.some(packet => packet.payload.length === limitBytes) && copy.provider.synced ||
          observingRetries && copy.closeEvents.length >= 3 || window === "provider" && copy.closeEvents.length > 0,
        "full first sync or retry observation", observingRetries ? 159_000 : 170_000);
        const complete = copy.incoming.some(packet => packet.payload.length === limitBytes);
        if (complete) {
          assert.deepEqual(Buffer.from(Y.encodeStateAsUpdate(copy.doc)), await readFile(path));
          assert.equal(copy.doc.getMap("segments").size, 320);
        }
        return { rate: rate === Infinity ? "uncapped" : rate, window, complete,
          attempts: link?.connections ?? 1, decoded, downloadBytes: link?.bytes.download,
          elapsed: seconds(performance.now() - start), ...copySummary(copy, start) };
      } finally { copy.close(); }
    } finally { await link?.close(); }
  } finally { await server.destroy(); }
}

async function upload(rate: number, mb: number, mode: "queued" | "state", extended = false) {
  const arrivals: { type: number; bytes: number; at: number }[] = [];
  let observed: Y.Doc | undefined;
  const server = await openRelay({
    async afterLoadDocument({ document }) { observed = document; },
    async beforeSync({ type, payload }) {
      if (type !== 0) arrivals.push({ type, bytes: payload.length, at: performance.now() });
    }
  });
  try {
    const link = await openLink(server.address.port, rate);
    try {
      const base = openCopy(server.webSocketURL, 1);
      let writer = openCopy(link.url, 2, extended ? { messageReconnectTimeout: longWindow } : {});
      try {
        base.connect();
        writer.connect();
        await until(() => [base, writer].every(copy => copy.provider.synced && !copy.provider.hasUnsyncedChanges), "empty sync");
        link.cut();
        await until(() => writer.closeEvents.length, "offline");
        writer.socket.disconnect();
        const total = mb * 1_000_000;
        const expected = "x".repeat(total);
        const text = writer.doc.getText("offline");
        for (let offset = 0; offset < total; offset += 64_000) text.insert(offset, expected.slice(offset, offset + 64_000));
        if (mode === "state") {
          const hydrated = new Y.Doc();
          Y.applyUpdate(hydrated, Y.encodeStateAsUpdate(writer.doc));
          writer.close();
          writer = openCopy(link.url, 3, extended ? { messageReconnectTimeout: longWindow } : {}, hydrated);
        }
        const firstArrival = arrivals.length;
        const start = performance.now();
        writer.connect();
        await until(() => base.doc.getText("offline").length === total && !writer.provider.hasUnsyncedChanges && writer.provider.synced,
          "peer content and writer counter", 145_000);
        const elapsed = seconds(performance.now() - start);
        await until(() => arrivals.slice(firstArrival).some(packet => packet.type === messageYjsSyncStep2),
          "reconnect upload step 2", 60_000);
        for (const doc of [writer.doc, base.doc, observed]) assert.equal(doc?.getText("offline").toString(), expected);
        const received = arrivals.slice(firstArrival);
        return { rate: Number.isFinite(rate) ? rate : "uncapped", mb, mode, extended, elapsed, ...copySummary(writer, start),
          incremental: received.filter(packet => packet.type === messageYjsUpdate).length,
          lastUpload: seconds((received.at(-1)?.at ?? start) - start),
          uploadStep2: received.filter(packet => packet.type === messageYjsSyncStep2)
            .map(packet => ({ bytes: packet.bytes, at: seconds(packet.at - start) })) };
      } finally { writer.close(); base.close(); }
    } finally { await link.close(); }
  } finally { await server.destroy(); }
}

async function serverCost(path: string) {
  assert(global.gc, "Run with --expose-gc");
  const gc = global.gc;
  const heap = () => { gc(); return process.memoryUsage().heapUsed; };
  const folder = await mkdtemp(join(tmpdir(), "splitpage-e13-"));
  const snapshot = join(folder, "state.yjs");
  try {
    const seed = await readFile(path);
    assert.equal(seed.length, limitBytes);
    await writeFile(snapshot, seed);
    let beforeLoad = 0, loadStart = 0, readEnd = 0, applyEnd = 0, serverHeap = 0;
    let store: { encode: number; write: number; delay: number; bytes: number } | undefined;
    let keyStart = 0, receivedBytes = 0, applied = 0, handled = 0;
    const server = await openRelay({
      async onLoadDocument() {
        beforeLoad = heap();
        loadStart = performance.now();
        const state = await readFile(snapshot);
        readEnd = performance.now();
        return state;
      },
      async afterLoadDocument() {
        applyEnd = performance.now();
        serverHeap = heap() - beforeLoad;
      },
      async beforeSync({ type, payload }) {
        if (type !== messageYjsUpdate) return;
        keyStart = performance.now();
        receivedBytes = payload.length;
      },
      async onChange() { applied = performance.now(); },
      async afterHandleMessage() { if (keyStart && !handled) handled = performance.now(); },
      async onStoreDocument({ document }) {
        const start = performance.now();
        const bytes = Y.encodeStateAsUpdate(document);
        const encoded = performance.now();
        await writeFile(snapshot, bytes);
        store = { encode: encoded - start, write: performance.now() - encoded, delay: start - applied, bytes: bytes.length };
      }
    });
    try {
      const writer = openCopy(server.webSocketURL, 3), late = openCopy(server.webSocketURL, 4);
      try {
        const coldStart = performance.now();
        writer.connect();
        await until(() => writer.provider.synced && !writer.provider.hasUnsyncedChanges, "cold join", 20_000);
        const cold = performance.now() - coldStart;
        const lateStart = performance.now();
        late.connect();
        await until(() => late.provider.synced && !late.provider.hasUnsyncedChanges, "unlimited late join", 20_000);
        const lateJoin = performance.now() - lateStart;
        const segment = "seg-b-r150";
        const cell = (doc: Y.Doc) => doc.getMap<Y.Map<Y.Text>>("segments").get(segment)?.get("text");
        const text = cell(writer.doc);
        assert(text instanceof Y.Text, `Missing E8 cell ${segment}`);
        const length = text.length;
        const editStart = performance.now();
        text.insert(0, "K", {});
        await until(() => cell(late.doc)?.length === length + 1 && !writer.provider.hasUnsyncedChanges, "keystroke relay");
        const peerKey = performance.now() - editStart;
        await until(() => store, "debounced store", 20_000);
        assert(store && keyStart && applied && handled);
        assert.equal(cell(late.doc)?.toString()[0], "K");
        return { loadReadMs: readEnd - loadStart, applyMs: applyEnd - readEnd, serverHeapMiB: serverHeap / 2 ** 20,
          coldMs: cold, lateMs: lateJoin, keyApplyMs: applied - keyStart, keyHandleMs: handled - keyStart,
          peerKeyMs: peerKey, receivedBytes, store };
      } finally { writer.close(); late.close(); }
    } finally { await server.destroy(); }
  } finally { await rm(folder, { recursive: true, force: true }); }
}

const [mode, argument, selection, setting] = process.argv.slice(2);
if (mode === "download" || mode === "cost" || mode === "control") {
  assert(argument, "Pass the path to E8 state.yjs");
  if (mode === "cost") console.log(JSON.stringify(await serverCost(argument)));
  else if (mode === "control") {
    const capped = await download(argument, 4, "provider");
    const direct = await download(argument, "direct", "provider");
    const uncapped = await download(argument, Infinity, "provider");
    assert(capped.synced && direct.synced && uncapped.synced);
    const effective = Number(capped.synced >= 30 && uncapped.synced < 10);
    const failed = Number(effective === 1 && Math.abs(uncapped.synced - direct.synced) <= 1);
    console.log(JSON.stringify({ used: 1, effective, failed, capped, direct, uncapped }));
    assert.equal(failed, 1, "Removing the rate cap must fail the slow-time check and return within one second of the direct link");
  } else {
    const rate = selection === "direct" ? "direct" : selection === "uncapped" ? Infinity : Number(selection);
    assert(rate === "direct" || rate === Infinity || rates.includes(rate), "Pass a rate in Mbit/s, uncapped, or direct");
    const window = setting ?? "default";
    assert(window === "default" || window === "provider" || window === "both");
    console.log(JSON.stringify(await download(argument, rate, window)));
  }
} else if (mode === "upload") {
  const mb = Number(argument);
  const rate = selection === "uncapped" ? Infinity : Number(selection);
  assert((mb === 1 || mb === 5) && (rate === Infinity || rates.includes(rate)));
  assert(setting === undefined || setting === "state" || setting === "state-extended");
  console.log(JSON.stringify(await upload(rate, mb, setting ? "state" : "queued", setting === "state-extended")));
} else {
  assert.fail("Use download <state.yjs> <rate|uncapped|direct> [default|provider|both], upload <1|5> <rate|uncapped> [state|state-extended], cost <state.yjs>, or control <state.yjs>");
}
