import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { WebSocket } from "ws";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { relayConfig } from "../../../../collab-server/config.ts";
import type { RelayStatusSnapshot } from "../../../../collab-server/status.ts";
import { DB_NAME, openWriter } from "../../../../collab-server/storage.ts";
import { appendText, NAME, ORIGIN, serverHarness } from "./server-harness.ts";

const BACKUP = new URL("../../../../collab-server/backup-command.ts", import.meta.url);

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
      secondInvite = scriptAccess(db).issue(NAME, "second invite");
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

test("message rate limit closes a flooding client with 4429 before applying excess updates and permits reconnect",
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

test("in-flight upload limit refuses excess picture uploads with 503 before running the upload handler",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const run = kit.launch({ SPLITPAGE_MAX_UPLOADS_IN_FLIGHT: "2" });
    const port = await run.port();
    run.send("hold-uploads");
    await kit.until(() => run.messages.includes("uploads-armed") || undefined);

    const sha = createHash("sha256").update("picture").digest("hex");
    const uploadUrl = `http://127.0.0.1:${port}/api/scripts/${NAME}/pictures/${sha}`;
    function startUpload() {
      const req = httpRequest(uploadUrl, { method: "PUT", headers: { "content-type": "image/png" } });
      req.on("error", () => undefined);
      const response = once(req, "response", { signal: t.signal }).then(([res]) => res as IncomingMessage);
      req.write(Buffer.from([1, 2, 3, 4]));
      return { req, response };
    }

    const enteredCount = () => run.messages.filter(message => message === "upload-entered").length;
    const first = startUpload();
    const second = startUpload();
    t.after(() => { first.req.destroy(); second.req.destroy(); });
    await kit.until(() => enteredCount() === 2 || undefined);

    const third = startUpload();
    t.after(() => third.req.destroy());
    const refused = await third.response;
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.headers["retry-after"], "5");
    assert.equal(refused.headers["cache-control"], "no-store");
    const chunks: Buffer[] = [];
    for await (const chunk of refused) chunks.push(chunk as Buffer);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), { error: "too-many-uploads" });
    assert.equal(enteredCount(), 2);

    run.send("release-upload");
    const firstResponse = await first.response;
    assert.equal(firstResponse.statusCode, 201);
    firstResponse.resume();
    first.req.destroy();

    const fourth = startUpload();
    t.after(() => fourth.req.destroy());
    await kit.until(() => enteredCount() === 3 || undefined);
    run.send("release-upload");
    run.send("release-upload");
    const [secondResponse, fourthResponse] = await Promise.all([second.response, fourth.response]);
    assert.equal(secondResponse.statusCode, 201);
    assert.equal(fourthResponse.statusCode, 201);
    secondResponse.resume();
    fourthResponse.resume();
    second.req.destroy();
    fourth.req.destroy();
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);

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
    db.exec("INSERT INTO scripts VALUES ('deleted-script', 'deleted')");
    activeToken = scriptAccess(db).issue(NAME, "live").token;
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

test("private status endpoint requires management secret and reports counts, bytes, storage failure and backup time without private data",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed();
    const secret = randomBytes(32).toString("base64url");
    const wrongSecret = randomBytes(32).toString("base64url");
    const { token } = kit.provision(NAME);
    const pictures = join(kit.directory, "pictures");
    mkdirSync(pictures, { recursive: true });
    const pictureBytes = Buffer.alloc(1234, 7);
    const pictureHash = createHash("sha256").update(pictureBytes).digest("hex");
    writeFileSync(join(pictures, pictureHash), pictureBytes);
    writeFileSync(join(pictures, "upload-0"), Buffer.alloc(9999, 1));

    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
    const port = await run.port();
    const statusUrl = `http://127.0.0.1:${port}/api/status`;

    assert.equal((await fetch(statusUrl)).status, 401);
    assert.equal((await fetch(statusUrl, { headers: { Authorization: `Bearer ${wrongSecret}` } })).status, 401);
    const disallowed = await fetch(statusUrl, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(disallowed.status, 405);
    assert.equal(disallowed.headers.get("allow"), "GET");
    assert.equal(disallowed.headers.get("cache-control"), "no-store");

    const client = kit.copy(port, undefined, NAME, token);
    await kit.until(() => (client.relay.status().firstSyncDone && client.text() === "word") || undefined);

    async function readStatus(): Promise<{ raw: string; data: RelayStatusSnapshot }> {
      const response = await fetch(statusUrl, { headers: { Authorization: `Bearer ${secret}` } });
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
    assert.equal(initial.data.pictureBytes, 1234);
    assert.equal(initial.data.lastStorageFailure, null);
    assert.equal(initial.data.lastBackupAt, null);

    const backupRun = kit.launch({ SPLITPAGE_DATA_DIR: kit.directory }, BACKUP);
    assert.deepEqual(await backupRun.exit, { code: 0, exitSignal: null }, backupRun.errors());
    const afterBackup = await readStatus();
    assert.ok(afterBackup.data.lastBackupAt !== null);
    assert.match(afterBackup.data.lastBackupAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

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
    for (const privateValue of [secret, wrongSecret, token, NAME, kit.directory, pictureHash, sentinel, "word", "failing"]) {
      assert.equal(afterFailure.raw.includes(privateValue), false);
    }
    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    const logs = run.output() + run.errors();
    for (const privateValue of [secret, wrongSecret, token, sentinel]) {
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
    assert.equal(defaults.maxMessagesPerSecond, 60);
    assert.equal(defaults.maxUploadsInFlight, 4);
    assert.equal(defaults.managementSecret, undefined);
    for (const [key, value] of [
      ["SPLITPAGE_MAX_CONNECTIONS", "0"],
      ["SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION", "0"],
      ["SPLITPAGE_MAX_MESSAGES_PER_SECOND", "0"],
      ["SPLITPAGE_MAX_UPLOADS_IN_FLIGHT", "0"],
      ["SPLITPAGE_MAX_UPLOADS_IN_FLIGHT", "101"]
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
