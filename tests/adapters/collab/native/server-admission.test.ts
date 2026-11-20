import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { WebSocket } from "ws";
import { Doc, encodeStateAsUpdate } from "yjs";
import { relayConfig, retentionCount } from "../../../../collab-server/config.ts";
import { DB_NAME, openWriter, verifyDurability } from "../../../../collab-server/storage.ts";
import { NAME, ORIGIN, TOKEN, serverHarness } from "./server-harness.ts";

const MAIN = new URL("../../../../collab-server/main.ts", import.meta.url);

function socket(t: TestContext, port: number, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  ws.on("error", () => undefined);
  t.after(() => ws.terminate());
  return ws;
}

test("only listed origins can upgrade, and only the shared token can load a script", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch({ SPLITPAGE_ALLOWED_ORIGINS: `https://editor.example.test, ${ORIGIN}` });
  const port = await run.port();
  for (const origin of [undefined, "https://other.example.test", "splitpage://app.other"]) {
    const denied = socket(t, port, origin);
    await assert.rejects(once(denied, "open", { signal: t.signal }), /Unexpected server response: 401/);
  }
  const otherAllowed = socket(t, port, "https://editor.example.test");
  await once(otherAllowed, "open", { signal: t.signal });
  const wrong = kit.copy(port, undefined, NAME, "wrong-token");
  await kit.until(() => wrong.events.some(event => event.kind === "authentication-failed") || undefined);
  assert.equal(wrong.relay.status().firstSyncDone, false);
  assert.equal(wrong.text(), undefined);
  const right = kit.copy(port);
  await kit.until(() => right.relay.status().firstSyncDone || undefined);
  assert.equal(right.text(), "word");
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  assert.doesNotMatch(run.errors() + run.output(), /fixture-access|wrong-token/);
});

test("oversized WebSocket payload closes before protocol processing", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const run = kit.launch();
  const ws = socket(t, await run.port(), ORIGIN);
  await once(ws, "open", { signal: t.signal });
  const closed = once(ws, "close", { signal: t.signal });
  ws.send(Buffer.alloc(16_000_001));
  assert.equal((await closed)[0], 1009);
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  assert.match(run.errors(), /Relay library error/);
  assert.doesNotMatch(run.errors(), /Max payload size exceeded/);
});

test("stock protocol warnings omit document names and frame data", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const run = kit.launch();
  const ws = socket(t, await run.port(), ORIGIN);
  await once(ws, "open", { signal: t.signal });
  const closed = once(ws, "close", { signal: t.signal });
  for (let i = 0; i <= 100; i++) {
    const encoder = createEncoder();
    writeVarString(encoder, `private-fixture-${i}`);
    writeVarUint(encoder, MessageType.Sync);
    ws.send(toUint8Array(encoder));
  }
  await closed;
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  assert.match(run.errors(), /Relay library warning/);
  assert.doesNotMatch(run.errors() + run.output(), /private-fixture-/);
});

for (const state of ["stored", "live"] as const) {
  test(`the 15 MB ${state} document admits a read-only connection and declines writes without disconnecting`, { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const full = new Doc();
    t.after(() => full.destroy());
    const probe = new Doc();
    probe.clientID = full.clientID;
    probe.getMap("fixture").set("data", new Uint8Array(14_999_950));
    const length = encodeStateAsUpdate(probe).byteLength;
    probe.destroy();
    full.getMap("fixture").set("data", new Uint8Array(29_999_950 - length));
    const fullState = encodeStateAsUpdate(full);
    assert.equal(fullState.byteLength, 15_000_000);
    if (state === "stored") {
      using db = openWriter(kit.directory);
      db.prepare("INSERT INTO documents VALUES (?, ?)").run(NAME, fullState);
    }
    const run = kit.launch({ SPLITPAGE_STORE_DEBOUNCE_MS: "60000", SPLITPAGE_STORE_MAX_DEBOUNCE_MS: "60000" });
    const url = `ws://127.0.0.1:${await run.port()}`;
    function provider(doc: Doc) {
      const events = new EventTarget();
      let rejectedWrite = false;
      const client = new HocuspocusProvider({
        url, name: NAME, token: TOKEN, document: doc, awareness: null,
        onAuthenticated() { events.dispatchEvent(new Event("change")); },
        onSynced() { events.dispatchEvent(new Event("change")); }
      });
      client.on("message", ({ event }: { event: MessageEvent }) => {
        const decoder = createDecoder(new Uint8Array(event.data as ArrayBuffer));
        readVarString(decoder);
        if (readVarUint(decoder) === MessageType.SyncStatus && readVarUint(decoder) === 0) rejectedWrite = true;
        events.dispatchEvent(new Event("change"));
      });
      t.after(() => { client.destroy(); doc.destroy(); });
      async function until(predicate: () => boolean) {
        while (!predicate()) await once(events, "change", { signal: t.signal });
      }
      return { client, until, rejected: () => rejectedWrite };
    }
    if (state === "live") {
      const writer = provider(full);
      await writer.until(() => writer.client.synced && writer.client.unsyncedChanges === 0);
      assert.equal(writer.client.authorizedScope, "read-write");
      assert.equal(run.messages.includes("store-started"), false);
    }
    const viewer = provider(new Doc());
    await viewer.until(() => viewer.client.synced && viewer.client.document.getMap("fixture").has("data"));
    assert.equal(viewer.client.authorizedScope, "readonly");
    viewer.client.document.getMap("fixture").set("blocked", "do not persist");
    await viewer.until(viewer.rejected);
    assert.equal(viewer.client.isAuthenticated, true);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    using db = new DatabaseSync(join(kit.directory, DB_NAME), { readOnly: true });
    assert.equal(db.prepare("SELECT length(state) AS bytes FROM documents").get()?.bytes, 15_000_000);
  });
}

