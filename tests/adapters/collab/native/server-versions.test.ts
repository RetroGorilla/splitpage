import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, get } from "node:http";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { backupRelay, restoreRelay, verifyCopy } from "../../../../collab-server/backup.ts";
import { relayConfig } from "../../../../collab-server/config.ts";
import { RETRY_AFTER_SECONDS } from "../../../../collab-server/limits.ts";
import type { RelayStatusSnapshot } from "../../../../collab-server/status.ts";
import { DB_NAME, VERSION_CHUNK_BYTES } from "../../../../collab-server/storage.ts";
import { versionRequests } from "../../../../collab-server/version-http.ts";
import { versionStorage } from "../../../../collab-server/version-storage.ts";
import { appendText, NAME, ORIGIN, serverHarness, storedState, storedText } from "./server-harness.ts";

type RelayRun = ReturnType<ReturnType<typeof serverHarness>["launch"]>;
type HistoryEntry = ReturnType<ReturnType<typeof versionStorage>["list"]>[number];
const HISTORY = `scripts/${NAME}/versions`;

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for relay history");
}

async function history(run: RelayRun, token: string, path = HISTORY): Promise<HistoryEntry[]> {
  const response = await run.owner(path, {}, token);
  assert.equal(response.status, 200);
  return await response.json() as HistoryEntry[];
}

async function status(run: RelayRun, secret?: string): Promise<RelayStatusSnapshot> {
  const response = await run.owner("status", {}, secret);
  assert.equal(response.status, 200);
  return await response.json() as RelayStatusSnapshot;
}

