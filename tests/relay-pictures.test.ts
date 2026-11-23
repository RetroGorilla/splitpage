import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { backupRelay } from "../collab-server/backup.ts";
import { fileURLToPath } from "node:url";
import { startRelay } from "../collab-server/relay.ts";
import { openWriter } from "../collab-server/storage.ts";
import { scriptAccess } from "../collab-server/access.ts";

const limit = 16 * 1024 * 1024;
const png = Buffer.alloc(24);
Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex").copy(png);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture(extraEnv: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relay-pictures-"));
  try {
    const relay = await startRelay({
      SPLITPAGE_DATA_DIR: directory,
      SPLITPAGE_ALLOWED_ORIGINS: "http://localhost",
      SPLITPAGE_PORT: "0",
      ...extraEnv
    }, "127.0.0.1");
    relay.registerScript("first", "active");
    relay.registerScript("second", "active");
    const first = relay.issueInvitation("first", "first");
    const second = relay.issueInvitation("second", "second");
    const base = "http://" + relay.URL;
    const pictures = join(directory, "pictures");
    const url = (script = "first", sha = hash(png)) => base + "/api/scripts/" + script + "/pictures/" + sha;
    const put = (bytes: Buffer, sha = hash(bytes), token = first.token, type = "image/png", script = "first") =>
      fetch(url(script, sha), { method: "PUT", headers: { authorization: "Bearer " + token, "content-type": type }, body: new Uint8Array(bytes) });
    const get = (script: string, token: string) => fetch(url(script), { headers: { authorization: "Bearer " + token } });
    return {
      first, second, put, get, url, pictures, relay, directory,
      async [Symbol.asyncDispose]() {
        await relay.destroy();
        await rm(directory, { recursive: true });
      }
    };
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
}

test("picture upload validates size, hash, type and dimensions before recording", async () => {
  await using f = await fixture();
  const oversized = request(f.url(), {
    method: "PUT",
    headers: { authorization: "Bearer " + f.first.token, "content-length": limit + 1 }
  });
  const rejected = once(oversized, "response");
  oversized.flushHeaders();
  const [refusal] = await rejected;
  assert.equal(refusal.statusCode, 413);
  refusal.resume();
  oversized.destroy();
  const stream = request(f.url(), {
    method: "PUT",
    headers: { authorization: "Bearer " + f.first.token, "content-type": "image/png" }
  });
  const received = once(stream, "response");
  stream.write(Buffer.alloc(limit));
  await waitForStagedBytes(f.pictures, 0, limit);
  stream.end(Buffer.alloc(1));
  const [response] = await received;
  assert.equal(response.statusCode, 413);
  response.resume();
  assert.equal((await f.put(png, "a".repeat(64))).status, 422);
  assert.equal((await f.put(png, hash(png), f.first.token, "image/gif")).status, 415);
  assert.equal((await f.put(Buffer.from("not a picture"))).status, 415);
  const invalid = Buffer.from(png);
  invalid.writeUInt32BE(0, 16);
  assert.equal((await f.put(invalid)).status, 415);
  assert.deepEqual(await readdir(f.pictures), []);
});

test("completed pictures are scoped to a script and an active invitation", async () => {
  await using f = await fixture();
  assert.equal((await f.put(png)).status, 201);
  assert.equal((await f.put(png)).status, 204);
  const downloaded = await f.get("first", f.first.token);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  assert.equal((await f.get("first", f.second.token)).status, 403);
  assert.equal((await f.get("second", f.second.token)).status, 404);
  f.relay.revokeInvitation(f.first.id);
  assert.equal((await f.get("first", f.first.token)).status, 403);
  assert.equal((await f.put(png)).status, 403);
});

async function waitForStagedBytes(directory: string, slot: number, bytes: number) {
  const path = join(directory, "upload-" + slot);
  for (let i = 0; i < 100 && !await stat(path).then(s => s.size === bytes, () => false); i++) await delay(10);
  assert.equal((await stat(path)).size, bytes);
}

test("interrupted uploads release temporary storage and can be retried", async () => {
  await using f = await fixture();
  const partial = request(f.url(), {
    method: "PUT",
    headers: { authorization: "Bearer " + f.first.token, "content-type": "image/png", "content-length": png.length }
  });
  partial.on("error", () => {});
  partial.write(png.subarray(0, 12));
  try {
    await waitForStagedBytes(f.pictures, 0, 12);
  } finally {
    partial.destroy();
  }
  for (let i = 0; i < 100 && (await readdir(f.pictures)).length; i++) await delay(10);
  assert.deepEqual(await readdir(f.pictures), []);
  assert.equal((await f.get("first", f.first.token)).status, 404);
  assert.equal((await f.put(png)).status, 201);
});

