import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startRelay } from "../collab-server/relay.ts";

const limit = 16 * 1024 * 1024;
const png = Buffer.alloc(24);
Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex").copy(png);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "relay-pictures-"));
  try {
    const relay = await startRelay({
      SPLITPAGE_DATA_DIR: directory,
      SPLITPAGE_ALLOWED_ORIGINS: "http://localhost",
      SPLITPAGE_PORT: "0"
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
      first, second, put, get, url, pictures, relay,
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
  for (let i = 0; i < 100 && !await stat(join(f.pictures, "upload-0")).then(s => s.size === limit, () => false); i++) await delay(10);
  assert.equal((await stat(join(f.pictures, "upload-0"))).size, limit);
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

test("interrupted uploads release temporary storage and can be retried", async () => {
  await using f = await fixture();
  const partial = request(f.url(), {
    method: "PUT",
    headers: { authorization: "Bearer " + f.first.token, "content-type": "image/png", "content-length": png.length }
  });
  partial.on("error", () => {});
  partial.write(png.subarray(0, 12));
  try {
    for (let i = 0; i < 100 && !await stat(join(f.pictures, "upload-0")).then(s => s.size > 0, () => false); i++) await delay(10);
    assert.equal((await stat(join(f.pictures, "upload-0"))).size, 12);
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
  picture[24] = 12;
  assert.equal((await f.put(picture)).status, 413);
  assert.equal((await f.put(picture, hash(picture), f.second.token, "image/png", "second")).status, 201);
});