async function snapshot(run: RelayRun, path: string, token: string): Promise<Uint8Array> {
  const response = await run.owner(path, {}, token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return new Uint8Array(await response.arrayBuffer());
}

function expandedState(state: Uint8Array, bytes: number, key = "payload"): Uint8Array {
  const doc = new Doc();
  try {
    applyUpdate(doc, state);
    doc.getMap("fixture").set(key, new Uint8Array(randomBytes(bytes)));
    return encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

for (const disposition of ["abandon", "delete"] as const) {
  test(`${disposition} retires the published creation snapshot and reclaims its chunks`, async t => {
    const kit = serverHarness(t);
    const state = kit.seed();
    const run = kit.launch();
    const creationId = randomUUID();
    const { scriptId } = await run.createScriptWithCredentials(creationId, state);
    await until(async () => (await status(run)).versionBytes > 0 || undefined);
    using db = new DatabaseSync(join(kit.directory, DB_NAME), { readOnly: true });
    const chunks = db.prepare("SELECT count(*) AS count FROM version_chunks");
    assert.ok(Number(chunks.get()?.count) > 0);
    const route = disposition === "abandon" ? `creations/${creationId}` : `scripts/${scriptId}`;
    assert.equal((await run.owner(route, { method: "DELETE" })).status, 204);
    assert.equal((await status(run)).versionBytes, 0);
    const metadata = db.prepare("SELECT count(*) AS count FROM versions WHERE script = ?");
    await until(async () => metadata.get(scriptId)?.count === 0 || undefined);
    assert.equal(chunks.get()?.count, 0);
  });
}

test("snapshot reads cap output and hold a slot until delivery or disconnect, and shutdown reports temporary refusal", async t => {
  const documentBytes = 15_000_000;
  const version = (state: Buffer) => ({
    compressed: zstdCompressSync(state), hash: createHash("sha256").update(state).digest()
  });
  const small = version(Buffer.of(1, 2));
  const full = version(Buffer.alloc(documentBytes));
  const oversized = version(Buffer.alloc(documentBytes + 1));
  let stopping = false;
  let authentications = 0;
  const handle = versionRequests({
    list: () => [],
    read: (_script, id) => id === "full" ? full : id === "oversized" ? oversized : small
  }, {
    authenticate: () => {
      authentications += 1;
      return { id: "fixture", role: "guest" };
    }
  }, new Set([ORIGIN]), { documentBytes, readLimit: 1, stopping: () => stopping });
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/full")) {
      t.mock.method(res, "end", () => {
        res.flushHeaders();
        return res;
      });
    }
    void handle(req, res);
  });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/${HISTORY}`;
  assert.equal((await fetch(url + "/oversized")).status, 500);
  const fullResponse = await new Promise<IncomingMessage>((resolve, reject) =>
    get(url + "/full", resolve).once("error", reject));
  assert.equal(fullResponse.statusCode, 200);
  assert.equal(fullResponse.headers["content-length"], String(documentBytes));
  const saturated = await fetch(url + "/small");
  assert.equal(saturated.status, 503);
  assert.equal(saturated.headers.get("Retry-After"), RETRY_AFTER_SECONDS);
  assert.equal((await fetch(url)).status, 200);
  fullResponse.destroy();
  const recovered = await until(async () => {
    const response = await fetch(url + "/small");
    if (response.status === 200) return response;
  });
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), Uint8Array.of(1, 2));
  const before = authentications;
  stopping = true;
  for (const path of [url, url + "/small"]) {
    const refused = await fetch(path, { headers: { Origin: ORIGIN } });
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("Retry-After"), RETRY_AFTER_SECONDS);
    assert.equal(refused.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  }
  assert.equal(authentications, before);
});

test("the first edit captures immediately and a final edit captures after the interval without more traffic", async t => {
  const kit = serverHarness(t);
  kit.seed();
  assert.equal(relayConfig({ SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_ALLOWED_ORIGINS: ORIGIN }).versions.interval, 300_000);
  const interval = 1800;
  const run = kit.launch({ SPLITPAGE_VERSION_INTERVAL_MS: String(interval) });
  const token = kit.invitation().token;
  const copy = kit.copy(await run.port());
  await kit.until(() => copy.text() === "word" || undefined);
  assert.deepEqual(await history(run, token), []);
  const start = Date.now();
  appendText(copy.session, " one", 4);
  const first = await until(async () => (await history(run, token))[0]);
  assert.ok(first.createdAt - start < interval);
  const firstState = storedState(kit.directory);
  assert.deepEqual(await snapshot(run, `${HISTORY}/${first.id}`, token), firstState);
  assert.equal((await status(run)).versionBytes, first.bytes);

  appendText(copy.session, " two", 8);
  await kit.until(() => run.messages.filter(message => message === `stored:${NAME}`).length >= 2 || undefined);
  assert.equal(storedText(kit.directory), "word one two");
  assert.deepEqual(await history(run, token), [first]);
  const entries = await until(async () => {
    const current = await history(run, token);
    if (current.length === 2) return current;
  });
  const second = entries[0];
  assert.ok(second);
  assert.ok(second.createdAt - first.createdAt >= interval);
  assert.deepEqual(entries[1], first);
  assert.deepEqual(first.names, []);
  assert.deepEqual(second.names, []);
  assert.deepEqual(await snapshot(run, `${HISTORY}/${second.id}`, token), storedState(kit.directory));
  assert.equal((await status(run)).versionBytes, first.bytes + second.bytes);
  await delay(interval + 50);
  assert.deepEqual(await history(run, token), entries);
});

test("version reads use invitation roles, clear untouched, and scope CORS to version routes", async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const run = kit.launch();
  const create = async () => {
    const made = await run.createScriptWithCredentials(randomUUID(), state);
    assert.ok(made.owner && made.guest);
    const path = `scripts/${made.scriptId}/versions`;
    return { path, scriptId: made.scriptId, owner: made.owner, guest: made.guest };
  };
  const script = await create();
  using db = new DatabaseSync(join(kit.directory, DB_NAME), { readOnly: true });
  const untouched = db.prepare("SELECT untouched FROM scripts WHERE name = ?");
  const published = db.prepare("SELECT id FROM versions WHERE script = ? AND status = 'published'");
  const id = await until(async () => published.get(script.scriptId)?.id as string | undefined);
  assert.equal(untouched.get(script.scriptId)?.untouched, 1);
  const second = await create();
  const secondId = await until(async () => published.get(second.scriptId)?.id as string | undefined);
  assert.equal(untouched.get(second.scriptId)?.untouched, 1);

  const readPath = `${script.path}/${id}`;
  assert.equal((await history(run, second.guest.token, second.path))[0]?.id, secondId);
  assert.equal(untouched.get(second.scriptId)?.untouched, 0);
  const readAllowed = await run.owner(readPath, { headers: { Origin: ORIGIN } }, script.owner.token);
  assert.equal(readAllowed.status, 200);
  assert.equal(readAllowed.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.deepEqual(new Uint8Array(await readAllowed.arrayBuffer()), state);
  assert.equal(untouched.get(script.scriptId)?.untouched, 0);
  const ownerList = await history(run, script.owner.token, script.path);
  assert.deepEqual(ownerList, await history(run, script.guest.token, script.path));
  const storedBytes = db.prepare("SELECT sum(length(payload)) AS bytes FROM version_chunks WHERE version_id = ?").get(id)?.bytes;
  assert.deepEqual(ownerList.map(({ id, bytes, names }) => ({ id, bytes, names })), [
    { id, bytes: storedBytes, names: [] }
  ]);
  assert.deepEqual(await snapshot(run, readPath, script.guest.token), state);

  for (const path of [script.path, readPath]) {
    const allowed = await run.owner(path, { headers: { Origin: ORIGIN } }, script.guest.token);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("Vary"), "Origin");
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    await allowed.arrayBuffer();
    const blocked = await run.owner(path, { headers: { Origin: "https://outside.invalid" } }, script.guest.token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
    const preflight = (origin: string, method = "GET") => run.owner(path, {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization" }
    }, null);
    const options = await preflight(ORIGIN);
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(options.headers.get("Access-Control-Allow-Methods"), "GET");
    assert.equal(options.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type");
    assert.equal((await preflight("https://outside.invalid")).status, 403);
    assert.equal((await preflight(ORIGIN, "PUT")).status, 403);
    assert.equal((await run.owner(path, {}, null)).status, 403);
    assert.equal((await run.owner(path, {}, second.owner.token)).status, 403);
  }
  assert.equal((await run.owner(`${script.path}/${secondId}`, {}, script.owner.token)).status, 404);
  assert.equal((await run.owner(`scripts/${script.scriptId}/invitations`, { headers: { Origin: ORIGIN } }))
    .headers.get("Access-Control-Allow-Origin"), null);
  run.send(`revoke:${script.guest.id}`);
  await kit.until(() => run.messages.includes("revoked") || undefined);
  for (const path of [script.path, readPath]) assert.equal((await run.owner(path, {}, script.guest.token)).status, 403);
  assert.equal((await run.owner(`scripts/${script.scriptId}`, { method: "DELETE" })).status, 204);
  for (const path of [script.path, readPath]) assert.equal((await run.owner(path, {}, script.owner.token)).status, 403);
});

test("rechecking an identical live state after restart creates no duplicate", async t => {
  const kit = serverHarness(t);
  const settings = { SPLITPAGE_VERSION_INTERVAL_MS: "100" };
  kit.seed();
  const run = kit.launch(settings);
  const { token } = kit.invitation();
  const copy = kit.copy(await run.port());
  await kit.until(() => copy.text() === "word" || undefined);
  appendText(copy.session, " one", 4);
  const first = await until(async () => (await history(run, token))[0]);
  copy.close();
  await run.stop("clean");
  using db = new DatabaseSync(join(kit.directory, DB_NAME));
  db.exec("UPDATE documents SET version_generation = version_generation + 1");
  const restarted = kit.launch(settings);
  await restarted.port();
  await delay(300);
  assert.deepEqual(await history(restarted, token), [first]);
  assert.equal((await status(restarted)).versionBytes, first.bytes);
});

test("a partial history write stays hidden, leaves live state intact after a crash and retries at the interval", async t => {
  const kit = serverHarness(t);
  const seed = kit.seed();
  const privateContent = "private-script-sentinel";
  const settings = {
    SPLITPAGE_VERSION_INTERVAL_MS: "850", SPLITPAGE_MANAGEMENT_SECRET: randomBytes(32).toString("base64url")
  };
  const secret = settings.SPLITPAGE_MANAGEMENT_SECRET;
  const run = kit.launch(settings);
  const { token } = kit.invitation();
  const port = await run.port();
  const copy = kit.copy(port);
  await kit.until(() => copy.text() === "word" || undefined);
  appendText(copy.session, privateContent, 4);
  const first = await until(async () => (await history(run, token))[0]);
  using db = new DatabaseSync(join(kit.directory, DB_NAME), { timeout: 5000 });
  db.exec(`CREATE TRIGGER failing_chunk BEFORE INSERT ON version_chunks WHEN NEW.part = 1
    BEGIN SELECT RAISE(ABORT, '${privateContent}'); END`);
  const returning = kit.copy(port, { kind: "state", state: expandedState(seed, VERSION_CHUNK_BYTES + 80_000) });
  await kit.until(() => returning.text() === "word" + privateContent || undefined);
  const failure = await until(async () => (await status(run, secret)).lastVersionFailure ?? undefined);
  assert.equal(failure.reason, "version-store-failed");
  assert.match(failure.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await history(run, token), [first]);
  const before = await (await run.owner("status", {}, secret)).text();
  for (const detail of [privateContent, token, secret, kit.directory, NAME]) {
    assert.equal(before.includes(detail), false);
    assert.equal((run.output() + run.errors()).includes(detail), false);
  }
  const saved = storedState(kit.directory);
  assert.ok(saved.length > VERSION_CHUNK_BYTES);
  await run.stop("kill");
  copy.close();
  returning.close();
  const restarted = kit.launch(settings);
  await restarted.port();
  assert.deepEqual(storedState(kit.directory), saved);
  const afterRestart = await until(async () => (await status(restarted, secret)).lastVersionFailure ?? undefined);
  db.exec("DROP TRIGGER failing_chunk");
  assert.deepEqual(await history(restarted, token), [first]);
  const latest = await until(async () => (await history(restarted, token)).find(entry => entry.id !== first.id));
  assert.ok(latest.createdAt - Date.parse(afterRestart.at) >= 850);
  assert.deepEqual(await snapshot(restarted, `${HISTORY}/${latest.id}`, token), saved);
  assert.equal((await status(restarted, secret)).versionBytes, first.bytes + latest.bytes);
  assert.equal(db.prepare("SELECT count(*) AS count FROM version_chunks WHERE version_id = ?").get(latest.id)?.count, 2);
  assert.equal(db.prepare("SELECT max(length(payload)) AS bytes FROM version_chunks").get()?.bytes, VERSION_CHUNK_BYTES);
  const unpublished = db.prepare("SELECT count(*) AS count FROM versions WHERE status <> 'published'");
  await until(async () => unpublished.get()?.count === 0 || undefined);
  assert.equal(db.prepare("SELECT count(*) AS count FROM version_chunks").get()?.count, 3);
  assert.equal(db.prepare(`SELECT count(*) AS count FROM version_chunks
    LEFT JOIN versions ON id = version_id WHERE status IS NOT 'published'`).get()?.count, 0);
});

test("shutdown commits the final live edit and leaves its capture for restart", async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch();
  const { token } = kit.invitation();
  const copy = kit.copy(await run.port());
  await kit.until(() => copy.text() === "word" || undefined);
  run.send("hold");
  await kit.until(() => run.messages.includes("armed") || undefined);
  appendText(copy.session, " final", 4);
  await kit.until(() => run.messages.includes("store-started") || undefined);
  run.requestStop();
  await kit.until(() => run.messages.includes("stopping") || undefined);
  run.send("release");
  assert.deepEqual(await run.exit, { code: 0, exitSignal: null });
  copy.close();
  using db = new DatabaseSync(join(kit.directory, DB_NAME), { readOnly: true });
  assert.equal(versionStorage(db).total(), 0);
  assert.equal(storedText(kit.directory), "word final");
  const restarted = kit.launch();
  const version = await until(async () => (await history(restarted, token))[0]);
  assert.deepEqual(await snapshot(restarted, `${HISTORY}/${version.id}`, token), storedState(kit.directory));
});

test("the scheduled sweep keeps the newest in each UTC bucket and the latest even when expired", async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const compressed = zstdCompressSync(state);
  const hash = createHash("sha256").update(state).digest();
  const cutoff = new Date();
  cutoff.setUTCMinutes(0, 0, 0);
  const hour = 3_600_000;
  const day = 24 * hour;
  const now = cutoff.getTime();
  const week = Math.floor((now - 45 * day + 3 * day) / (7 * day)) * 7 * day - 3 * day;
  assert.equal(new Date(week).getUTCDay(), 1);
  const dayBucket = Math.floor((now - 14 * day) / day) * day;
  const oldScript = "only-expired-versions";
  kit.provision(NAME);
  kit.provision(oldScript);
  const fixtures: [string, number, boolean, string?][] = [
    ["fresh-new", now - hour + 2000, true],
    ["fresh-old", now - hour + 1000, true],
    ["hour-new", now - 2 * day + 2000, true],
    ["hour-old", now - 2 * day + 1000, false],
    ["hour-prior", now - 2 * day - 1000, true],
    ["day-new", dayBucket + 2 * hour, true],
    ["day-old", dayBucket + hour, false],
    ["day-prior", dayBucket - 1000, true],
    ["week-new", week + 2 * day, true],
    ["week-old", week + day, false],
    ["week-prior", week - 1000, true],
    ["expired", now - 100 * day, false],
    ["lonely-new", now - 100 * day, true, oldScript],
    ["lonely-old", now - 101 * day, false, oldScript]
  ];
  using db = new DatabaseSync(join(kit.directory, DB_NAME));
  const storage = versionStorage(db);
  for (const [id, time, , script = NAME] of fixtures) {
    storage.stage(id, script, 1, time, compressed.length, hash);
    storage.append(id, 0, compressed);
  }
  db.exec("UPDATE versions SET status = 'published'");
  assert.equal(storage.total(), fixtures.length * compressed.length);
  const run = kit.launch({ SPLITPAGE_VERSION_THIN_INTERVAL_MS: "50" });
  const expected = fixtures.filter(([, , keep]) => keep).length * compressed.length;
  await until(async () => (await status(run)).versionBytes === expected || undefined);
  assert.deepEqual((await history(run, kit.invitation().token)).map(({ id }) => id),
    fixtures.filter(([, , keep, script]) => keep && !script).map(([id]) => id));
  assert.deepEqual((await history(run, kit.invitation(oldScript).token, `scripts/${oldScript}/versions`)).map(({ id }) => id),
    ["lonely-new"]);
  await until(async () => db.prepare("SELECT count(*) AS count FROM version_chunks").get()?.count === expected / compressed.length || undefined);
  assert.deepEqual(storedState(kit.directory), state);
});

test("publishing evicts oldest versions to fit a per-script budget and an oversized capture preserves history", async t => {
  const kit = serverHarness(t);
  const seed = kit.seed();
  const initial = expandedState(seed, 4000);
  const budget = zstdCompressSync(initial).length * 2 + 180;
  const run = kit.launch({
    SPLITPAGE_VERSION_INTERVAL_MS: "100", SPLITPAGE_VERSION_BUDGET_BYTES: String(budget)
  });
  const created = await run.createScriptWithCredentials(randomUUID(), initial);
  assert.ok(created.guest);
  const { token } = created.guest;
  const path = `scripts/${created.scriptId}/versions`;
  const first = await until(async () => (await history(run, token, path))[0]);
  const copy = kit.copy(await run.port(), { kind: "empty" }, created.scriptId, token);
  await kit.until(() => copy.text() === "word" || undefined);
  appendText(copy.session, " one", 4);
  const second = await until(async () => (await history(run, token, path)).find(entry => entry.id !== first.id));
  assert.deepEqual(await history(run, token, path), [second, first]);
  appendText(copy.session, " two", 8);
  const third = await until(async () => (await history(run, token, path)).find(entry => entry.id !== first.id && entry.id !== second.id));
  assert.deepEqual(await history(run, token, path), [third, second]);
  assert.equal((await run.owner(`${path}/${first.id}`, {}, token)).status, 404);
  assert.equal((await status(run)).versionBytes, third.bytes + second.bytes);
  assert.ok(third.bytes + second.bytes <= budget);

  const oversize = kit.copy(await run.port(), { kind: "state", state: expandedState(seed, budget * 2, "oversized") },
    created.scriptId, token);
  await kit.until(() => oversize.text() === "word one two" || undefined);
  const failure = await until(async () => (await status(run)).lastVersionFailure ?? undefined);
  assert.equal(failure.reason, "snapshot-over-budget");
  assert.deepEqual(await history(run, token, path), [third, second]);
  assert.equal((await status(run)).versionBytes, third.bytes + second.bytes);
  assert.ok(storedState(kit.directory, created.scriptId).length > budget);
  await delay(350);
  assert.deepEqual((await status(run)).lastVersionFailure, failure);
  appendText(oversize.session, " three", 12);
  const changedFailure = await until(async () => {
    const next = (await status(run)).lastVersionFailure;
    if (next && next.at !== failure.at) return next;
  });
  assert.equal(changedFailure.reason, "snapshot-over-budget");
  assert.deepEqual(await history(run, token, path), [third, second]);
});

test("retention includes the exact 6-hour, 7-day, 30-day and 90-day boundaries", t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const hour = 3_600_000;
  const day = 24 * hour;
  const now = Date.UTC(2026, 10, 26, 12, 30);
  const compressed = zstdCompressSync(state);
  const hash = createHash("sha256").update(state).digest();
  const cases = [
    { script: "six-hours", cutoff: 6 * hour, older: -2, newer: 1, keep: ["latest", "newer", "edge", "outside"] },
    { script: "seven-days", cutoff: 7 * day, older: -hour, newer: 1, keep: ["latest", "newer", "outside"] },
    { script: "thirty-days", cutoff: 30 * day, older: -day, newer: 1, keep: ["latest", "newer", "outside"] },
    { script: "ninety-days", cutoff: 90 * day, older: -2, newer: 7 * day, keep: ["latest", "newer", "edge"] }
  ];
  for (const { script } of cases) kit.provision(script);
  using db = new DatabaseSync(join(kit.directory, DB_NAME));
  const storage = versionStorage(db);
  for (const { script, cutoff, older, newer, keep } of cases) {
    const at = now - cutoff;
    for (const [name, time] of [["latest", now], ["newer", at + newer], ["edge", at], ["outside", at - 1], ["older", at + older]] as const) {
      const id = `${script}/${name}`;
      storage.stage(id, script, 1, time, compressed.length, hash);
      storage.append(id, 0, compressed);
      db.prepare("UPDATE versions SET status = 'published' WHERE id = ?").run(id);
    }
    storage.thin(script, now, 64 * 1024 * 1024);
    assert.deepEqual(storage.list(script).map(({ id }) => id.slice(script.length + 1)), keep);
  }
});

test("backup pauses capture, verifies both version tables, and restore preserves versions with invitations revoked", async t => {
  const kit = serverHarness(t);
  kit.seed();
  const run = kit.launch({ SPLITPAGE_VERSION_INTERVAL_MS: "100" });
  const { token } = kit.invitation();
  const copy = kit.copy(await run.port());
  await kit.until(() => copy.text() === "word" || undefined);
  appendText(copy.session, " one", 4);
  const original = await until(async () => (await history(run, token))[0]);
  const saved = storedState(kit.directory);
  const env = { SPLITPAGE_DATA_DIR: kit.directory };
  const archive = await backupRelay(env, async (source, pending) => {
    appendText(copy.session, " two", 8);
    await kit.until(() => run.messages.filter(message => message === `stored:${NAME}`).length >= 2 || undefined);
    await delay(300);
    assert.deepEqual(await history(run, token), [original]);
    assert.equal(storedText(kit.directory), "word one two");
    return backup(source, pending);
  });
  await until(async () => (await history(run, token)).length === 2 || undefined);
  const backupPath = join(kit.directory, "backups", archive);
  using source = new DatabaseSync(join(backupPath, DB_NAME), { readOnly: true });
  const copyPath = join(kit.directory, "copy.sqlite");
  await backup(source, copyPath);
  using changed = new DatabaseSync(copyPath);
  verifyCopy(source, changed);
  changed.exec("UPDATE versions SET names = '[\"other\"]'");
  assert.throws(() => verifyCopy(source, changed), /versions differ/);
  changed.exec("UPDATE versions SET names = '[]'; DELETE FROM version_chunks");
  assert.throws(() => verifyCopy(source, changed), /missing version chunks/);
  assert.throws(() => verifyCopy(changed, changed), /incomplete published version/);

  const target = join(kit.directory, "restored");
  await restoreRelay(backupPath, target);
  using restoredDb = new DatabaseSync(join(target, DB_NAME), { readOnly: true });
  assert.equal(restoredDb.prepare("SELECT count(*) AS count FROM invitations WHERE revoked = 0").get()?.count, 0);
  const restored = kit.launch({ SPLITPAGE_DATA_DIR: target });
  assert.equal((await restored.owner(HISTORY, {}, token)).status, 403);
  const issued = await restored.owner(`scripts/${NAME}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Restored", role: "guest" })
  });
  assert.equal(issued.status, 201);
  const fresh = (await issued.json() as { token: string }).token;
  assert.deepEqual(await history(restored, fresh), [original]);
  assert.deepEqual(await snapshot(restored, `${HISTORY}/${original.id}`, fresh), saved);
  assert.equal((await status(restored)).versionBytes, original.bytes);
});
