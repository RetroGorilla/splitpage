import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import { createDecoder, readVarString, readVarUint } from "lib0/decoding";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { WebSocket } from "ws";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { relayConfig, retentionCount } from "../../../../collab-server/config.ts";
import { DB_NAME, openWriter, verifyDurability } from "../../../../collab-server/storage.ts";
import { readInvitationSnapshot } from "../../../../src/adapters/collab/native/invitation-snapshot.ts";
import { NAME, ORIGIN, serverHarness, storedState } from "./server-harness.ts";

const MAIN = new URL("../../../../collab-server/main.ts", import.meta.url);

function socket(t: TestContext, port: number, origin?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  ws.on("error", () => undefined);
  t.after(() => ws.terminate());
  return ws;
}

function provider(t: TestContext, url: string, token: string, doc = new Doc(), presence = false) {
  const events = new EventTarget();
  let rejectedWrite = false;
  let closeReason: string | undefined;
  const client = new HocuspocusProvider({
    url: url + "?wire=1&schema=1", name: NAME, token, document: doc, ...(presence ? {} : { awareness: null }),
    onAuthenticated() { events.dispatchEvent(new Event("change")); },
    onSynced() { events.dispatchEvent(new Event("change")); },
    onUnsyncedChanges() { events.dispatchEvent(new Event("change")); },
    onClose({ event }) {
      closeReason = event.reason;
      events.dispatchEvent(new Event("change"));
    }
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
  return { client, until, rejected: () => rejectedWrite, closeReason: () => closeReason };
}

test("only listed origins can upgrade, and only a valid invitation can load a script", { timeout: 30_000 }, async t => {
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
  const wrongToken = randomBytes(32).toString("base64url");
  const wrong = kit.copy(port, undefined, NAME, wrongToken);
  await kit.until(() => wrong.events.some(event => event.kind === "authentication-failed") || undefined);
  assert.equal(wrong.relay.status().firstSyncDone, false);
  assert.equal(wrong.text(), undefined);
  const right = kit.copy(port);
  await kit.until(() => right.relay.status().firstSyncDone || undefined);
  assert.equal(right.text(), "word");
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  assert.equal((run.errors() + run.output()).includes(wrongToken), false);
});

test("script and invitation refusals are observable without disclosing private data in logs", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const { token, id } = kit.provision(NAME);
  const other = kit.provision("other-script");
  const privateText = randomBytes(24).toString("hex");
  const doc = new Doc();
  doc.getMap("fixture").set("private", privateText);
  {
    using db = openWriter(kit.directory);
    db.prepare("INSERT INTO documents VALUES (?, ?)").run(NAME, encodeStateAsUpdate(doc));
    db.exec("INSERT INTO scripts VALUES ('pending-script', 'pending'), ('deleted-script', 'deleted')");
  }
  doc.destroy();
  const run = kit.launch();
  const port = await run.port();
  const url = `ws://127.0.0.1:${port}`;
  const first = provider(t, url, token);
  const second = provider(t, url, token);
  for (const connected of [first, second]) {
    await connected.until(() => connected.client.synced && connected.client.document.getMap("fixture").has("private"));
  }
  async function refused(name: string, credential: string, reason: string) {
    const copy = kit.copy(port, undefined, name, credential);
    const failure = await kit.until(() => copy.events.find(event => event.kind === "authentication-failed"));
    assert.equal(failure.reason, reason);
    assert.equal(copy.relay.status().firstSyncDone, false);
  }
  await refused(NAME, other.token, "permission-denied");
  await refused("unknown-script", token, "script-unknown");
  await refused("pending-script", token, "script-pending");
  await refused("deleted-script", token, "script-deleted");
  const authEvents = new EventTarget();
  const incompatible = new HocuspocusProvider({
    url: url + "?wire=1&schema=99", name: NAME, token, awareness: null,
    onAuthenticationFailed({ reason }) { authEvents.dispatchEvent(new CustomEvent("refused", { detail: reason })); }
  });
  t.after(() => { incompatible.destroy(); incompatible.document.destroy(); });
  const [failure] = await once(authEvents, "refused", { signal: t.signal });
  assert.equal(failure.detail, "unsupported-version");
  assert.equal(incompatible.synced, false);

  run.send(`revoke:${id}`);
  for (const connected of [first, second]) {
    await connected.until(() => connected.closeReason() !== undefined);
    assert.equal(connected.closeReason(), "access-removed");
  }
  await refused(NAME, token, "invitation-revoked");
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  const logs = run.errors() + run.output();
  for (const privateValue of [token, other.token, privateText]) assert.equal(logs.includes(privateValue), false);
  using db = openWriter(kit.directory);
  assert.equal(db.prepare("SELECT count(*) AS count FROM scripts").get()?.count, 4);
  assert.equal(db.prepare("SELECT count(*) AS count FROM documents").get()?.count, 1);
});

test("revocation discards queued edits and presence, and access removals survive restart", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const revoked = kit.provision(NAME);
  let remainingToken: string;
  {
    using db = openWriter(kit.directory);
    remainingToken = scriptAccess(db).issue(NAME, "remaining invitation").token;
  }
  const run = kit.launch();
  const url = `ws://127.0.0.1:${await run.port()}`;
  const writer = provider(t, url, revoked.token);
  const presence = provider(t, url, revoked.token, new Doc(), true);
  const survivor = provider(t, url, remainingToken, new Doc(), true);
  for (const peer of [writer, presence, survivor]) await peer.until(() => peer.client.synced);

  function seesPresence(value: string): boolean {
    const state = survivor.client.awareness?.getStates().get(presence.client.document.clientID) as Record<string, unknown> | undefined;
    return state?.reviewPresence === value;
  }
  const presenceChanged = new EventTarget();
  let sawQueuedPresence = false;
  survivor.client.awareness?.on("change", () => {
    sawQueuedPresence ||= seesPresence("queued");
    presenceChanged.dispatchEvent(new Event("change"));
  });
  presence.client.setAwarenessField("reviewPresence", "visible");
  while (!seesPresence("visible")) await once(presenceChanged, "change", { signal: t.signal });

  const observed = survivor.client.document.getMap("fixture");
  let sawQueuedEdit = false;
  observed.observe(() => { sawQueuedEdit ||= observed.has("queued"); });
  run.send({ holdSyncType: messageYjsUpdate });
  await kit.until(() => run.messages.includes("traffic-armed") || undefined);
  writer.client.document.getMap("fixture").set("queued", "must stay local");
  presence.client.setAwarenessField("reviewPresence", "queued");
  await kit.until(() => run.messages.includes("edit-queued") && run.messages.includes("presence-queued") || undefined);
  run.send(`revoke:${revoked.id}`);
  for (const peer of [writer, presence]) {
    await peer.until(() => peer.closeReason() !== undefined);
    assert.equal(peer.closeReason(), "access-removed");
  }
  run.send("release-traffic");
  await kit.until(() => run.messages.includes("traffic-released") || undefined);
  observed.set("authorized", "still writing");
  await survivor.until(() => survivor.client.unsyncedChanges === 0);
  assert.equal(survivor.client.isAuthenticated, true);
  assert.equal(sawQueuedEdit, false);
  assert.equal(sawQueuedPresence, false);
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });

  async function expectRefusal(port: number, token: string, reason: string) {
    const copy = kit.copy(port, undefined, NAME, token);
    const event = await kit.until(() => copy.events.find(event => event.kind === "authentication-failed"));
    assert.equal(event.reason, reason);
    assert.equal(copy.relay.status().firstSyncDone, false);
  }
  const restarted = kit.launch();
  const port = await restarted.port();
  await expectRefusal(port, revoked.token, "invitation-revoked");
  const active = kit.copy(port, undefined, NAME, remainingToken);
  await kit.until(() => active.relay.status().firstSyncDone || undefined);
  assert.equal(active.session.ydoc.getMap("fixture").has("queued"), false);
  assert.equal(active.session.ydoc.getMap("fixture").get("authorized"), "still writing");
  restarted.send(`delete:${NAME}`);
  const closed = await kit.until(() => active.events.find(event => event.kind === "authentication-failed"));
  assert.equal(closed.reason, "access-removed");
  assert.equal(active.relay.status().connected, false);
  await expectRefusal(port, remainingToken, "script-deleted");
  assert.deepEqual(await restarted.stop("clean"), { code: 0, exitSignal: null });

  const afterDelete = await kit.launch().port();
  await expectRefusal(afterDelete, remainingToken, "script-deleted");
  await expectRefusal(afterDelete, revoked.token, "script-deleted");
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
    if (state === "live") {
      const writer = provider(t, url, kit.invitation().token, full);
      await writer.until(() => writer.client.synced && writer.client.unsyncedChanges === 0);
      assert.equal(writer.client.authorizedScope, "read-write");
      assert.equal(run.messages.includes("store-started"), false);
    }
    const snapshot = await readInvitationSnapshot(url, NAME, kit.invitation().token, t.signal);
    assert.ok(Buffer.from(snapshot).equals(fullState), "the bootstrap downloads the complete read-only snapshot");
    const viewer = provider(t, url, kit.invitation().token);
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

