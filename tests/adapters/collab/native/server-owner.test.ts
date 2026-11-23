import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { backupRelay } from "../../../../collab-server/backup.ts";
import type { RelayStatusSnapshot } from "../../../../collab-server/status.ts";
import { DB_NAME, openWriter, verifyDatabase } from "../../../../collab-server/storage.ts";
import { appendText, serverHarness, storedState, storedText } from "./server-harness.ts";

test("owner commands initialize, issue, list, revoke and delete a shared script", { timeout: 25_000 }, async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  {
    using db = openWriter(kit.directory);
    db.prepare("INSERT INTO scripts VALUES (?, 'pending')").run("pending-script");
  }
  const secret = randomBytes(32).toString("base64url");
  const wrong = randomBytes(32).toString("base64url");
  const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
  const create = { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: Buffer.from(state) };
  assert.equal((await run.owner("scripts", create, null)).status, 401);
  assert.equal((await run.owner("scripts", create, wrong)).status, 401);
  assert.equal((await run.owner("scripts", { ...create, body: null }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { ...create, body: Uint8Array.of(255) }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { ...create, body: Buffer.alloc(15_000_001) }, secret)).status, 413);
  const id = create.headers["Idempotency-Key"];
  const [script, retry] = await Promise.all([run.createScript(id, state, secret), run.createScript(id, state, secret)]);
  assert.equal(script, retry);
  assert.deepEqual(storedState(kit.directory, script), state);
  const ownerPort = await run.port();
  const expectRetries = async () => {
    for (const body of [null, Uint8Array.of(255)]) {
      const response = await run.owner("scripts", { ...create, body }, secret);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { scriptId: script });
    }
    const oversized = await new Promise<{ status: number | undefined; connection: string | undefined; body: string }>((resolve, reject) => {
      const upload = request({
        hostname: "127.0.0.1", port: ownerPort, path: "/api/scripts", method: "POST",
        headers: { ...create.headers, Authorization: `Bearer ${secret}`, "Content-Length": "15000001" },
        signal: t.signal
      }, async response => {
        try {
          let body = "";
          response.setEncoding("utf8");
          for await (const chunk of response) body += chunk;
          resolve({ status: response.statusCode, connection: response.headers.connection, body });
        } catch (error) {
          reject(error);
        }
      });
      upload.on("error", reject);
      upload.flushHeaders();
    });
    assert.deepEqual(oversized, { status: 200, connection: "close", body: JSON.stringify({ scriptId: script }) });
  };
  await expectRetries();
  assert.deepEqual(storedState(kit.directory, script), state);

  const path = `scripts/${script}/invitations`;
  const issue = { method: "POST", body: "Reader" };
  const remove = { method: "DELETE" };
  assert.equal((await run.owner("scripts/pending-script/invitations", issue, secret)).status, 409);
  const issued = await run.owner(path, issue, secret);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const invitation = await issued.json() as { id: string; token: string };
  assert.ok(/^[a-zA-Z0-9_-]{43}$/.test(invitation.token));
  const fresh = kit.copy(await run.port(), { kind: "empty" }, script, invitation.token);
  t.after(fresh.session.close);
  await kit.until(() => fresh.relay.status().firstSyncDone && fresh.text() === "word" || undefined);
  const list = async (state: string) => {
    const reply = await run.owner(path, {}, secret);
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), [{ id: invitation.id, label: "Reader", state }]);
  };
  await list("active");
  const picture = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
  const sha = createHash("sha256").update(picture).digest("hex");
  const picturePath = "scripts/" + script + "/pictures/" + sha;
  const upload = { method: "PUT", headers: { "Content-Type": "image/png" }, body: picture };
  assert.equal((await run.owner(picturePath, upload, secret)).status, 403);
  assert.equal((await run.owner(picturePath, upload, invitation.token)).status, 201);
  const download = await run.owner(picturePath, {}, invitation.token);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), picture);
  assert.equal((await run.owner(`invitations/${invitation.id}`, remove, secret)).status, 204);
  await list("revoked");
  assert.equal((await run.owner(picturePath, {}, invitation.token)).status, 403);
  assert.equal((await run.owner(`scripts/${script}`, remove, secret)).status, 204);
  assert.equal((await run.owner(path, issue, secret)).status, 409);
  await expectRetries();
  await run.stop("clean");
  const restarted = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
  assert.equal(await restarted.createScript(id, state, secret), script);
  assert.equal((await restarted.owner(path, issue, secret)).status, 409);
  for (const process of [run, restarted]) {
    const logs = process.output() + process.errors();
    assert.ok(![secret, wrong, invitation.token, "Reader"].some(value => logs.includes(value)));
  }
});

