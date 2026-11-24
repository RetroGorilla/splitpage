import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { createConnection, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { HocuspocusProvider, HocuspocusProviderWebsocket, MessageType } from "@hocuspocus/provider";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { WebSocket } from "ws";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { backupRelay } from "../../../../collab-server/backup.ts";
import { relayConfig } from "../../../../collab-server/config.ts";
import type { RelayStatusSnapshot } from "../../../../collab-server/status.ts";
import { DB_NAME, openWriter } from "../../../../collab-server/storage.ts";
import { appendText, NAME, ORIGIN, serverHarness, storedText } from "./server-harness.ts";

const BACKUP = new URL("../../../../collab-server/backup-command.ts", import.meta.url);

function makePng(tag: string): { bytes: Buffer; sha: string } {
  const header = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
  const bytes = Buffer.concat([header, Buffer.from(tag, "utf8")]);
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

function connectSocket(t: TestContext, port: number, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  ws.on("error", () => undefined);
  t.after(() => ws.terminate());
  return ws;
}

async function expectUpgradeStatus(t: TestContext, port: number, expectedStatus: number, origin = ORIGIN): Promise<IncomingMessage> {
  const ws = connectSocket(t, port, origin);
  const [, response] = await once(ws, "unexpected-response", { signal: t.signal }) as [unknown, IncomingMessage];
  assert.equal(response.statusCode, expectedStatus);
  return response;
}

async function openChunkingProxy(t: TestContext, targetPort: number, chunkSize: number): Promise<{ port: number; chunksForwarded: () => number }> {
  const sockets = new Set<Socket>();
  let chunks = 0;
  const server = createServer(client => {
    const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    const cleanup = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", cleanup);
    upstream.on("error", cleanup);
    client.once("close", cleanup);
    upstream.once("close", cleanup);
    client.on("data", data => {
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        chunks += 1;
        upstream.write(data.subarray(offset, offset + chunkSize));
      }
    });
    upstream.on("data", data => {
      client.write(data);
    });
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  });
  return { port: (server.address() as AddressInfo).port, chunksForwarded: () => chunks };
}

test("total connection limit refuses excess WebSockets at upgrade with 503 and recovers when a slot frees",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed();
    const run = kit.launch({ SPLITPAGE_MAX_CONNECTIONS: "2" });
    const port = await run.port();
    const first = connectSocket(t, port);
    const second = connectSocket(t, port);
    await Promise.all([once(first, "open", { signal: t.signal }), once(second, "open", { signal: t.signal })]);

    const refused = await expectUpgradeStatus(t, port, 503);
    assert.equal(refused.headers["retry-after"], "5");

    const queued = kit.copy(port);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(queued.relay.status().connected, false);
    assert.equal(queued.relay.status().firstSyncDone, false);
    assert.equal(queued.events.some(event => event.kind === "authentication-failed"), false);
    first.close();
    await once(first, "close", { signal: t.signal });
    await kit.until(() => (queued.relay.status().firstSyncDone && queued.text() === "word") || undefined);
    assert.equal(queued.events.some(event => event.kind === "authentication-failed"), false);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("per-invitation connection limit returns a temporary refusal while other invitations connect, then retries succeed",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed();
    const firstInvite = kit.provision(NAME);
    let secondInvite: { id: string; token: string };
    {
      using db = openWriter(kit.directory);
      secondInvite = scriptAccess(db).issue(NAME, "second invite", "owner");
    }
    const run = kit.launch({
      SPLITPAGE_MAX_CONNECTIONS: "6",
      SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION: "2"
    });
    const port = await run.port();

    const first = kit.copy(port, undefined, NAME, firstInvite.token);
    const second = kit.copy(port, undefined, NAME, firstInvite.token);
    await kit.until(() => (first.relay.status().firstSyncDone && second.relay.status().firstSyncDone) || undefined);

    const third = kit.copy(port, undefined, NAME, firstInvite.token);
    const temporary = await kit.until(() => third.events.find(event => event.kind === "temporary-refusal"));
    assert.equal(temporary.reason, "too-many-connections");
    assert.equal(third.events.some(event => event.kind === "authentication-failed"), false);
    assert.equal(third.relay.status().firstSyncDone, false);

    const other = kit.copy(port, undefined, NAME, secondInvite.token);
    await kit.until(() => (other.relay.status().firstSyncDone && other.text() === "word") || undefined);

    first.close();
    await kit.until(() => (third.relay.status().firstSyncDone && third.text() === "word") || undefined);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("document revocation preserves other logical documents on the same multiplexed WebSocket",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed(NAME);
    kit.seed("second-script");
    const firstInvite = kit.provision(NAME);
    const secondInvite = kit.provision("second-script");
    const run = kit.launch();
    const port = await run.port();

    const sharedSocket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}?wire=1&schema=1` });
    const events = new EventTarget();
    let firstClosedReason: string | undefined;
    let secondClosed = false;
    const docA = new Doc();
    const docB = new Doc();
    const providerA = new HocuspocusProvider({
      websocketProvider: sharedSocket, name: NAME, token: firstInvite.token, document: docA, awareness: null,
      onSynced() { events.dispatchEvent(new Event("change")); },
      onClose({ event }) { firstClosedReason = event.reason; events.dispatchEvent(new Event("change")); }
    });
    const providerB = new HocuspocusProvider({
      websocketProvider: sharedSocket, name: "second-script", token: secondInvite.token, document: docB, awareness: null,
      onSynced() { events.dispatchEvent(new Event("change")); },
      onUnsyncedChanges() { events.dispatchEvent(new Event("change")); },
      onClose() { secondClosed = true; events.dispatchEvent(new Event("change")); }
    });
    providerA.attach();
    providerB.attach();
    t.after(() => {
      providerA.destroy();
      providerB.destroy();
      sharedSocket.destroy();
      docA.destroy();
      docB.destroy();
    });

    while (!providerA.synced || !providerB.synced) await once(events, "change", { signal: t.signal });
    const peerB = kit.copy(port, undefined, "second-script", secondInvite.token);
    await kit.until(() => (peerB.relay.status().firstSyncDone && peerB.text() === "word") || undefined);

    run.send(`revoke:${firstInvite.id}`);
    while (firstClosedReason === undefined) await once(events, "change", { signal: t.signal });
    assert.equal(firstClosedReason, "access-removed");
    assert.equal(secondClosed, false);
    assert.equal(providerB.isAuthenticated, true);

    docB.getText("mux-check").insert(0, "still-alive");
    await kit.until(() => peerB.session.ydoc.getText("mux-check").toString() === "still-alive" || undefined);
    assert.equal(secondClosed, false);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("disconnecting one multiplexed document preserves sibling continuity and shared transport rate window",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed(NAME);
    kit.seed("second-script");
    const firstInvite = kit.provision(NAME);
    const secondInvite = kit.provision("second-script");
    let peerBInvite: { id: string; token: string };
    {
      using db = openWriter(kit.directory);
      peerBInvite = scriptAccess(db).issue("second-script", "peer b", "owner");
    }
    const run = kit.launch({
      SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION: "1",
      SPLITPAGE_MAX_MESSAGES_PER_SECOND: "16"
    });
    const port = await run.port();

    const sharedSocket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}?wire=1&schema=1` });
    const events = new EventTarget();
    let secondClosedReason: string | undefined;
    const docA = new Doc();
    const docB = new Doc();
    const providerA = new HocuspocusProvider({
      websocketProvider: sharedSocket, name: NAME, token: firstInvite.token, document: docA, awareness: null,
      onSynced() { events.dispatchEvent(new Event("change")); }
    });
    const providerB = new HocuspocusProvider({
      websocketProvider: sharedSocket, name: "second-script", token: secondInvite.token, document: docB, awareness: null,
      onSynced() { events.dispatchEvent(new Event("change")); },
      onClose({ event }) { secondClosedReason = event.reason; events.dispatchEvent(new Event("change")); }
    });
    providerA.attach();
    providerB.attach();
    t.after(() => {
      providerA.destroy();
      providerB.destroy();
      sharedSocket.destroy();
      docA.destroy();
      docB.destroy();
    });

    while (!providerA.synced || !providerB.synced) await once(events, "change", { signal: t.signal });
    const peerB = kit.copy(port, undefined, "second-script", peerBInvite.token);
    await kit.until(() => (peerB.relay.status().firstSyncDone && peerB.text() === "word") || undefined);

    await new Promise(resolve => setTimeout(resolve, 1100));

    for (let i = 0; i < 9; i++) docA.getArray("mux-a").push([i]);
    providerA.detach();
    providerA.destroy();

    docB.getText("sibling-live").insert(0, "kept");
    await kit.until(() => peerB.session.ydoc.getText("sibling-live").toString() === "kept" || undefined);
    assert.equal(secondClosedReason, undefined);
    assert.equal(providerB.isAuthenticated, true);

    for (let i = 0; i < 8; i++) docB.getArray("mux-b").push([i]);
    while (secondClosedReason === undefined) await once(events, "change", { signal: t.signal });
    assert.equal(secondClosedReason, "rate-limited");

    const replacementA = kit.copy(port, undefined, NAME, firstInvite.token);
    await kit.until(() => (replacementA.relay.status().firstSyncDone && replacementA.text() === "word") || undefined);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("invitation reservations release after injected document load failures and normal socket disconnects",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed();
    const invite = kit.provision(NAME);
    const run = kit.launch({ SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION: "1" });
    const port = await run.port();

    run.send("fail-next-load");
    await kit.until(() => run.messages.includes("fail-load-armed") || undefined);

    const events = new EventTarget();
    let authFailures = 0;
    const failedDoc = new Doc();
    const failedProvider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}?wire=1&schema=1`, name: NAME, token: invite.token, document: failedDoc, awareness: null,
      onAuthenticationFailed() { authFailures += 1; events.dispatchEvent(new Event("change")); }
    });
    t.after(() => { failedProvider.destroy(); failedDoc.destroy(); });

    await kit.until(() => run.messages.includes("load-failed") || undefined);
    while (authFailures === 0) await once(events, "change", { signal: t.signal });

    const recovered = kit.copy(port, undefined, NAME, invite.token);
    await kit.until(() => (recovered.relay.status().firstSyncDone && recovered.text() === "word") || undefined);
    recovered.close();

    const reopened = kit.copy(port, undefined, NAME, invite.token);
    await kit.until(() => (reopened.relay.status().firstSyncDone && reopened.text() === "word") || undefined);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("message rate limit closes a flooding client before applying excess updates and permits reconnect",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed();
    const run = kit.launch({ SPLITPAGE_MAX_MESSAGES_PER_SECOND: "5" });
    const port = await run.port();
    const peer = kit.copy(port);
    const writer = kit.copy(port);
    await kit.until(() => (peer.relay.status().firstSyncDone && writer.relay.status().firstSyncDone) || undefined);

    for (let i = 0; i < 12; i++) {
      writer.session.ydoc.getArray("burst").push([i]);
    }
    const temporary = await kit.until(() => writer.events.find(event => event.kind === "temporary-refusal"));
    assert.equal(temporary.reason, "rate-limited");
    assert.equal(writer.events.some(event => event.kind === "authentication-failed"), false);
    assert.ok(peer.session.ydoc.getArray("burst").length < 12);

    await kit.until(() => (writer.relay.status().connected && peer.session.ydoc.getArray("burst").length === 12) || undefined);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("in-flight upload limit refuses excess picture uploads with 503 and tracks real staging slots",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed();
    const { token } = kit.provision(NAME);
    const secret = randomBytes(32).toString("base64url");
    const run = kit.launch({
      SPLITPAGE_MANAGEMENT_SECRET: secret,
      SPLITPAGE_MAX_UPLOADS_IN_FLIGHT: "2"
    });
    const port = await run.port();
    const pictures = join(kit.directory, "pictures");
    const pngA = makePng("upload-limit-a");
    const pngB = makePng("upload-limit-b");
    const pngC = makePng("upload-limit-c");

    function startUpload(picture: { bytes: Buffer; sha: string }) {
      const req = httpRequest(`http://127.0.0.1:${port}/api/scripts/${NAME}/pictures/${picture.sha}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "image/png",
          "content-length": String(picture.bytes.length)
        }
      });
      req.on("error", () => undefined);
      const response = new Promise<IncomingMessage>((resolve, reject) => {
        req.once("response", resolve);
        req.once("error", reject);
      });
      response.catch(() => undefined);
      req.write(picture.bytes.subarray(0, 12));
      return { req, response };
    }

    async function readStatus(): Promise<RelayStatusSnapshot> {
      const response = await run.owner("status", {}, secret);
      assert.equal(response.status, 200);
      return await response.json() as RelayStatusSnapshot;
    }

    const first = startUpload(pngA);
    const second = startUpload(pngB);
    t.after(() => { first.req.destroy(); second.req.destroy(); });
    let bothStaged = false;
    for (let attempt = 0; attempt < 100 && !bothStaged; attempt++) {
      try {
        bothStaged = statSync(join(pictures, "upload-0")).size === 12 && statSync(join(pictures, "upload-1")).size === 12;
      } catch {
        bothStaged = false;
      }
      if (!bothStaged) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(bothStaged, true);

    const statusWhileFull = await readStatus();
    assert.equal(statusWhileFull.uploadsInFlight, 2);
    assert.equal(statusWhileFull.pictureBytes, 0);

    const third = startUpload(pngC);
    t.after(() => third.req.destroy());
    const refused = await third.response;
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.headers["retry-after"], "5");
    assert.equal(refused.headers["cache-control"], "no-store");
    refused.resume();
    assert.deepEqual(readdirSync(pictures).sort(), ["upload-0", "upload-1"]);

    first.req.destroy();
    let released = false;
    for (let attempt = 0; attempt < 50 && !released; attempt++) {
      if ((await readStatus()).uploadsInFlight === 1) released = true;
      else await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(released, true);

    const fourth = await fetch(`http://127.0.0.1:${port}/api/scripts/${NAME}/pictures/${pngC.sha}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
      body: new Uint8Array(pngC.bytes)
    });
    assert.equal(fourth.status, 201);

    second.req.end(pngB.bytes.subarray(12));
    const secondResponse = await second.response;
    assert.equal(secondResponse.statusCode, 201);
    secondResponse.resume();

    const finalStatus = await readStatus();
    assert.equal(finalStatus.uploadsInFlight, 0);
    assert.equal(finalStatus.pictureBytes, pngB.bytes.length + pngC.bytes.length);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("normal near-limit reconnect succeeds over small fragmented TCP chunks", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const baseState = kit.seed();
  const largeDoc = new Doc();
  t.after(() => largeDoc.destroy());
  applyUpdate(largeDoc, baseState);
  largeDoc.getMap("fixture").set("payload", new Uint8Array(14_000_000));
  const largeState = encodeStateAsUpdate(largeDoc);
  assert.ok(largeState.byteLength > 14_000_000 && largeState.byteLength < 15_000_000);
  const run = kit.launch();
  const relayPort = await run.port();
  const proxy = await openChunkingProxy(t, relayPort, 4096);

  const client = kit.copy(proxy.port);
  await kit.until(() => (client.relay.status().firstSyncDone && client.text() === "word") || undefined);
  appendText(client.session, " near-limit", 4);
  await kit.until(() => client.pending() === 0 || undefined);
  client.close();

  const returning = kit.copy(proxy.port, { kind: "state", state: largeState });
  appendText(returning.session, " reconnected", 4);
  await kit.until(() => (returning.relay.status().firstSyncDone && returning.pending() === 0) || undefined);
  assert.ok(proxy.chunksForwarded() > 2000);
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  const finalText = storedText(kit.directory);
  assert.ok(finalText?.includes("near-limit") && finalText?.includes("reconnected"));
});

test("unauthenticated queue message limit closes a client before authentication", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const run = kit.launch();
  const ws = connectSocket(t, await run.port());
  await once(ws, "open", { signal: t.signal });
  const closed = once(ws, "close", { signal: t.signal });
  for (let i = 0; i <= 40; i++) {
    const encoder = createEncoder();
    writeVarString(encoder, NAME);
    writeVarUint(encoder, MessageType.Sync);
    ws.send(toUint8Array(encoder));
  }
  await closed;
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  assert.match(run.errors(), /Relay library warning/);
});

test("permanent refusals stop reconnecting without destroying the local session", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const { id, token } = kit.provision(NAME);
  let activeToken: string;
  {
    using db = openWriter(kit.directory);
    db.exec("INSERT INTO scripts (name, status) VALUES ('deleted-script', 'deleted')");
    activeToken = scriptAccess(db).issue(NAME, "live", "owner").token;
  }
  const run = kit.launch();
  const port = await run.port();

  const providers: HocuspocusProvider[] = [];
  const attach = HocuspocusProvider.prototype.attach;
  t.mock.method(HocuspocusProvider.prototype, "attach", function (this: HocuspocusProvider) {
    providers.push(this);
    return attach.call(this);
  });

  const badToken = randomBytes(32).toString("base64url");
  const wrong = kit.copy(port, undefined, NAME, badToken);
  const wrongFailure = await kit.until(() => wrong.events.find(event => event.kind === "authentication-failed"));
  assert.equal(wrongFailure.reason, "permission-denied");
  const wrongProvider = providers.at(-1);
  assert.ok(wrongProvider);
  assert.equal(wrongProvider.configuration.websocketProvider.shouldConnect, false);
  assert.equal(wrong.session.ydoc.isDestroyed, false);

  const deleted = kit.copy(port, undefined, "deleted-script", token);
  const deletedFailure = await kit.until(() => deleted.events.find(event => event.kind === "authentication-failed"));
  assert.equal(deletedFailure.reason, "script-deleted");
  assert.equal(providers.at(-1)?.configuration.websocketProvider.shouldConnect, false);

  const live = kit.copy(port, undefined, NAME, activeToken);
  await kit.until(() => (live.relay.status().firstSyncDone && live.text() === "word") || undefined);
  const liveProvider = providers.at(-1);
  assert.ok(liveProvider);
  run.send(`revoke:${id}`);
  run.send(`delete:${NAME}`);
  const removed = await kit.until(() => live.events.find(event => event.kind === "authentication-failed"));
  assert.equal(removed.reason, "access-removed");
  assert.equal(liveProvider.configuration.websocketProvider.shouldConnect, false);
  assert.equal(live.session.ydoc.isDestroyed, false);
  assert.equal(live.text(), "word");

  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(wrong.events.filter(event => event.kind === "authentication-failed").length, 1);
  assert.equal(live.events.filter(event => event.kind === "authentication-failed").length, 1);
  assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
});

test("private status endpoint shares management auth, uses authoritative backup records and omits private data",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const state = kit.seed();
    const secret = randomBytes(32).toString("base64url");
    const wrongSecret = randomBytes(32).toString("base64url");
    const { token } = kit.provision(NAME);
    const backups = join(kit.directory, "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, "relay-2099-01-01T00-00-00.000Z-00000000-0000-4000-8000-000000000000.sqlite"), "unverified");

    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
    const port = await run.port();
    const creationId = `creation-${randomUUID()}`;
    const ownerScript = await run.createScript(creationId, state, secret);
    const inviteLabel = `private-label-${randomBytes(6).toString("hex")}`;
    const issuedResponse = await run.owner(`scripts/${ownerScript}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "guest", label: inviteLabel })
    }, secret);
    assert.equal(issuedResponse.status, 201);
    const issued = await issuedResponse.json() as { id: string; token: string };

    assert.equal((await run.owner("status", {}, null)).status, 401);
    assert.equal((await run.owner("status", {}, wrongSecret)).status, 401);
    const disallowed = await run.owner("status", { method: "POST" }, secret);
    assert.equal(disallowed.status, 405);
    assert.equal(disallowed.headers.get("allow"), "GET");
    assert.equal(disallowed.headers.get("cache-control"), "no-store");

    const client = kit.copy(port, undefined, NAME, token);
    await kit.until(() => (client.relay.status().firstSyncDone && client.text() === "word") || undefined);

    async function readStatus(): Promise<{ raw: string; data: RelayStatusSnapshot }> {
      const response = await run.owner("status", {}, secret);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const raw = await response.text();
      return { raw, data: JSON.parse(raw) as RelayStatusSnapshot };
    }

    const initial = await readStatus();
    assert.equal(initial.data.connections.total, 1);
    assert.equal(initial.data.connections.authenticated, 1);
    assert.equal(initial.data.connections.documents, 1);
    assert.equal(initial.data.uploadsInFlight, 0);
    assert.ok(initial.data.storedBytes > 0);
    assert.equal(initial.data.pictureBytes, 0);
    assert.equal(initial.data.lastStorageFailure, null);
    assert.equal(initial.data.lastBackupAt, null);

    await assert.rejects(backupRelay({ SPLITPAGE_DATA_DIR: kit.directory }, async () => {
      throw new Error("simulated backup copy failure");
    }));
    assert.equal((await readStatus()).data.lastBackupAt, null);

    const backupRun = kit.launch({ SPLITPAGE_DATA_DIR: kit.directory }, BACKUP);
    assert.deepEqual(await backupRun.exit, { code: 0, exitSignal: null }, backupRun.errors());
    const afterBackup = await readStatus();
    assert.ok(afterBackup.data.lastBackupAt !== null);
    assert.match(afterBackup.data.lastBackupAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(afterBackup.data.lastBackupAt.startsWith("2099-"), false);

    const uploaded = makePng("status-picture-bytes");
    const uploadResponse = await fetch(`http://127.0.0.1:${port}/api/scripts/${NAME}/pictures/${uploaded.sha}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
      body: new Uint8Array(uploaded.bytes)
    });
    assert.equal(uploadResponse.status, 201);
    const afterPicture = await readStatus();
    assert.equal(afterPicture.data.pictureBytes, uploaded.bytes.length);
    assert.equal(afterPicture.data.uploadsInFlight, 0);

    const sentinel = `private-trigger-${randomBytes(8).toString("hex")}`;
    {
      using db = new DatabaseSync(join(kit.directory, DB_NAME));
      db.exec(`CREATE TRIGGER fail_store BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT, '${sentinel}'); END`);
    }
    appendText(client.session, " failing", 4);
    let afterFailure: { raw: string; data: RelayStatusSnapshot } | undefined;
    for (let attempt = 0; attempt < 50 && !afterFailure; attempt++) {
      const result = await readStatus();
      if (result.data.lastStorageFailure) afterFailure = result;
      else await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.ok(afterFailure);
    assert.equal(afterFailure.data.lastStorageFailure?.reason, "document-store-failed");
    assert.match(afterFailure.data.lastStorageFailure?.at ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    {
      using db = new DatabaseSync(join(kit.directory, DB_NAME));
      db.exec("DROP TRIGGER fail_store");
    }
    for (const privateValue of [
      secret, wrongSecret, token, issued.token, issued.id, inviteLabel,
      creationId, ownerScript, NAME, kit.directory, uploaded.sha, sentinel, "word", "failing"
    ]) {
      assert.equal(afterFailure.raw.includes(privateValue), false);
    }
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    const logs = run.output() + run.errors();
    for (const privateValue of [secret, wrongSecret, token, issued.token, inviteLabel, uploaded.sha, sentinel]) {
      assert.equal(logs.includes(privateValue), false);
    }
  }
);

test("status endpoint refuses all requests when management secret is unset, and limit settings validate ranges",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const valid = { SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_ALLOWED_ORIGINS: ORIGIN };
    const defaults = relayConfig(valid);
    assert.equal(defaults.maxConnections, 64);
    assert.equal(defaults.maxConnectionsPerInvitation, 8);
    assert.equal(defaults.maxConnectionsPerGuestInvitation, 24);
    assert.equal(defaults.maxMessagesPerSecond, 60);
    assert.equal(defaults.maxUploadsInFlight, 4);
    assert.equal(defaults.managementSecret, undefined);
    for (const allowed of ["1", "2", "3", "4"]) {
      assert.equal(relayConfig({ ...valid, SPLITPAGE_MAX_UPLOADS_IN_FLIGHT: allowed }).maxUploadsInFlight, Number(allowed));
    }
    for (const [key, value] of [
      ["SPLITPAGE_MAX_CONNECTIONS", "0"],
      ["SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION", "0"],
      ["SPLITPAGE_MAX_CONNECTIONS_PER_GUEST_INVITATION", "0"],
      ["SPLITPAGE_MAX_CONNECTIONS_PER_GUEST_INVITATION", "10001"],
      ["SPLITPAGE_MAX_MESSAGES_PER_SECOND", "0"],
      ["SPLITPAGE_MAX_UPLOADS_IN_FLIGHT", "0"],
      ["SPLITPAGE_MAX_UPLOADS_IN_FLIGHT", "5"]
    ] as const) {
      assert.throws(() => relayConfig({ ...valid, [key]: value }), new RegExp(`${key} must be an integer`));
    }

    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: "" });
    const port = await run.port();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: "Bearer anything" } })).status, 401);
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

test("guest invitations reach their own default connection limit (24) independently of owner invitations (8)",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const state = kit.seed();
    const run = kit.launch();
    const created = await run.createScriptWithCredentials(randomUUID(), state);
    const { owner, guest } = created;
    assert.ok(owner && guest);
    const port = await run.port();
    const url = `ws://127.0.0.1:${port}?wire=1&schema=1`;

    function openGuestProvider(token: string) {
      const doc = new Doc();
      const events = new EventTarget();
      let failedReason: string | undefined;
      const client = new HocuspocusProvider({
        url, name: created.scriptId, token, document: doc, awareness: null,
        onSynced() { events.dispatchEvent(new Event("change")); },
        onAuthenticationFailed({ reason }) { failedReason = reason; events.dispatchEvent(new Event("change")); }
      });
      t.after(() => { client.destroy(); doc.destroy(); });
      return {
        client,
        failedReason: () => failedReason,
        async until(predicate: () => boolean) {
          while (!predicate()) await once(events, "change", { signal: t.signal });
        }
      };
    }

    const guests = Array.from({ length: 24 }, () => openGuestProvider(guest.token));
    await Promise.all(guests.map(entry => entry.until(() => entry.client.synced)));

    const overflowGuest = kit.copy(port, { kind: "empty" }, created.scriptId, guest.token);
    const guestRefusal = await kit.until(() => overflowGuest.events.find(event => event.kind === "temporary-refusal"));
    assert.equal(guestRefusal.reason, "too-many-connections");
    assert.equal(overflowGuest.events.some(event => event.kind === "authentication-failed"), false);
    assert.equal(overflowGuest.relay.status().firstSyncDone, false);

    const owners = Array.from({ length: 8 }, () => openGuestProvider(owner.token));
    await Promise.all(owners.map(entry => entry.until(() => entry.client.synced)));

    const overflowOwner = kit.copy(port, { kind: "empty" }, created.scriptId, owner.token);
    const ownerRefusal = await kit.until(() => overflowOwner.events.find(event => event.kind === "temporary-refusal"));
    assert.equal(ownerRefusal.reason, "too-many-connections");
    assert.equal(overflowOwner.events.some(event => event.kind === "authentication-failed"), false);

    guests[0]?.client.destroy();
    await kit.until(() => (overflowGuest.relay.status().firstSyncDone && overflowGuest.text() === "word") || undefined);
    owners[0]?.client.destroy();
    await kit.until(() => (overflowOwner.relay.status().firstSyncDone && overflowOwner.text() === "word") || undefined);

    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    const logs = run.output() + run.errors();
    assert.equal(logs.includes(owner.token), false);
    assert.equal(logs.includes(guest.token), false);
  }
);