test("missing configuration or out-of-range settings fail without including their values", t => {
  const kit = serverHarness(t);
  const valid = { SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_ALLOWED_ORIGINS: ORIGIN, SPLITPAGE_ACCESS_TOKEN: TOKEN };
  assert.equal(relayConfig(valid).debounce, 2000);
  assert.equal(relayConfig(valid).maxDebounce, 10000);
  for (const key of Object.keys(valid)) {
    assert.throws(() => relayConfig({ ...valid, [key]: "" }), new RegExp(`Set ${key}`));
  }
  assert.throws(() => relayConfig({ ...valid, SPLITPAGE_ALLOWED_ORIGINS: "*" }), /exact origins/);
  assert.throws(() => relayConfig({ ...valid, SPLITPAGE_PORT: "65536" }), /SPLITPAGE_PORT must be an integer/);
  assert.throws(() => relayConfig({ ...valid, SPLITPAGE_PORT: "1.5" }), /SPLITPAGE_PORT must be an integer/);
  assert.throws(() => relayConfig({ ...valid, SPLITPAGE_STORE_DEBOUNCE_MS: "-1" }), /DEBOUNCE_MS must be an integer/);
  assert.throws(() => relayConfig({ ...valid, SPLITPAGE_STORE_MAX_DEBOUNCE_MS: "42" }), /MAX_DEBOUNCE_MS must be an integer/);
  assert.throws(() => retentionCount({ SPLITPAGE_BACKUP_KEEP: "0" }), /SPLITPAGE_BACKUP_KEEP must be an integer/);
});

test("writer requires both WAL and FULL on its own connection", t => {
  const kit = serverHarness(t);
  using db = openWriter(kit.directory);
  verifyDurability(db);
  db.exec("PRAGMA synchronous=NORMAL");
  assert.throws(() => verifyDurability(db), /requires WAL and synchronous=FULL/);
  db.exec("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE");
  assert.throws(() => verifyDurability(db), /requires WAL and synchronous=FULL/);
});

test("a relay fails cleanly when the configured listener is taken", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const running = kit.launch();
  const port = await running.port();
  const blocked = kit.launch({ SPLITPAGE_PORT: String(port) });
  assert.deepEqual(await blocked.exit, { code: 1, exitSignal: null });
  assert.match(blocked.errors(), /Relay could not listen on the configured port/);
});

for (const damage of ["foreign", "empty", "corrupt", "wrong schema", "failed integrity"] as const) {
  test(`${damage} database fails startup and its file is preserved`, { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const path = join(kit.directory, DB_NAME);
    if (damage === "foreign") {
      using db = new DatabaseSync(path);
      db.exec("CREATE TABLE other (content TEXT)");
    } else if (damage === "empty" || damage === "corrupt") {
      writeFileSync(path, damage === "empty" ? "" : "not a database");
    } else if (damage === "wrong schema") {
      using db = openWriter(kit.directory);
      db.exec("ALTER TABLE documents RENAME TO other");
    } else {
      let offset: number;
      {
        using db = openWriter(kit.directory);
        const page = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'documents'").get()?.rootpage);
        const size = Number(db.prepare("PRAGMA page_size").get()?.page_size);
        offset = (page - 1) * size;
      }
      const damaged = readFileSync(path);
      damaged[offset] = 0;
      writeFileSync(path, damaged);
    }
    const before = readFileSync(path);
    const run = kit.launch({}, MAIN);
    const exit = await Promise.race([run.exit, kit.until(() => run.output().includes("Relay listening") || undefined)]);
    assert.deepEqual(exit, { code: 1, exitSignal: null });
    const message = damage === "corrupt" ? /database could not be opened/ :
      damage === "failed integrity" ? /failed its integrity check/ : /unrecognized identity or schema/;
    assert.match(run.errors(), message);
    assert.doesNotMatch(run.errors() + run.output(), /Relay listening/);
    assert.deepEqual(readFileSync(path), before);
  });
}