test("a join waits for the in-progress document before deciding 15 MB access", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const run = kit.launch();
  const url = `ws://127.0.0.1:${await run.port()}`;
  run.send("hold-load");
  await kit.until(() => run.messages.includes("load-armed") || undefined);
  const first = provider(t, url, kit.invitation().token);
  await kit.until(() => run.messages.includes("loading") || undefined);
  const joining = provider(t, url, kit.invitation().token);
  await joining.until(() => joining.client.synced && joining.client.document.getMap("fixture").has("data"));
  assert.equal(first.client.authorizedScope, "read-write");
  assert.equal(joining.client.authorizedScope, "readonly");
});

test("an existing writer can cross 15 MB and keep writing", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const run = kit.launch({ SPLITPAGE_STORE_DEBOUNCE_MS: "60000", SPLITPAGE_STORE_MAX_DEBOUNCE_MS: "60000" });
  const writer = provider(t, `ws://127.0.0.1:${await run.port()}`, kit.invitation().token);
  await writer.until(() => writer.client.synced && writer.client.unsyncedChanges === 0);
  assert.equal(writer.client.authorizedScope, "read-write");
  const data = writer.client.document.getMap("fixture");
  data.set("one", new Uint8Array(8_000_000));
  await writer.until(() => writer.client.unsyncedChanges === 0);
  data.set("two", new Uint8Array(7_100_000));
  await writer.until(() => writer.client.unsyncedChanges === 0);
  data.set("after", "accepted");
  await writer.until(() => writer.client.unsyncedChanges === 0);
  assert.equal(writer.client.authorizedScope, "read-write");
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  const snapshot = storedState(kit.directory);
  assert.ok(snapshot.byteLength > 15_000_000);
  const decoded = new Doc();
  t.after(() => decoded.destroy());
  applyUpdate(decoded, snapshot);
  assert.equal(decoded.getMap("fixture").get("after"), "accepted");
});

