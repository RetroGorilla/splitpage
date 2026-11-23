import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { backupRelay } from "../../../../collab-server/backup.ts";
import { DB_NAME, openWriter, verifyDatabase } from "../../../../collab-server/storage.ts";
import { serverHarness, storedState } from "./server-harness.ts";

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
