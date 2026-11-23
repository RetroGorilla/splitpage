import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DB_NAME, openWriter } from "../../../../collab-server/storage.ts";
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
  assert.equal((await run.owner(`invitations/${invitation.id}`, remove, secret)).status, 204);
  await list("revoked");
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

test("the owner API preserves Part 1 access records when upgrading storage", { timeout: 25_000 }, async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const { id } = kit.provision("previous-script");
  {
    using db = new DatabaseSync(join(kit.directory, DB_NAME));
    db.exec("DROP TABLE creations; PRAGMA user_version=1");
  }
  const run = kit.launch({}, new URL("./server-process.ts", import.meta.url));
  const response = await run.owner("scripts/previous-script/invitations");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id, label: "test invitation", state: "active" }]);
  await run.createScript(randomUUID(), state);
});