test("missing configuration or out-of-range settings fail without including their values", t => {
  const kit = serverHarness(t);
  const valid = { SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_ALLOWED_ORIGINS: ORIGIN };
  assert.equal(relayConfig(valid).debounce, 2000);
  assert.equal(relayConfig(valid).maxDebounce, 10000);
  for (const key of Object.keys(valid)) {
    assert.throws(() => relayConfig({ ...valid, [key]: "" }), new RegExp(`Set ${key}`));
  }
  assert.throws(() => relayConfig({ ...valid, SPLITPAGE_ALLOWED_ORIGINS: "*" }), /exact origins/);
  for (const deployment of ["", "too/long", "line\n", "x".repeat(65)]) {
    assert.throws(() => relayConfig({ ...valid, SPLITPAGE_DEPLOYMENT_ID: deployment }), /SPLITPAGE_DEPLOYMENT_ID must be/);
  }
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
  const blocked = kit.launch({ SPLITPAGE_DATA_DIR: join(kit.directory, "other"), SPLITPAGE_PORT: String(port) });
  assert.deepEqual(await blocked.exit, { code: 1, exitSignal: null });
  assert.match(blocked.errors(), /Relay could not listen on the configured port/);
});

for (const damage of ["foreign", "empty", "corrupt", "wrong identity", "wrong schema", "wrong version", "failed integrity"] as const) {
  test(`${damage} database fails startup and its file is preserved`, { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const path = join(kit.directory, DB_NAME);
    if (damage === "foreign") {
      using db = new DatabaseSync(path);
      db.exec("CREATE TABLE other (content TEXT)");
    } else if (damage === "empty" || damage === "corrupt") {
      writeFileSync(path, damage === "empty" ? "" : "not a database");
    } else if (damage === "wrong identity" || damage === "wrong schema" || damage === "wrong version") {
      using db = openWriter(kit.directory);
      db.exec(damage === "wrong identity" ? "PRAGMA application_id=0" : damage === "wrong version" ? "PRAGMA user_version=99" : "ALTER TABLE documents RENAME TO other");
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

test("startup explicitly sets FULL and rejects a writer connection that still reads back NORMAL", t => {
  const kit = serverHarness(t);
  const exec = DatabaseSync.prototype.exec;
  let forceMismatch = false;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (!sql.includes("journal_mode=WAL")) return exec.call(this, sql);
    exec.call(this, "PRAGMA synchronous=NORMAL");
    exec.call(this, sql);
    if (forceMismatch) exec.call(this, "PRAGMA synchronous=NORMAL");
  });
  {
    using db = openWriter(kit.directory);
    assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 2);
  }
  forceMismatch = true;
  assert.throws(() => openWriter(kit.directory).close(), /requires WAL and synchronous=FULL/);
});

test("synthetic beforeHandleMessage throw resets the connection, preserves multiplexed siblings and releases invitation capacity",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed(NAME);
    kit.seed("sibling-script");
    const failing = kit.provision(NAME);
    const siblingInvite = kit.provision("sibling-script");
    let healthyToken: string;
    let siblingPeerToken: string;
    {
      using db = openWriter(kit.directory);
      healthyToken = scriptAccess(db).issue(NAME, "healthy observer").token;
      siblingPeerToken = scriptAccess(db).issue("sibling-script", "sibling observer").token;
    }
    kit.redact(healthyToken, siblingPeerToken);
    const run = kit.launch({ SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION: "1" });
    const port = await run.port();
    const url = `ws://127.0.0.1:${port}`;

    const sharedSocket = new HocuspocusProviderWebsocket({ url: `${url}?wire=1&schema=1` });
    const events = new EventTarget();
    let senderCloseReason: string | undefined;
    let siblingClosed = false;
    const senderDoc = new Doc();
    const siblingDoc = new Doc();
    const sender = new HocuspocusProvider({
      websocketProvider: sharedSocket, name: NAME, token: failing.token, document: senderDoc, awareness: null,
      onSynced() { events.dispatchEvent(new Event("change")); },
      onClose({ event }) {
        senderCloseReason = event.reason;
        sender.detach();
        sender.destroy();
        events.dispatchEvent(new Event("change"));
      }
    });
    const sibling = new HocuspocusProvider({
      websocketProvider: sharedSocket, name: "sibling-script", token: siblingInvite.token, document: siblingDoc, awareness: null,
      onSynced() { events.dispatchEvent(new Event("change")); },
      onClose() { siblingClosed = true; events.dispatchEvent(new Event("change")); }
    });
    sender.attach();
    sibling.attach();
    t.after(() => {
      sender.destroy();
      sibling.destroy();
      sharedSocket.destroy();
      senderDoc.destroy();
      siblingDoc.destroy();
    });

    const peer = provider(t, url, healthyToken);
    const siblingPeer = kit.copy(port, undefined, "sibling-script", siblingPeerToken);
    while (!sender.synced || !sibling.synced) await once(events, "change", { signal: t.signal });
    await peer.until(() => peer.client.synced);
    await kit.until(() => siblingPeer.relay.status().firstSyncDone || undefined);

    const storedBefore = storedState(kit.directory, NAME);
    const storesBefore = run.messages.filter(message => message === `store-started:${NAME}`).length;
    const refusedValue = `refused-${randomBytes(12).toString("hex")}`;
    const errorDetail = `detail-${randomBytes(12).toString("hex")}`;
    kit.redact(refusedValue, errorDetail);
    let peerUpdatesDuringRefusal = 0;
    const countPeerUpdates = () => { peerUpdatesDuringRefusal += 1; };
    peer.client.document.on("update", countPeerUpdates);

    run.send({ refuseDecode: { stage: "beforeHandleMessage", invitationId: failing.id, detail: errorDetail } });
    await kit.until(() => run.messages.includes("decoder-refusal-armed") || undefined);

    senderDoc.getMap("fixture").set("refused", refusedValue);
    senderDoc.getMap("fixture").set("queued-after-refusal", refusedValue);
    while (senderCloseReason === undefined) await once(events, "change", { signal: t.signal });
    assert.equal(senderCloseReason, "Reset Connection");
    assert.equal(run.messages.includes("decoder-refused:beforeHandleMessage"), true);

    assert.equal(siblingClosed, false);
    assert.equal(sibling.isAuthenticated, true);
    siblingDoc.getMap("fixture").set("sibling-after", "kept");
    await kit.until(() => siblingPeer.session.ydoc.getMap("fixture").get("sibling-after") === "kept" || undefined);

    peer.client.document.off("update", countPeerUpdates);
    assert.equal(peerUpdatesDuringRefusal, 0);
    assert.equal(peer.client.document.getMap("fixture").has("refused"), false);
    assert.equal(peer.client.document.getMap("fixture").has("queued-after-refusal"), false);
    assert.equal(run.messages.filter(message => message === `store-started:${NAME}`).length, storesBefore);
    assert.equal(Buffer.from(storedState(kit.directory, NAME)).equals(Buffer.from(storedBefore)), true);

    const storesBeforeHealthy = run.messages.filter(message => message === `stored:${NAME}`).length;
    peer.client.document.getMap("fixture").set("healthy-after", "accepted");
    await peer.until(() => peer.client.unsyncedChanges === 0);
    await kit.until(() => run.messages.filter(message => message === `stored:${NAME}`).length > storesBeforeHealthy || undefined);

    const fresh = provider(t, url, failing.token);
    await fresh.until(() => fresh.client.synced && fresh.client.document.getMap("fixture").get("healthy-after") === "accepted");
    assert.equal(fresh.client.document.getMap("fixture").has("refused"), false);
    assert.equal(fresh.client.document.getMap("fixture").has("queued-after-refusal"), false);

    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    const persisted = new Doc();
    t.after(() => persisted.destroy());
    applyUpdate(persisted, storedState(kit.directory, NAME));
    assert.equal(persisted.getMap("fixture").get("healthy-after"), "accepted");
    assert.equal(persisted.getMap("fixture").has("refused"), false);
    assert.equal(persisted.getMap("fixture").has("queued-after-refusal"), false);

    const logs = run.output() + run.errors();
    assert.match(run.errors(), /Relay library error/);
    for (const privateValue of [failing.token, healthyToken, siblingInvite.token, siblingPeerToken, NAME, "sibling-script", refusedValue, errorDetail]) {
      assert.equal(logs.includes(privateValue), false);
    }
  }
);