test("rotating the management secret across relay restart rejects the retired secret and preserves data and invitations", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const initialSecret = randomBytes(32).toString("base64url");
  let replacementSecret = randomBytes(32).toString("base64url");
  while (replacementSecret === initialSecret) replacementSecret = randomBytes(32).toString("base64url");
  assert.equal(replacementSecret !== initialSecret, true, "replacement secret must differ from initial secret");

  const initial = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: initialSecret });
  const creationId = randomUUID();
  const scriptId = await initial.createScript(creationId, state, initialSecret);
  const invitationsPath = `scripts/${scriptId}/invitations`;
  const issuedInitial = await initial.owner(invitationsPath, { method: "POST", body: "Before Rotation" }, initialSecret);
  assert.equal(issuedInitial.status, 201);
  assert.equal(issuedInitial.headers.get("cache-control"), "no-store");
  const existingInvite = await issuedInitial.json() as { id: string; token: string };
  assert.equal(/^[a-zA-Z0-9_-]{43}$/.test(existingInvite.token), true, "initial invitation token must match expected format");

  const writer = kit.copy(await initial.port(), { kind: "empty" }, scriptId, existingInvite.token);
  t.after(writer.session.close);
  await kit.until(() => (writer.relay.status().firstSyncDone && writer.text() === "word") || undefined);
  appendText(writer.session, " before-rotation", 4);
  await kit.until(() => (writer.pending() === 0 && storedText(kit.directory, scriptId) === "word before-rotation") || undefined);

  const picture = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
    Buffer.from("secret-rotation-picture", "utf8")
  ]);
  const pictureSha = createHash("sha256").update(picture).digest("hex");
  const picturePath = `scripts/${scriptId}/pictures/${pictureSha}`;
  const upload = await initial.owner(picturePath, {
    method: "PUT", headers: { "Content-Type": "image/png" }, body: picture
  }, existingInvite.token);
  assert.equal(upload.status, 201);

  assert.equal((await initial.owner("status", {}, replacementSecret)).status, 401);
  assert.equal((await initial.owner(invitationsPath, {}, replacementSecret)).status, 401);
  const statusBefore = await initial.owner("status", {}, initialSecret);
  assert.equal(statusBefore.status, 200);
  const statusBeforeData = await statusBefore.json() as RelayStatusSnapshot;
  assert.ok(statusBeforeData.storedBytes > 0);
  assert.equal(statusBeforeData.pictureBytes, picture.length);
  const listBefore = await initial.owner(invitationsPath, {}, initialSecret);
  assert.equal(listBefore.status, 200);
  assert.deepEqual(await listBefore.json(), [{ id: existingInvite.id, label: "Before Rotation", state: "active" }]);

  writer.close();
  assert.deepEqual(await initial.stop("clean"), { code: 0, exitSignal: null });
  const stateBeforeRotation = storedState(kit.directory, scriptId);

  const rotated = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: replacementSecret });
  assert.equal((await rotated.owner("status", {}, null)).status, 401);
  assert.equal((await rotated.owner(invitationsPath, {}, null)).status, 401);
  assert.equal((await rotated.owner("status", {}, initialSecret)).status, 401);
  assert.equal((await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": creationId } }, initialSecret)).status, 401);
  assert.equal((await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: Buffer.from(state) }, initialSecret)).status, 401);
  assert.equal((await rotated.owner(invitationsPath, {}, initialSecret)).status, 401);
  assert.equal((await rotated.owner(invitationsPath, { method: "POST", body: "Retired Attempt" }, initialSecret)).status, 401);
  assert.equal((await rotated.owner(`invitations/${existingInvite.id}`, { method: "DELETE" }, initialSecret)).status, 401);
  assert.equal((await rotated.owner(`scripts/${scriptId}`, { method: "DELETE" }, initialSecret)).status, 401);

  const statusAfter = await rotated.owner("status", {}, replacementSecret);
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.headers.get("cache-control"), "no-store");
  const statusAfterRaw = await statusAfter.text();
  const statusAfterData = JSON.parse(statusAfterRaw) as RelayStatusSnapshot;
  assert.ok(statusAfterData.storedBytes > 0);
  assert.equal(statusAfterData.pictureBytes, picture.length);
  assert.equal(statusAfterData.lastStorageFailure, null);

  const listAfter = await rotated.owner(invitationsPath, {}, replacementSecret);
  assert.equal(listAfter.status, 200);
  assert.deepEqual(await listAfter.json(), [{ id: existingInvite.id, label: "Before Rotation", state: "active" }]);
  const retryAfter = await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": creationId } }, replacementSecret);
  assert.equal(retryAfter.status, 200);
  assert.deepEqual(await retryAfter.json(), { scriptId });
  assert.deepEqual(storedState(kit.directory, scriptId), stateBeforeRotation);

  const issuedAfter = await rotated.owner(invitationsPath, { method: "POST", body: "After Rotation" }, replacementSecret);
  assert.equal(issuedAfter.status, 201);
  assert.equal(issuedAfter.headers.get("cache-control"), "no-store");
  const postInvite = await issuedAfter.json() as { id: string; token: string };
  assert.equal(/^[a-zA-Z0-9_-]{43}$/.test(postInvite.token), true, "replacement-issued invitation token must match expected format");

  const rotatedPort = await rotated.port();
  const survivingPeer = kit.copy(rotatedPort, { kind: "empty" }, scriptId, existingInvite.token);
  const postPeer = kit.copy(rotatedPort, { kind: "empty" }, scriptId, postInvite.token);
  t.after(() => { survivingPeer.session.close(); postPeer.session.close(); });
  await kit.until(() => (
    survivingPeer.relay.status().firstSyncDone && survivingPeer.text() === "word before-rotation" &&
    postPeer.relay.status().firstSyncDone && postPeer.text() === "word before-rotation"
  ) || undefined);

  const downloadedBeforeRevoke = await rotated.owner(picturePath, {}, existingInvite.token);
  assert.equal(downloadedBeforeRevoke.status, 200);
  assert.deepEqual(Buffer.from(await downloadedBeforeRevoke.arrayBuffer()), picture);

  appendText(survivingPeer.session, " after-rotation", "word before-rotation".length);
  await kit.until(() => (
    postPeer.text() === "word before-rotation after-rotation" &&
    storedText(kit.directory, scriptId) === "word before-rotation after-rotation"
  ) || undefined);

  assert.equal((await rotated.owner(`invitations/${existingInvite.id}`, { method: "DELETE" }, replacementSecret)).status, 204);
  const revokedEvent = await kit.until(() => survivingPeer.events.find(event => event.kind === "authentication-failed"));
  assert.equal(revokedEvent.reason, "access-removed");
  assert.equal((await rotated.owner(picturePath, {}, existingInvite.token)).status, 403);
  const downloadedWithPostInvite = await rotated.owner(picturePath, {}, postInvite.token);
  assert.equal(downloadedWithPostInvite.status, 200);
  assert.deepEqual(Buffer.from(await downloadedWithPostInvite.arrayBuffer()), picture);

  const expectedList = [
    { id: existingInvite.id, label: "Before Rotation", state: "revoked" },
    { id: postInvite.id, label: "After Rotation", state: "active" }
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const listFinal = await rotated.owner(invitationsPath, {}, replacementSecret);
  assert.equal(listFinal.status, 200);
  assert.deepEqual(await listFinal.json(), expectedList);

  survivingPeer.close();
  postPeer.close();
  assert.deepEqual(await rotated.stop("clean"), { code: 0, exitSignal: null });
  assert.equal(storedText(kit.directory, scriptId), "word before-rotation after-rotation");

  const sensitiveValues = [
    initialSecret, replacementSecret, existingInvite.token, postInvite.token,
    "Before Rotation", "After Rotation", "Retired Attempt", pictureSha,
    "before-rotation", "after-rotation"
  ];
  assert.equal(sensitiveValues.some(value => statusAfterRaw.includes(value)), false, "status output must not disclose credentials or private values");
  for (const process of [initial, rotated]) {
    const logs = process.output() + process.errors();
    assert.equal(sensitiveValues.some(value => logs.includes(value)), false, "relay logs must not disclose credentials or private values");
  }
});