test("picture storage enforces the per-script quota", async () => {
  await using f = await fixture();
  const picture = Buffer.alloc(limit);
  png.copy(picture);
  for (let i = 0; i < 12; i++) {
    picture[24] = i;
    assert.equal((await f.put(picture)).status, 201);
  }
  const left = Buffer.from(picture.subarray(0, limit / 2));
  left[24] = 12;
  const right = Buffer.from(left);
  right[24] = 13;
  const statuses = (await Promise.all([f.put(left), f.put(right)])).map(response => response.status);
  assert.deepEqual(statuses.toSorted(), [201, 413]);
  assert.equal((await f.put(statuses[0] === 201 ? right : left)).status, 413);
  assert.equal((await f.put(left, hash(left), f.second.token, "image/png", "second")).status, 201);
});

test("a retry or a second script's upload restores a missing picture body", async () => {
  await using f = await fixture();
  const body = join(f.pictures, hash(png));
  assert.equal((await f.put(png)).status, 201);
  await rm(body);
  assert.equal((await f.put(png)).status, 204);
  let downloaded = await f.get("first", f.first.token);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  await rm(body);
  assert.equal((await f.put(png, hash(png), f.second.token, "image/png", "second")).status, 201);
  for (const [script, token] of [["first", f.first.token], ["second", f.second.token]] as const) {
    downloaded = await f.get(script, token);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  }
});

for (const addingScript of [false, true]) {
  test(addingScript ? "repair sync precedes a second script association" : "repair sync precedes acknowledgment of a retry", async t => {
    await using f = await fixture();
    const sha = hash(png);
    const body = join(f.pictures, sha);
    assert.equal((await f.put(png)).status, 201);
    await rm(body);

    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    const openSync = fs.openSync;
    const fsyncSync = fs.fsyncSync;
    let directoryFd: number | undefined;
    let syncs = 0;
    const open = t.mock.method(fs, "openSync", (path: fs.PathLike, flags: fs.OpenMode = "r", mode?: fs.Mode) => {
      if (path !== f.pictures) return openSync(path, flags, mode);
      // why: Windows cannot open a directory descriptor, so use the repaired body to exercise ordering there.
      directoryFd = platform.value === "win32" ? openSync(body, "r+") : openSync(path, flags, mode);
      return directoryFd;
    });
    const sync = t.mock.method(fs, "fsyncSync", (fd: number) => {
      assert.equal(fd, directoryFd);
      syncs += 1;
      if (syncs <= 2) throw Object.assign(new Error(), { code: "EIO" });
      fsyncSync(fd);
    });
    if (platform.value === "win32") Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    syncBuiltinESMExports();
    try {
      const [script, token] = addingScript ? ["second", f.second.token] : ["first", f.first.token];
      const put = () => f.put(png, sha, token, "image/png", script);
      assert.equal((await put()).status, 500);
      assert.deepEqual(await readFile(body), png);
      assert.equal(syncs, 1);

      assert.equal((await put()).status, 500);
      assert.equal(syncs, 2);
      if (addingScript) assert.equal((await f.get(script, token)).status, 404);

      assert.equal((await put()).status, addingScript ? 201 : 204);
      assert.equal(syncs, 3);
      const downloaded = await f.get(script, token);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    } finally {
      open.mock.restore();
      sync.mock.restore();
      Object.defineProperty(process, "platform", platform);
      syncBuiltinESMExports();
    }
  });
}

test("a database-only backup with picture associations leaves prior backups in place", async () => {
  await using f = await fixture();
  const env = { SPLITPAGE_DATA_DIR: f.directory, SPLITPAGE_BACKUP_KEEP: "1" };
  const previous = await backupRelay(env);
  const backups = join(f.directory, "backups");
  const previousBytes = await readFile(join(backups, previous));
  assert.equal((await f.put(png)).status, 201);
  await assert.rejects(backupRelay(env), {
    message: "Relay backup requires picture files. Keep existing backups and wait for picture backup support."
  });
  assert.deepEqual(await readdir(backups), [previous]);
  assert.deepEqual(await readFile(join(backups, previous)), previousBytes);
});

function partialUpload(url: string, token: string) {
  const partial = request(url, {
    method: "PUT",
    headers: { authorization: "Bearer " + token, "content-type": "image/png", "content-length": png.length }
  });
  partial.write(png.subarray(0, 12));
  return partial;
}

test("an inactive staging slot is reclaimed after a transient cleanup failure", async (t) => {
  await using f = await fixture();
  const active = partialUpload(f.url(), f.first.token);
  const response = once(active, "response");
  const dirty = join(f.pictures, "upload-1");
  const original = fs.rmSync;
  let cleanupFailed!: () => void;
  const failed = new Promise<void>(resolve => { cleanupFailed = resolve; });
  let blocked = true;
  const cleanup = t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
    if (path === dirty && blocked) {
      cleanupFailed();
      throw Object.assign(new Error(), { code: "EBUSY" });
    }
    original(path, options);
  });
  syncBuiltinESMExports();
  try {
    await waitForStagedBytes(f.pictures, 0, 12);
    assert.equal((await f.put(png, "a".repeat(64))).status, 422);
    await failed;
    assert.deepEqual(await readFile(dirty), png);
    assert.equal((await f.put(png, "b".repeat(64))).status, 422);
    assert.deepEqual(await readFile(dirty), png);
    blocked = false;
    assert.equal((await f.put(png)).status, 201);
    assert.equal((await stat(join(f.pictures, "upload-0"))).size, 12);
    await assert.rejects(stat(dirty), { code: "ENOENT" });
    active.end(png.subarray(12));
    const [result] = await response;
    assert.equal(result.statusCode, 204);
    result.resume();
  } finally {
    cleanup.mock.restore();
    syncBuiltinESMExports();
    active.destroy();
  }
});

