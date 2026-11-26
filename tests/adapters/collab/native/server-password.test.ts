import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { backupRelay, restoreRelay } from "../../../../collab-server/backup.ts";
import { DB_NAME, MAX_DEVICE_CREDENTIALS_PER_SCRIPT, verifyDatabase } from "../../../../collab-server/storage.ts";
import { appendText, ORIGIN, serverHarness } from "./server-harness.ts";

type Harness = ReturnType<typeof serverHarness>;
type Run = ReturnType<Harness["launch"]>;
type Copy = ReturnType<Harness["copy"]>;

function passwordRequest(password: string | null, method = "POST", origin = ORIGIN): RequestInit {
  return { method, headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }) };
}

async function exchange(run: Run, script: string, link: string, password: string): Promise<string> {
  const response = await run.owner(`scripts/${script}/password-exchange`, passwordRequest(password), link);
  assert.equal(response.status, 200);
  const { token } = await response.json() as { token: string };
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(token !== link, "each protected admission issues a separate credential");
  return token;
}

async function refused(kit: Harness, copy: Copy, reason: string): Promise<void> {
  const event = await kit.until(() => copy.events.find(event => event.kind === "authentication-failed"));
  assert.deepEqual(event, { kind: "authentication-failed", reason });
  assert.equal(copy.relay.status().connected, false);
}

test("a protected creation rejects raw credentials from the first request, and limits exchanges across origins per script", async t => {
  const kit = serverHarness(t);
  const password = "création 🙌 " + randomUUID();
  const secondOrigin = "https://also-allowed.example";
  const run = kit.launch({ SPLITPAGE_ALLOWED_ORIGINS: [ORIGIN, secondOrigin].join(",") });
  const state = kit.seed();
  const { scriptId, owner, guest, passwordRequired } = await run.createScriptWithCredentials(randomUUID(), state, undefined, password);
  assert.equal(passwordRequired, true);
  assert.ok(owner && guest);
  const path = `scripts/${scriptId}/password-exchange`;
  const port = await run.port();
  await refused(kit, kit.copy(port, undefined, scriptId, guest.token), "password-changed");
  assert.equal((await run.owner(`scripts/${scriptId}/versions`, {}, guest.token)).status, 403);
  assert.equal((await run.owner(path, passwordRequest(null), guest.token)).status, 428);
  const options = await run.owner(path, { method: "OPTIONS", headers: {
    Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"
  } }, null);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(options.headers.get("Vary"), "Origin");
  assert.equal(options.headers.get("Cache-Control"), "no-store");
  assert.equal(options.headers.get("Access-Control-Allow-Methods"), "POST");
  const denied = await run.owner(path, passwordRequest(password, "POST", "https://unlisted.example"), guest.token);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(denied.headers.get("Vary"), "Origin");
  const guests = new Set<string>();
  for (let attempt = 0; attempt < 12; attempt++) guests.add(await exchange(run, scriptId, guest.token, password));
  assert.equal(guests.size, 12);
  for (let attempt = 0; attempt < 5; attempt++) {
    const origin = attempt % 2 ? ORIGIN : secondOrigin;
    const wrong = await run.owner(path, passwordRequest("Wrong password!", "POST", origin), guest.token);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(wrong.headers.get("Cache-Control"), "no-store");
  }
  const token = guests.values().next().value;
  assert.ok(token);
  const live = kit.copy(port, undefined, scriptId, token);
  await kit.until(() => live.relay.status().firstSyncDone || undefined);
  const capped = await run.owner(path, passwordRequest(password), guest.token);
  assert.equal(capped.status, 429);
  assert.equal(capped.headers.get("Retry-After"), "60");
  assert.equal(await capped.text(), "");
  const other = await run.createScriptWithCredentials(randomUUID(), state, undefined, password);
  assert.ok(other.guest);
  await exchange(run, other.scriptId, other.guest.token, password);
  assert.equal((await run.stop("clean")).code, 0);
  assert.ok(![run.output(), run.errors()].join("\n").includes(password), "relay logs must not disclose the password");
  assert.ok(!readFileSync(join(kit.directory, DB_NAME)).includes(password), "database must not store the plaintext password");
});