for (const version of [1, 2]) {
  test("the relay upgrades populated storage from version " + version, { timeout: 25_000 }, async t => {
    const kit = serverHarness(t);
    const previous = "previous-script";
    const state = kit.seed(previous);
    const { id, token } = kit.provision(previous);
    const creationId = randomUUID();
    let created: string | undefined;
    const path = join(kit.directory, DB_NAME);
    {
      using db = new DatabaseSync(path);
      db.exec("DROP TABLE script_pictures");
      if (version === 1) db.exec("DROP TABLE creations");
      else created = scriptAccess(db).create(creationId, state);
      db.exec("PRAGMA user_version=" + version);
      assert.equal(verifyDatabase(db), version);
    }
    const env = { SPLITPAGE_DATA_DIR: kit.directory };
    const previousBackup = await backupRelay(env);
    const run = kit.launch({}, new URL("./server-process.ts", import.meta.url));
    const response = await run.owner("scripts/previous-script/invitations");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id, label: "test invitation", state: "active" }]);
    assert.deepEqual(storedState(kit.directory, previous), state);
    const peer = kit.copy(await run.port(), { kind: "empty" }, previous, token);
    await kit.until(() => peer.relay.status().firstSyncDone && peer.text() === "word" || undefined);
    const restored = await run.createScript(creationId, state);
    if (created !== undefined) assert.equal(restored, created);
    assert.deepEqual(storedState(kit.directory, restored), state);
    const currentBackup = await backupRelay(env);
    for (const [file, expectedVersion] of [[previousBackup, version], [currentBackup, 3]] as const) {
      using copy = new DatabaseSync(join(kit.directory, "backups", file, DB_NAME), { readOnly: true });
      assert.equal(verifyDatabase(copy), expectedVersion);
      if (expectedVersion >= 2) {
        assert.equal(copy.prepare("SELECT script FROM creations WHERE id = ?").get(creationId)?.script, restored);
      }
    }
    using live = new DatabaseSync(path, { readOnly: true });
    assert.equal(verifyDatabase(live), 3);
    assert.equal(live.prepare("SELECT count(*) AS count FROM script_pictures").get()?.count, 0);
  });
}