test("a slot awaiting cleanup stays counted in upload limits and status until cleanup succeeds", async (t) => {
  const secret = randomBytes(32).toString("base64url");
  await using f = await fixture({
    SPLITPAGE_MANAGEMENT_SECRET: secret,
    SPLITPAGE_MAX_UPLOADS_IN_FLIGHT: "2"
  });
  const statusUrl = "http://" + f.relay.URL + "/api/status";
  async function readStatus() {
    const response = await fetch(statusUrl, { headers: { authorization: "Bearer " + secret } });
    assert.equal(response.status, 200);
    return await response.json() as { uploadsInFlight: number; pictureBytes: number };
  }
  const active = partialUpload(f.url(), f.first.token);
  const response = once(active, "response");
  const dirty = join(f.pictures, "upload-1");
  const original = fs.rmSync;
  let cleanupFailed!: () => void;
  const failed = new Promise<void>(resolve => { cleanupFailed = resolve; });
  let blocked = true;
  const cleanup = t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
    if (path === dirty && blocked) {
      cleanupFailed();
      throw Object.assign(new Error(), { code: "EBUSY" });
    }
    original(path, options);
  });
  syncBuiltinESMExports();
  try {
    await waitForStagedBytes(f.pictures, 0, 12);
    assert.equal((await f.put(png, "a".repeat(64))).status, 422);
    await failed;
    assert.equal((await readStatus()).uploadsInFlight, 2);

    const refused = await f.put(png, "b".repeat(64));
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "5");
    assert.equal(refused.headers.get("cache-control"), "no-store");

    blocked = false;
    assert.equal((await f.put(png)).status, 201);
    const afterCommit = await readStatus();
    assert.equal(afterCommit.uploadsInFlight, 1);
    assert.equal(afterCommit.pictureBytes, png.length);

    active.end(png.subarray(12));
    const [result] = await response;
    assert.equal(result.statusCode, 204);
    result.resume();
    assert.equal((await readStatus()).uploadsInFlight, 0);
  } finally {
    cleanup.mock.restore();
    syncBuiltinESMExports();
    active.destroy();
  }
});

function seedInvitation(directory: string, script: string) {
  using db = openWriter(directory);
  const access = scriptAccess(db);
  access.register(script, "active");
  return access.issue(script, "test invitation");
}

test("the relay refuses an upload revoked in flight and keeps private HTTP values out of logs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-picture-logs-"));
  const script = "private-picture-script";
  const { id, token } = seedInvitation(directory, script);
  const entry = new URL("./adapters/collab/native/server-process.ts", import.meta.url);
  const child = fork(fileURLToPath(entry), {
    env: { SPLITPAGE_DATA_DIR: directory, SPLITPAGE_ALLOWED_ORIGINS: "http://localhost", SPLITPAGE_PORT: "0" },
    execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const signal = AbortSignal.timeout(10_000);
  const stopped = once(child, "close");
  t.after(async () => {
    child.kill();
    await stopped;
    await rm(directory, { recursive: true });
  });
  let logs = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { logs += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { logs += chunk; });
  const [port] = await once(child, "message", { signal });
  assert.equal(typeof port, "number");
  const bytes = Buffer.concat([png, Buffer.from("private-picture-body")]);
  const sha = hash(bytes);
  const url = "http://127.0.0.1:" + port + "/api/scripts/" + script + "/pictures/" + sha;
  const upload = request(url, {
    method: "PUT",
    headers: { authorization: "Bearer " + token, "content-type": "image/png", "content-length": bytes.length }
  });
  const response = once(upload, "response");
  try {
    upload.write(bytes.subarray(0, 12));
    await waitForStagedBytes(join(directory, "pictures"), 0, 12);
    const revoked = once(child, "message", { signal });
    child.send("revoke:" + id);
    const [revocation] = await revoked;
    assert.equal(revocation, "revoked");
    upload.end(bytes.subarray(12));
    const [rejected] = await response;
    assert.equal(rejected.statusCode, 403);
    rejected.resume();
    const refused = await fetch(url, { headers: { authorization: "Bearer " + token } });
    assert.equal(refused.status, 403);
    child.send("stop");
    assert.deepEqual(await stopped, [0, null]);
    assert.deepEqual(await readdir(join(directory, "pictures")), []);
    for (const value of [script, token, sha, "private-picture-body"]) {
      assert.equal(logs.includes(value), false);
    }
  } finally {
    upload.destroy();
  }
});