test("exchanged credentials share their link's connection quota and churn cannot evict connected devices or grow the table", async t => {
  const kit = serverHarness(t);
  const run = kit.launch({ SPLITPAGE_MAX_CONNECTIONS_PER_GUEST_INVITATION: "2", SPLITPAGE_TEST_REPORT_AUTH: "1" });
  const password = "Guest quota fixture";
  const { scriptId, owner, guest } = await run.createScriptWithCredentials(randomUUID(), kit.seed(), undefined, password);
  assert.ok(owner && guest);
  const port = await run.port();
  const first = await exchange(run, scriptId, guest.token, password);
  const unused = await exchange(run, scriptId, guest.token, password);
  const revoked = await exchange(run, scriptId, guest.token, password);
  const recoveryPath = `scripts/${scriptId}/password-exchange`;
  const checkLink = passwordRequest(null);
  using db = new DatabaseSync(join(kit.directory, DB_NAME), { readOnly: true });
  assert.equal(verifyDatabase(db), 8);
  const deviceId = db.prepare("SELECT id FROM invitations WHERE token_hash = ?");
  const revokedId = deviceId.get(createHash("sha256").update(revoked).digest())?.id;
  assert.equal(typeof revokedId, "string");
  assert.equal((await run.owner(`invitations/${revokedId}`, { method: "DELETE" })).status, 204);
  await refused(kit, kit.copy(port, undefined, scriptId, revoked), "access-removed");
  const eligible = await run.owner(recoveryPath, checkLink, guest.token);
  assert.equal(eligible.status, 428);
  assert.equal(eligible.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const second = await exchange(run, scriptId, guest.token, password);
  const extra = await exchange(run, scriptId, guest.token, password);
  const active = kit.copy(port, undefined, scriptId, first);
  const other = kit.copy(port, undefined, scriptId, second);
  const managing = kit.copy(port, undefined, scriptId, owner.token);
  await kit.until(() => [active, other, managing].every(copy => copy.relay.status().firstSyncDone) || undefined);
  const waiting = kit.copy(port, undefined, scriptId, extra);
  await kit.until(() => waiting.events.some(event => event.kind === "temporary-refusal" && event.reason === "too-many-connections") || undefined);
  assert.equal(waiting.relay.status().firstSyncDone, false);
  other.close();
  await kit.until(() => waiting.relay.status().firstSyncDone || undefined);
  const rows = db.prepare("SELECT id, parent_link, revoked FROM invitations WHERE script = ? AND kind = 'device' ORDER BY rowid");
  assert.ok(rows.all(scriptId).every(row => row.parent_link === guest.id));
  for (let count = 5; count <= MAX_DEVICE_CREDENTIALS_PER_SCRIPT + 2; count++) {
    await exchange(run, scriptId, guest.token, password);
  }
  assert.equal(rows.all(scriptId).length, MAX_DEVICE_CREDENTIALS_PER_SCRIPT);
  assert.equal(deviceId.get(createHash("sha256").update(revoked).digest()), undefined);
  await refused(kit, kit.copy(port, undefined, scriptId, revoked), "permission-denied");
  await exchange(run, scriptId, guest.token, password);
  await refused(kit, kit.copy(port, undefined, scriptId, unused), "permission-denied");
  assert.equal((await run.owner(`scripts/${scriptId}/versions`, {}, first)).status, 200);
  assert.equal((await run.owner(`scripts/${scriptId}/versions`, {}, extra)).status, 200);
  assert.ok(active.relay.status().connected && waiting.relay.status().connected && managing.relay.status().connected);
  const reset = await run.owner(`scripts/${scriptId}/reset`, { method: "POST" }, owner.token);
  assert.equal(reset.status, 200);
  assert.equal((await run.owner(recoveryPath, checkLink, guest.token)).status, 403);
  const next = await reset.json() as { id: string; token: string };
  await refused(kit, active, "access-removed");
  await exchange(run, scriptId, next.token, password);
  const retained = rows.all(scriptId);
  assert.equal(retained.length, MAX_DEVICE_CREDENTIALS_PER_SCRIPT);
  assert.deepEqual(retained.filter(row => !row.revoked).map(row => row.parent_link), [next.id]);
  assert.equal((await run.owner(`scripts/${scriptId}`, { method: "DELETE" }, owner.token)).status, 204);
  assert.equal((await run.owner(recoveryPath, checkLink, next.token)).status, 403);
  assert.equal((await run.owner(recoveryPath, passwordRequest(password), next.token)).status, 403);
});

test("requiring, changing, removing and resetting a link updates guests without disconnecting either owner", async t => {
  const kit = serverHarness(t);
  const run = kit.launch({ SPLITPAGE_VERSION_INTERVAL_MS: "1" });
  const { scriptId, owner, guest } = await run.createScriptWithCredentials(randomUUID(), kit.seed());
  assert.ok(owner && guest);
  const path = `scripts/${scriptId}`;
  const port = await run.port();
  const extraInvite = await run.owner(path + "/invitations", {
    method: "POST", body: JSON.stringify({ role: "owner", label: "Second owner" })
  });
  assert.equal(extraInvite.status, 201);
  const second = (await extraInvite.json() as { token: string }).token;
  const firstOwner = kit.copy(port, undefined, scriptId, owner.token);
  const secondOwner = kit.copy(port, undefined, scriptId, second);
  const raw = kit.copy(port, undefined, scriptId, guest.token);
  await kit.until(() => [firstOwner, secondOwner, raw].every(copy => copy.relay.status().firstSyncDone) || undefined);
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
  const sha = createHash("sha256").update(png).digest("hex");
  const picture = path + "/pictures/" + sha;
  assert.equal((await run.owner(picture, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png }, owner.token)).status, 201);
  const change = (password: string | null) => run.owner(path + "/password", passwordRequest(password, "PUT"), owner.token);
  assert.equal((await run.owner(path + "/password", passwordRequest("Unauthorised", "PUT"), guest.token)).status, 403);
  assert.equal((await change("First password")).status, 204);
  await refused(kit, raw, "password-changed");
  await refused(kit, kit.copy(port, undefined, scriptId, guest.token), "password-changed");
  assert.equal((await run.owner(picture, {}, guest.token)).status, 403);
  assert.equal((await run.owner(path + "/versions", {}, guest.token)).status, 403);
  const activeToken = await exchange(run, scriptId, guest.token, "First password");
  const offlineToken = await exchange(run, scriptId, guest.token, "First password");
  const active = kit.copy(port, undefined, scriptId, activeToken);
  const offline = kit.copy(port, undefined, scriptId, offlineToken);
  await kit.until(() => active.relay.status().firstSyncDone && offline.relay.status().firstSyncDone || undefined);
  offline.close();
  assert.equal((await change("Second password")).status, 204);
  await refused(kit, active, "password-changed");
  await refused(kit, kit.copy(port, undefined, scriptId, offlineToken), "password-changed");
  assert.equal((await run.owner(picture, {}, activeToken)).status, 403);
  assert.equal((await run.owner(path + "/versions", {}, offlineToken)).status, 403);
  const updated = await exchange(run, scriptId, guest.token, "Second password");
  const image = await run.owner(picture, {}, updated);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  let version: string | undefined;
  while (!version) {
    const listed = await run.owner(path + "/versions", {}, updated);
    assert.equal(listed.status, 200);
    version = (await listed.json() as { id: string }[])[0]?.id;
    if (!version) await delay(15, undefined, { signal: t.signal });
  }
  const snapshot = await run.owner(path + "/versions/" + version, {}, updated);
  assert.equal(snapshot.status, 200);
  assert.ok((await snapshot.arrayBuffer()).byteLength > 0);
  const current = kit.copy(port, undefined, scriptId, updated);
  await kit.until(() => current.relay.status().firstSyncDone || undefined);
  const reset = await run.owner(path + "/reset", { method: "POST" }, second);
  assert.equal(reset.status, 200);
  const next = (await reset.json() as { token: string }).token;
  await refused(kit, current, "access-removed");
  await refused(kit, kit.copy(port, undefined, scriptId, offlineToken), "access-removed");
  assert.equal((await run.owner(path + "/password-exchange", passwordRequest("Second password"), guest.token)).status, 403);
  await refused(kit, kit.copy(port, undefined, scriptId, next), "password-changed");
  const beforeRemoval = await exchange(run, scriptId, next, "Second password");
  const removing = kit.copy(port, undefined, scriptId, beforeRemoval);
  await kit.until(() => removing.relay.status().firstSyncDone || undefined);
  assert.equal((await change(null)).status, 204);
  await refused(kit, removing, "password-changed");
  const publicLink = await run.owner(path + "/password-exchange", passwordRequest(null), next);
  assert.equal(publicLink.status, 200);
  assert.ok((await publicLink.json() as { token: string }).token === next);
  const newcomer = kit.copy(port, undefined, scriptId, next);
  await kit.until(() => newcomer.relay.status().firstSyncDone || undefined);
  appendText(firstOwner.session, " owner edit", 4);
  await kit.until(() => secondOwner.text() === "word owner edit" || undefined);
  assert.ok([firstOwner, secondOwner].every(copy => !copy.events.some(event => event.kind === "authentication-failed")));
});