for (const mode of ["update", "returning-sync"] as const) {
  test(`synthetic beforeSync throw on ${mode} resets the connection and leaves later writers unblocked`,
    { timeout: 30_000 }, async t => {
      const kit = serverHarness(t);
      const seededState = kit.seed(NAME);
      const failing = kit.provision(NAME);
      let healthyToken: string;
      {
        using db = openWriter(kit.directory);
        healthyToken = scriptAccess(db).issue(NAME, "healthy writer").token;
      }
      kit.redact(healthyToken);
      const run = kit.launch({ SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION: "1" });
      const url = `ws://127.0.0.1:${await run.port()}`;

      const peer = provider(t, url, healthyToken);
      await peer.until(() => peer.client.synced);
      const storedBefore = storedState(kit.directory, NAME);
      const storesBefore = run.messages.filter(message => message === `store-started:${NAME}`).length;
      const refusedValue = `refused-${mode}-${randomBytes(12).toString("hex")}`;
      const errorDetail = `detail-${mode}-${randomBytes(12).toString("hex")}`;
      kit.redact(refusedValue, errorDetail);
      const targetSyncType = mode === "update" ? messageYjsUpdate : messageYjsSyncStep2;

      const senderDoc = new Doc();
      if (mode === "returning-sync") {
        applyUpdate(senderDoc, seededState);
        senderDoc.getMap("fixture").set("refused", refusedValue);
      }
      const events = new EventTarget();
      let senderCloseReason: string | undefined;
      let peerUpdatesDuringRefusal = 0;
      const countPeerUpdates = () => { peerUpdatesDuringRefusal += 1; };

      if (mode === "returning-sync") {
        peer.client.document.on("update", countPeerUpdates);
        run.send({
          refuseDecode: {
            stage: "beforeSync",
            invitationId: failing.id,
            syncType: targetSyncType,
            skipEmptyPayload: true,
            detail: errorDetail
          }
        });
        await kit.until(() => run.messages.includes("decoder-refusal-armed") || undefined);
      }

      const sender: HocuspocusProvider = new HocuspocusProvider({
        url: `${url}?wire=1&schema=1`, name: NAME, token: failing.token, document: senderDoc, awareness: null,
        onSynced() { events.dispatchEvent(new Event("change")); },
        onClose({ event }) {
          senderCloseReason = event.reason;
          sender.destroy();
          events.dispatchEvent(new Event("change"));
        }
      });
      t.after(() => { sender.destroy(); senderDoc.destroy(); });

      if (mode === "update") {
        while (!sender.synced) await once(events, "change", { signal: t.signal });
        peer.client.document.on("update", countPeerUpdates);
        run.send({ refuseDecode: { stage: "beforeSync", invitationId: failing.id, syncType: targetSyncType, detail: errorDetail } });
        await kit.until(() => run.messages.includes("decoder-refusal-armed") || undefined);
        senderDoc.getMap("fixture").set("refused", refusedValue);
        senderDoc.getMap("fixture").set("queued-after-refusal", refusedValue);
      }

      while (senderCloseReason === undefined) await once(events, "change", { signal: t.signal });
      assert.equal(senderCloseReason, "Reset Connection");
      assert.equal(run.messages.includes(`decoder-refused:beforeSync:${targetSyncType}`), true);

      peer.client.document.off("update", countPeerUpdates);
      assert.equal(peerUpdatesDuringRefusal, 0);
      assert.equal(peer.client.document.getMap("fixture").has("refused"), false);
      assert.equal(peer.client.document.getMap("fixture").has("queued-after-refusal"), false);
      assert.equal(run.messages.filter(message => message === `store-started:${NAME}`).length, storesBefore);
      assert.equal(Buffer.from(storedState(kit.directory, NAME)).equals(Buffer.from(storedBefore)), true);

      const storesBeforeHealthy = run.messages.filter(message => message === `stored:${NAME}`).length;
      peer.client.document.getMap("fixture").set("after-refusal", mode);
      await peer.until(() => peer.client.unsyncedChanges === 0);
      await kit.until(() => run.messages.filter(message => message === `stored:${NAME}`).length > storesBeforeHealthy || undefined);

      const fresh = provider(t, url, failing.token);
      await fresh.until(() => fresh.client.synced && fresh.client.document.getMap("fixture").get("after-refusal") === mode);
      assert.equal(fresh.client.document.getMap("fixture").has("refused"), false);
      assert.equal(fresh.client.document.getMap("fixture").has("queued-after-refusal"), false);

      assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
      const persisted = new Doc();
      t.after(() => persisted.destroy());
      applyUpdate(persisted, storedState(kit.directory, NAME));
      assert.equal(persisted.getMap("fixture").get("after-refusal"), mode);
      assert.equal(persisted.getMap("fixture").has("refused"), false);
      assert.equal(persisted.getMap("fixture").has("queued-after-refusal"), false);

      const logs = run.output() + run.errors();
      assert.match(run.errors(), /Relay library error/);
      for (const privateValue of [failing.token, healthyToken, NAME, refusedValue, errorDetail]) {
        assert.equal(logs.includes(privateValue), false);
      }
    }
  );
}