test("v5 data upgrades in place and password records survive verified backup and restore", async t => {
  const kit = serverHarness(t);
  const first = kit.launch();
  const state = kit.seed();
  const { scriptId, owner, guest } = await first.createScriptWithCredentials(randomUUID(), state);
  assert.ok(owner && guest);
  await first.stop("clean");
  const database = join(kit.directory, DB_NAME);
  {
    using v5 = new DatabaseSync(database);
    v5.exec(`DROP INDEX script_device_credentials; ALTER TABLE invitations DROP COLUMN parent_link;
      ALTER TABLE invitations DROP COLUMN revocation_reason; ALTER TABLE invitations DROP COLUMN kind;
      DROP TABLE link_passwords; DROP TABLE version_editors; PRAGMA user_version = 5`);
    assert.equal(verifyDatabase(v5), 5);
  }
  const run = kit.launch();
  await run.port();
  const path = `scripts/${scriptId}`;
  assert.equal((await run.owner(path + "/password", passwordRequest("Keep across backup", "PUT"), owner.token)).status, 204);
  assert.equal((await run.owner(path + "/password-exchange", passwordRequest(null), guest.token)).status, 428);
  using source = new DatabaseSync(database, { readOnly: true });
  const keys = "SELECT script, salt, key FROM link_passwords";
  assert.equal(verifyDatabase(source), 8);
  const record = source.prepare(keys).get();
  assert.ok(record?.salt instanceof Uint8Array && record.key instanceof Uint8Array);
  assert.equal(record.salt.byteLength, 32);
  assert.equal(record.key.byteLength, 32);
  const archive = await backupRelay({ SPLITPAGE_DATA_DIR: kit.directory });
  const target = join(kit.directory, "restored");
  await restoreRelay(join(kit.directory, "backups", archive), target);
  {
    using restored = new DatabaseSync(join(target, DB_NAME), { readOnly: true });
    assert.deepEqual(restored.prepare(keys).get(), record);
  }
  const restored = kit.launch({ SPLITPAGE_DATA_DIR: target });
  const reset = await restored.owner(path + "/reset", { method: "POST" });
  const { token } = await reset.json() as { token: string };
  assert.equal((await restored.owner(path + "/password-exchange", passwordRequest("Keep across backup"), guest.token)).status, 403);
  await exchange(restored, scriptId, token, "Keep across backup");
});

test("v6 password credentials retain their access and inherit the link quota on upgrade", async t => {
  const kit = serverHarness(t);
  const first = kit.launch();
  const password = "Upgrade v6 fixture";
  const { scriptId, owner, guest } = await first.createScriptWithCredentials(randomUUID(), kit.seed(), undefined, password);
  assert.ok(owner && guest);
  const device = await exchange(first, scriptId, guest.token, password);
  await first.stop("clean");
  const path = join(kit.directory, DB_NAME);
  {
    using v6 = new DatabaseSync(path);
    v6.exec(`DROP INDEX script_device_credentials; ALTER TABLE invitations DROP COLUMN parent_link;
      DROP TABLE version_editors; PRAGMA user_version = 6`);
    const oldDevice = v6.prepare(`INSERT INTO invitations (id, script, label, token_hash, revoked, role, kind, revocation_reason)
      VALUES (?, ?, 'Old guest device', ?, 1, 'guest', 'device', 'access-removed')`);
    for (let count = 0; count < MAX_DEVICE_CREDENTIALS_PER_SCRIPT + 3; count++) {
      const id = randomUUID();
      oldDevice.run(id, scriptId, createHash("sha256").update(id).digest());
    }
    assert.equal(verifyDatabase(v6), 6);
  }
  const upgraded = kit.launch({ SPLITPAGE_MAX_CONNECTIONS_PER_GUEST_INVITATION: "1" });
  const port = await upgraded.port();
  using storage = new DatabaseSync(path, { readOnly: true });
  assert.equal(verifyDatabase(storage), 8);
  assert.equal(storage.prepare("SELECT parent_link FROM invitations WHERE kind = 'device' AND revoked = 0").get()?.parent_link, guest.id);
  assert.equal(storage.prepare("SELECT count(*) AS count FROM invitations WHERE kind = 'device'").get()?.count,
    MAX_DEVICE_CREDENTIALS_PER_SCRIPT);
  const peer = kit.copy(port, undefined, scriptId, device);
  await kit.until(() => peer.relay.status().firstSyncDone || undefined);
  const another = kit.copy(port, undefined, scriptId, await exchange(upgraded, scriptId, guest.token, password));
  await kit.until(() => another.events.some(event => event.kind === "temporary-refusal" && event.reason === "too-many-connections") || undefined);
});
